import { execFileSync } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openLedgerDatabase, type LedgerDatabase } from '../../src/ledger/database.js';
import { LedgerRepository } from '../../src/ledger/repositories.js';
import type { SpoolConfig } from '../../src/config/schema.js';
import { OutboxRepository } from '../../src/ledger/outbox.js';
import { FakeProvider } from '../../src/providers/fake.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import type { ProviderAdapter, ProviderEvidence } from '../../src/providers/types.js';
import { Reconciler } from '../../src/scheduler/reconciler.js';
import { WorkspacePool } from '../../src/workspaces/pool.js';
import {
  WorkspaceSentinelManager,
  type ProcessIdentityProvider,
} from '../../src/workspaces/lease.js';

const databases: LedgerDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('durable provider evidence', () => {
  it('deduplicates event keys and preserves process, output, and workspace metadata', () => {
    const state = mkdtempSync(path.join(tmpdir(), 'spool-events-'));
    const database = openLedgerDatabase(state);
    databases.push(database);
    const ledger = new LedgerRepository(database);
    const job = ledger.claimJob({
      sourceMarker: 'task-1',
      sourcePath: '/vault/Week 29 of 2026.md',
      provider: 'fake',
      directive: 'Review',
      context: 'Repository (direct): example/widget',
      repository: 'example/widget',
    });
    const attempt = ledger.prepareAttempt(job.id, path.join(state, 'logs', 'attempt.log'));
    ledger.recordAttemptProcess(attempt.id, { pid: 123, processStartIdentity: 'birth-123' });
    ledger.recordAttemptLaunchMetadata(attempt.id, { workspace: '/repo/a', version: 1 });
    const evidence: ProviderEvidence = {
      kind: 'output',
      eventKey: 'output-1',
      text: 'Finished reviewing.',
    };

    expect(ledger.recordProviderEvidence(attempt.id, evidence)).toBe(true);
    expect(ledger.recordProviderEvidence(attempt.id, evidence)).toBe(false);
    expect(ledger.getAttempt(attempt.id)).toMatchObject({
      processId: 123,
      processStartIdentity: 'birth-123',
      latestOutput: 'Finished reviewing.',
      launchMetadata: { workspace: '/repo/a', version: 1 },
      observationCursor: 'output-1',
    });
    expect(ledger.listProviderEvidence(attempt.id)).toEqual([evidence]);
  });
});

describe('reconciler restart boundaries', () => {
  it('repairs a claimed queued job whose initial receipt commit was interrupted', async () => {
    const fixture = restartFixture('fake');
    const database = openLedgerDatabase(fixture.state);
    databases.push(database);
    const ledger = new LedgerRepository(database);
    const outbox = new OutboxRepository(database);
    const job = ledger.claimJob({
      sourceMarker: 'background-handoff',
      sourcePath: fixture.note,
      provider: 'fake',
      directive: 'Review',
      context: 'Repository (direct): example/widget',
      repository: 'example/widget',
    });
    expect(ledger.getProjection(`initial-receipt:${job.id}`)).toBeNull();
    const reconciler = new Reconciler({
      config: fixture.config,
      database,
      ledger,
      outbox,
      providers: new ProviderRegistry([namedFakeProvider('fake')]),
    });

    await reconciler.runPass({ awaitLaunched: true });

    expect(ledger.getProjection(`initial-receipt:${job.id}`)?.state).toBe('Applied');
    expect(ledger.listAttempts(job.id)).toHaveLength(1);
    expect(ledger.getJob(job.id)?.state).toBe('Completed');
    await reconciler.shutdown();
  });

  it('marks a recovered attached provider Uncertain without launching a duplicate attempt', async () => {
    const fixture = restartFixture('codex');
    const database = openLedgerDatabase(fixture.state);
    databases.push(database);
    const ledger = new LedgerRepository(database);
    const outbox = new OutboxRepository(database);
    const job = ledger.claimJob({
      sourceMarker: 'attached-restart',
      sourcePath: fixture.note,
      provider: 'codex',
      directive: 'Review',
      context: 'Repository (direct): example/widget',
      repository: 'example/widget',
    });
    const logPath = path.join(fixture.state, 'logs', 'attached.log');
    closeSync(openSync(logPath, 'wx', 0o600));
    const attempt = ledger.prepareAttempt(job.id, logPath);
    ledger.transitionAttempt(attempt.id, 'Launching');
    ledger.recordAttemptSession(attempt.id, 'codex', 'fake-attached');
    ledger.transitionAttempt(attempt.id, 'Running');
    ledger.transitionJob(job.id, 'Working');
    const registry = new ProviderRegistry([namedFakeProvider('codex')]);
    const reconciler = new Reconciler({
      config: fixture.config,
      database,
      ledger,
      outbox,
      providers: registry,
      observeProvider: () => Promise.resolve([]),
    });

    await reconciler.runPass();

    expect(ledger.listAttempts(job.id)).toHaveLength(1);
    expect(ledger.getAttempt(attempt.id)?.state).toBe('Uncertain');
    expect(ledger.getAttempt(attempt.id)?.uncertaintyReason).toMatch(
      /cannot be observed after restart/i,
    );
    expect(ledger.getJob(job.id)?.state).toBe('Working');
    await reconciler.shutdown();
  });

  it('marks an interrupted Claude print session uncertain without relaunching it', async () => {
    const fixture = restartFixture('claude');
    const database = openLedgerDatabase(fixture.state);
    databases.push(database);
    const ledger = new LedgerRepository(database);
    const outbox = new OutboxRepository(database);
    const registry = new ProviderRegistry([namedFakeProvider('claude')]);
    const job = ledger.claimJob({
      sourceMarker: 'claude-foreground-restart',
      sourcePath: fixture.note,
      provider: 'claude',
      directive: 'Review',
      context: 'Repository (direct): example/widget',
      repository: 'example/widget',
    });
    const logPath = path.join(fixture.state, 'logs', 'claude-foreground.log');
    closeSync(openSync(logPath, 'wx', 0o600));
    const attempt = ledger.prepareAttempt(job.id, logPath);
    ledger.transitionAttempt(attempt.id, 'Launching');
    ledger.recordAttemptSession(attempt.id, 'claude', 'fake-foreground');
    ledger.transitionAttempt(attempt.id, 'Running');
    ledger.transitionJob(job.id, 'Working');
    const reconciler = new Reconciler({
      config: fixture.config,
      database,
      ledger,
      outbox,
      providers: registry,
      observeProvider: () => Promise.resolve([]),
    });

    await reconciler.runPass();

    expect(ledger.getAttempt(attempt.id)?.state).toBe('Uncertain');
    expect(ledger.getAttempt(attempt.id)?.uncertaintyReason).toMatch(/cannot be observed/i);
    expect(ledger.getJob(job.id)?.state).toBe('Working');
    expect(ledger.listAttempts(job.id)).toHaveLength(1);
    await reconciler.shutdown();
  });

  it('releases a Prepared crash-boundary lease using lease-owned metadata', async () => {
    const fixture = restartFixture('fake');
    const database = openLedgerDatabase(fixture.state);
    databases.push(database);
    const ledger = new LedgerRepository(database);
    const outbox = new OutboxRepository(database);
    const job = ledger.claimJob({
      sourceMarker: 'prepared-lease',
      sourcePath: fixture.note,
      provider: 'fake',
      directive: 'Review',
      context: 'Repository (direct): example/widget',
      repository: 'example/widget',
    });
    const logPath = path.join(fixture.state, 'logs', 'prepared.log');
    closeSync(openSync(logPath, 'wx', 0o600));
    const attempt = ledger.prepareAttempt(job.id, logPath);
    const workspaces = new WorkspacePool({ repositories: fixture.config.repositories, ledger });
    const acquired = await workspaces.acquire({
      repository: 'example/widget',
      jobId: job.id,
      attemptId: attempt.id,
    });
    expect(acquired.kind).toBe('acquired');
    expect(ledger.getAttempt(attempt.id)?.launchMetadata).toBeNull();
    expect(ledger.listLeases()[0]?.metadata).not.toBeNull();
    const reconciler = new Reconciler({
      config: fixture.config,
      database,
      ledger,
      outbox,
      providers: new ProviderRegistry([namedFakeProvider('fake')]),
      workspaces,
    });

    await reconciler.runPass();

    expect(ledger.getAttempt(attempt.id)?.state).toBe('Terminal');
    expect(ledger.listLeases()[0]?.state).toBe('Released');
    await reconciler.shutdown();
  });

  it('resumes a release-pending lease after its previous owner dies', async () => {
    const fixture = restartFixture('fake');
    const database = openLedgerDatabase(fixture.state);
    databases.push(database);
    const ledger = new LedgerRepository(database);
    const outbox = new OutboxRepository(database);
    let oldOwnerLive = true;
    const identityProvider = (pid: number, birth: string): ProcessIdentityProvider => ({
      current: () => Promise.resolve({ pid, startIdentity: birth }),
      compare: (candidatePid, candidateBirth) =>
        Promise.resolve(
          candidatePid === 700 && candidateBirth === 'old-birth' && oldOwnerLive
            ? 'match'
            : 'not-running',
        ),
    });
    const oldPool = new WorkspacePool({
      repositories: fixture.config.repositories,
      ledger,
      sentinels: new WorkspaceSentinelManager({
        ownerNonce: 'old-owner',
        processIdentity: identityProvider(700, 'old-birth'),
      }),
    });
    const job = ledger.claimJob({
      sourceMarker: 'release-pending',
      sourcePath: fixture.note,
      provider: 'fake',
      directive: 'Review',
      context: 'Repository (direct): example/widget',
      repository: 'example/widget',
    });
    const logPath = path.join(fixture.state, 'logs', 'release-pending.log');
    closeSync(openSync(logPath, 'wx', 0o600));
    const attempt = ledger.prepareAttempt(job.id, logPath);
    const acquired = await oldPool.acquire({
      repository: 'example/widget',
      jobId: job.id,
      attemptId: attempt.id,
    });
    if (acquired.kind !== 'acquired')
      throw new Error('Expected the old owner to acquire the clone');
    const workspace = acquired.handle.canonicalWorkspace;
    ledger.transitionLease(workspace, 'ReleasePending');
    oldOwnerLive = false;
    const restartedPool = new WorkspacePool({
      repositories: fixture.config.repositories,
      ledger,
      sentinels: new WorkspaceSentinelManager({
        ownerNonce: 'new-owner',
        processIdentity: identityProvider(800, 'new-birth'),
      }),
    });
    const reconciler = new Reconciler({
      config: fixture.config,
      database,
      ledger,
      outbox,
      providers: new ProviderRegistry([namedFakeProvider('fake')]),
      workspaces: restartedPool,
    });

    await reconciler.runPass();

    expect(ledger.getLease(workspace)?.state).toBe('Released');
    expect(ledger.getAttempt(attempt.id)?.state).toBe('Terminal');
    await reconciler.shutdown();
  });
});

function restartFixture(provider: string): {
  state: string;
  note: string;
  config: SpoolConfig;
} {
  const root = mkdtempSync(path.join(tmpdir(), 'spool-restart-runtime-'));
  const state = path.join(root, 'state');
  const vault = path.join(root, 'vault');
  const clone = path.join(root, 'clone');
  mkdirSync(state);
  mkdirSync(vault);
  mkdirSync(clone);
  git(clone, ['init']);
  git(clone, ['config', 'user.email', 'fixture@example.com']);
  git(clone, ['config', 'user.name', 'Fixture']);
  writeFileSync(path.join(clone, 'tracked.txt'), 'fixture\n');
  git(clone, ['add', 'tracked.txt']);
  git(clone, ['commit', '-m', 'fixture']);
  git(clone, ['remote', 'add', 'origin', 'git@github.com:example/widget.git']);
  const note = path.join(vault, 'Week 29 of 2026.md');
  writeFileSync(
    note,
    [
      '## Saturday',
      '',
      `- [ ] @${provider} Review https://github.com/example/widget/pull/1`,
      '  ```spool',
      '  Task: background-handoff',
      '  Anchor: spool-background-handoff',
      '  ```',
      '',
    ].join('\n'),
  );
  return {
    state,
    note,
    config: {
      configPath: path.join(root, 'config.yaml'),
      vaults: [vault],
      stateDirectory: state,
      timeZone: 'Europe/Istanbul',
      pollIntervalSeconds: 45,
      dayAliases: { saturday: ['Saturday'] },
      providers: [
        {
          name: provider,
          enabled: true,
          executable: process.execPath,
          executableResolved: true,
          directive: `@${provider}`,
          defaultArgs: [],
        },
      ],
      repositories: [{ repository: 'example/widget', clones: [clone] }],
    },
  };
}

function namedFakeProvider(name: string): ProviderAdapter {
  const fake = new FakeProvider({ executable: process.execPath });
  return {
    name,
    capabilities: fake.capabilities,
    sessionIdPolicy: fake.sessionIdPolicy,
    createLaunch: (input) => fake.createLaunch(input),
    parseEvent: (value) => fake.parseEvent(value),
    inspectCommand: (sessionId) => fake.inspectCommand(sessionId),
    resumeCommand: (sessionId) => fake.resumeCommand(sessionId),
    cancelCommand: (sessionId) => fake.cancelCommand(sessionId),
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
