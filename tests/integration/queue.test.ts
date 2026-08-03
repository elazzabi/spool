import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { SpoolConfig } from '../../src/config/schema.js';
import { openLedgerDatabase } from '../../src/ledger/database.js';
import { OutboxRepository } from '../../src/ledger/outbox.js';
import { LedgerRepository } from '../../src/ledger/repositories.js';
import { receiptAnchorFor } from '../../src/notes/identity.js';
import { FakeProvider } from '../../src/providers/fake.js';
import { runProviderProcess } from '../../src/providers/process-runner.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import type { ProviderAdapter, ProviderRunResult } from '../../src/providers/types.js';
import { JobDispatcher, type ProviderRunner } from '../../src/scheduler/dispatcher.js';
import { AttemptObserver } from '../../src/scheduler/observer.js';
import { NoteProjector } from '../../src/scheduler/projector.js';
import { Reconciler } from '../../src/scheduler/reconciler.js';
import { MarkdownNoteScanner } from '../../src/scheduler/scanner.js';
import { WorkspacePool } from '../../src/workspaces/pool.js';
import { parseWorkspaceCliAcknowledgmentRequest } from '../../src/workspaces/acknowledgment.js';

const now = () => new Date('2026-07-18T10:00:00.000Z');

describe('dispatch receipt barrier', () => {
  it('applies a real Queued receipt before lease and provider spawn', async () => {
    const fixture = schedulerFixture(1);
    const note = path.join(fixture.vault, 'Week 29 of 2026.md');
    writeFileSync(note, trackedTask('receipt-gate'));
    const database = openLedgerDatabase(fixture.state);
    const ledger = new LedgerRepository(database);
    const outbox = new OutboxRepository(database);
    const provider = new FakeProvider({ executable: process.execPath });
    const registry = new ProviderRegistry([provider]);
    const projector = new NoteProjector({ config: fixture.config, ledger, outbox, now });
    const observer = new AttemptObserver({ config: fixture.config, ledger, projector, now });
    const workspaces = new WorkspacePool({ repositories: fixture.config.repositories, ledger });
    const job = ledger.claimJob({
      sourceMarker: 'receipt-gate',
      sourcePath: note,
      provider: 'fake',
      directive: 'Review',
      context:
        'PR (direct): https://github.com/example/widget/pull/1\nRepository (direct): example/widget',
      repository: 'example/widget',
    });
    let runnerCalls = 0;
    const dispatcher = new JobDispatcher({
      config: fixture.config,
      ledger,
      providers: registry,
      workspaces,
      observer,
      projector,
      runner: async (request, callbacks) => {
        runnerCalls += 1;
        expect(readFileSync(note, 'utf8')).toContain('Status: Queued');
        expect(ledger.getProjection(`initial-receipt:${job.id}`)?.state).toBe('Applied');
        return runProviderProcess(request, callbacks);
      },
    });

    await dispatcher.dispatch();
    expect(runnerCalls).toBe(0);
    expect(ledger.listAttempts(job.id)).toEqual([]);

    projector.enqueueSource(job, `initial-receipt:${job.id}`, {
      kind: 'receipt',
      taskId: job.sourceMarker,
      receipt: {
        taskId: job.sourceMarker,
        sessionId: null,
        status: 'Queued',
        updatedAt: job.createdAt,
        context: job.context,
      },
    });
    expect(await projector.deliver('writer')).toMatchObject({ applied: 1, blocked: 0 });
    expect((await dispatcher.dispatch()).launched).toEqual([job.id]);
    await dispatcher.waitForIdle();
    await projector.deliver('writer');

    expect(runnerCalls).toBe(1);
    expect(ledger.getJob(job.id)?.state).toBe('Completed');
    const projected = readFileSync(note, 'utf8');
    const workspace = realpathSync(fixture.clones[0]!);
    expect(projected).toContain(`Inspect: cd ${workspace} && `);
    expect(projected).toContain(`- [ ] Check agent output using command \`cd ${workspace} && `);
    database.close();
  });

  it('projects an explicit provider failure message as the latest output', async () => {
    const fixture = schedulerFixture(1);
    const note = path.join(fixture.vault, 'Week 29 of 2026.md');
    writeFileSync(note, trackedTask('visible-failure'));
    const database = openLedgerDatabase(fixture.state);
    const ledger = new LedgerRepository(database);
    const outbox = new OutboxRepository(database);
    const provider = new FakeProvider({ executable: process.execPath });
    const registry = new ProviderRegistry([provider]);
    const projector = new NoteProjector({ config: fixture.config, ledger, outbox });
    const observer = new AttemptObserver({
      config: fixture.config,
      ledger,
      projector,
      now,
    });
    const workspaces = new WorkspacePool({ repositories: fixture.config.repositories, ledger });
    const job = ledger.claimJob({
      sourceMarker: 'visible-failure',
      sourcePath: note,
      provider: 'fake',
      directive: 'Review',
      context: 'Repository (direct): example/widget',
      repository: 'example/widget',
    });
    projector.enqueueSource(job, `initial-receipt:${job.id}`, {
      kind: 'receipt',
      taskId: job.sourceMarker,
      receipt: {
        taskId: job.sourceMarker,
        sessionId: null,
        status: 'Queued',
        updatedAt: job.createdAt,
        context: job.context,
      },
    });
    await projector.deliver('writer');
    const failure = 'The configured model requires a newer provider version.';
    const dispatcher = new JobDispatcher({
      config: fixture.config,
      ledger,
      providers: registry,
      workspaces,
      observer,
      projector,
      runner: async (request, callbacks) => {
        await callbacks?.onProcessStarted?.({ pid: 404, processStartIdentity: 'fixture-404' });
        await callbacks?.onSessionIdentity?.({ sessionId: 'fake-visible-failure' });
        await callbacks?.onEvidence?.({
          kind: 'session',
          eventKey: 'session-visible-failure',
          sessionId: 'fake-visible-failure',
        });
        await callbacks?.onEvidence?.({
          kind: 'output',
          eventKey: 'failure-output',
          text: failure,
        });
        await callbacks?.onEvidence?.({
          kind: 'terminal',
          eventKey: 'terminal-visible-failure',
          state: 'failed',
          proof: 'fixture:explicit-failure',
          message: failure,
        });
        return {
          launchState: 'started',
          processIdentity: { pid: 404, processStartIdentity: 'fixture-404' },
          terminalState: 'failed',
          observation: {
            sessionId: 'fake-visible-failure',
            state: 'failed',
            latestOutput: { text: failure, hash: 'fixture-failure-hash' },
            terminalProof: { state: 'failed', proof: 'fixture:explicit-failure' },
            events: [],
          },
          exit: { code: 1, signal: null },
          diagnostics: [],
          cancelRequested: false,
          timedOut: false,
          log: { path: request.logTarget.canonicalPath, bytesWritten: 0, truncated: false },
        };
      },
    });

    expect((await dispatcher.dispatch()).launched).toEqual([job.id]);
    await dispatcher.waitForIdle();
    await projector.deliver('writer');

    expect(ledger.getJob(job.id)?.state).toBe('Failed');
    expect(ledger.listAttempts(job.id)[0]?.latestOutput).toBe(failure);
    const projected = readFileSync(note, 'utf8');
    expect(projected).toContain('Latest output:');
    expect(projected).toContain(failure);
    database.close();
  });

  it('never calls a provider runner while the initial receipt is blocked', async () => {
    const fixture = schedulerFixture(1);
    const note = path.join(fixture.vault, 'Week 29 of 2026.md');
    writeFileSync(note, `${trackedTask('blocked-gate')}${trackedTask('blocked-gate')}`);
    const database = openLedgerDatabase(fixture.state);
    const ledger = new LedgerRepository(database);
    const outbox = new OutboxRepository(database);
    const provider = new FakeProvider({ executable: process.execPath });
    const registry = new ProviderRegistry([provider]);
    const projector = new NoteProjector({ config: fixture.config, ledger, outbox });
    const observer = new AttemptObserver({
      config: fixture.config,
      ledger,
      projector,
      now,
    });
    const workspaces = new WorkspacePool({ repositories: fixture.config.repositories, ledger });
    const job = ledger.claimJob({
      sourceMarker: 'blocked-gate',
      sourcePath: note,
      provider: 'fake',
      directive: 'Review',
      context: 'Repository (direct): example/widget',
      repository: 'example/widget',
    });
    let runnerCalls = 0;
    const dispatchWaiting = vi.fn(() => Promise.resolve(true));
    const dispatcher = new JobDispatcher({
      config: fixture.config,
      ledger,
      providers: registry,
      workspaces,
      observer,
      projector,
      runner: async (request, callbacks) => {
        runnerCalls += 1;
        return runProviderProcess(request, callbacks);
      },
      operationalLog: {
        dispatchWaiting,
        workspaceAcquired: () => Promise.resolve(true),
        workspaceReleased: () => Promise.resolve(true),
        workspaceQuarantined: () => Promise.resolve(true),
        providerLaunched: () => Promise.resolve(true),
        providerTerminal: () => Promise.resolve(true),
      },
    });
    projector.enqueueSource(job, `initial-receipt:${job.id}`, {
      kind: 'receipt',
      taskId: job.sourceMarker,
      receipt: {
        taskId: job.sourceMarker,
        sessionId: null,
        status: 'Queued',
        updatedAt: job.createdAt,
        context: job.context,
      },
    });

    expect(await projector.deliver('writer')).toMatchObject({ applied: 0, blocked: 1 });
    expect(ledger.getProjection(`initial-receipt:${job.id}`)?.state).toBe('Blocked');
    await dispatcher.dispatch();
    expect(runnerCalls).toBe(0);
    expect(dispatchWaiting).toHaveBeenCalledWith(job.id, 'projection_blocked');
    expect(ledger.listAttempts(job.id)).toEqual([]);
    database.close();
  });

  it('reports an unmapped repository distinctly without creating an attempt', async () => {
    const fixture = schedulerFixture(1);
    const note = path.join(fixture.vault, 'Week 29 of 2026.md');
    writeFileSync(note, trackedTask('unmapped-repository'));
    const database = openLedgerDatabase(fixture.state);
    const ledger = new LedgerRepository(database);
    const outbox = new OutboxRepository(database);
    const provider = new FakeProvider({ executable: process.execPath });
    const registry = new ProviderRegistry([provider]);
    const projector = new NoteProjector({ config: fixture.config, ledger, outbox });
    const observer = new AttemptObserver({
      config: fixture.config,
      ledger,
      projector,
      now,
    });
    const workspaces = new WorkspacePool({ repositories: fixture.config.repositories, ledger });
    const job = ledger.claimJob({
      sourceMarker: 'unmapped-repository',
      sourcePath: note,
      provider: 'fake',
      directive: 'Review',
      context: 'Repository (direct): example/other',
      repository: 'example/other',
    });
    projector.enqueueSource(job, `initial-receipt:${job.id}`, {
      kind: 'receipt',
      taskId: job.sourceMarker,
      receipt: {
        taskId: job.sourceMarker,
        sessionId: null,
        status: 'Queued',
        updatedAt: job.createdAt,
        context: job.context,
      },
    });
    await projector.deliver('writer');
    const dispatcher = new JobDispatcher({
      config: fixture.config,
      ledger,
      providers: registry,
      workspaces,
      observer,
      projector,
    });

    const result = await dispatcher.dispatch();
    await projector.deliver('writer');

    expect(result.unavailable[0]?.reason).toMatch(/no workspace pool is configured/i);
    expect(result.queuedForCapacity).toEqual([]);
    expect(ledger.listAttempts(job.id)).toEqual([]);
    expect(readFileSync(note, 'utf8')).toContain(
      'No workspace pool is configured for example/other',
    );
    database.close();
  });

  it('reports the configured workspace path and exact reason while capacity is unsafe', async () => {
    const fixture = schedulerFixture(1);
    const clone = fixture.clones[0]!;
    writeFileSync(path.join(clone, 'manual.txt'), 'manual work');
    const note = path.join(fixture.vault, 'Week 29 of 2026.md');
    writeFileSync(note, trackedTask('dirty-capacity'));
    const database = openLedgerDatabase(fixture.state);
    const ledger = new LedgerRepository(database);
    const outbox = new OutboxRepository(database);
    const provider = new FakeProvider({ executable: process.execPath });
    const registry = new ProviderRegistry([provider]);
    const projector = new NoteProjector({ config: fixture.config, ledger, outbox });
    const observer = new AttemptObserver({
      config: fixture.config,
      ledger,
      projector,
      now,
    });
    const workspaces = new WorkspacePool({ repositories: fixture.config.repositories, ledger });
    const job = ledger.claimJob({
      sourceMarker: 'dirty-capacity',
      sourcePath: note,
      provider: 'fake',
      directive: 'Review',
      context: 'Repository (direct): example/widget',
      repository: 'example/widget',
    });
    projector.enqueueSource(job, `initial-receipt:${job.id}`, {
      kind: 'receipt',
      taskId: job.sourceMarker,
      receipt: {
        taskId: job.sourceMarker,
        sessionId: null,
        status: 'Queued',
        updatedAt: job.createdAt,
        context: job.context,
      },
    });
    await projector.deliver('writer');
    const dispatcher = new JobDispatcher({
      config: fixture.config,
      ledger,
      providers: registry,
      workspaces,
      observer,
      projector,
    });

    const result = await dispatcher.dispatch();
    await projector.deliver('writer');

    const receipt = readFileSync(note, 'utf8');
    expect(result.queuedForCapacity).toEqual([job.id]);
    expect(ledger.listAttempts(job.id)).toEqual([]);
    expect(receipt).toContain('Waiting for a safe workspace for example/widget:');
    expect(receipt).toContain(`${clone}: The clone is not clean (1 untracked)`);
    expect(receipt).not.toContain('No safe clone is currently free');
    database.close();
  });

  it('identifies the task holding a lease and renders the exact cancel command', async () => {
    const fixture = schedulerFixture(1);
    const clone = realpathSync(fixture.clones[0]!);
    const note = path.join(fixture.vault, 'Week 29 of 2026.md');
    writeFileSync(note, trackedTask('waiting-task'));
    const database = openLedgerDatabase(fixture.state);
    const ledger = new LedgerRepository(database);
    const outbox = new OutboxRepository(database);
    const provider = new FakeProvider({ executable: process.execPath });
    const registry = new ProviderRegistry([provider]);
    const projector = new NoteProjector({ config: fixture.config, ledger, outbox });
    const observer = new AttemptObserver({
      config: fixture.config,
      ledger,
      projector,
      now,
    });
    const workspaces = new WorkspacePool({ repositories: fixture.config.repositories, ledger });
    const owner = ledger.claimJob({
      sourceMarker: 'owner-task',
      sourcePath: note,
      provider: 'fake',
      directive: 'Review first',
      context: 'Repository (direct): example/widget',
      repository: 'example/widget',
    });
    const ownerAttempt = ledger.prepareAttempt(
      owner.id,
      path.join(fixture.state, 'logs', 'owner.log'),
    );
    ledger.transitionAttempt(ownerAttempt.id, 'Launching');
    ledger.transitionAttempt(ownerAttempt.id, 'Running');
    ledger.transitionJob(owner.id, 'Working');
    ledger.holdLease(clone, owner.id, ownerAttempt.id);
    const waiting = ledger.claimJob({
      sourceMarker: 'waiting-task',
      sourcePath: note,
      provider: 'fake',
      directive: 'Review second',
      context: 'Repository (direct): example/widget',
      repository: 'example/widget',
    });
    projector.enqueueSource(waiting, `initial-receipt:${waiting.id}`, {
      kind: 'receipt',
      taskId: waiting.sourceMarker,
      receipt: {
        taskId: waiting.sourceMarker,
        sessionId: null,
        status: 'Queued',
        updatedAt: waiting.createdAt,
        context: waiting.context,
      },
    });
    await projector.deliver('writer');
    const dispatcher = new JobDispatcher({
      config: fixture.config,
      ledger,
      providers: registry,
      workspaces,
      observer,
      projector,
    });

    const result = await dispatcher.dispatch();
    await projector.deliver('writer');

    const receipt = readFileSync(note, 'utf8');
    expect(result.queuedForCapacity).toEqual([waiting.id]);
    expect(receipt).toContain(`In use by task owner-task (Working; job ${owner.id})`);
    expect(receipt).toContain('Action: wait for that task to finish, or cancel it:');
    expect(receipt).toContain(`spool --config ${fixture.config.configPath} cancel owner-task`);
    expect(receipt).not.toContain(`cancel ${waiting.sourceMarker}\nAction:`);
    database.close();
  });

  it('releases the lease and reports not launched when adapter request creation fails', async () => {
    const fixture = schedulerFixture(1);
    const note = path.join(fixture.vault, 'Week 29 of 2026.md');
    writeFileSync(note, trackedTask('request-failure'));
    const database = openLedgerDatabase(fixture.state);
    const ledger = new LedgerRepository(database);
    const outbox = new OutboxRepository(database);
    const base = new FakeProvider({ executable: process.execPath });
    const provider: ProviderAdapter = {
      name: base.name,
      capabilities: base.capabilities,
      sessionIdPolicy: base.sessionIdPolicy,
      createLaunch: () => {
        throw new Error('fixture request construction failed');
      },
      parseEvent: (value) => base.parseEvent(value),
      inspectCommand: (sessionId) => base.inspectCommand(sessionId),
    };
    const registry = new ProviderRegistry([provider]);
    const projector = new NoteProjector({ config: fixture.config, ledger, outbox });
    const observer = new AttemptObserver({
      config: fixture.config,
      ledger,
      projector,
      now,
    });
    const workspaces = new WorkspacePool({ repositories: fixture.config.repositories, ledger });
    const job = ledger.claimJob({
      sourceMarker: 'request-failure',
      sourcePath: note,
      provider: 'fake',
      directive: 'Review',
      context: 'Repository (direct): example/widget',
      repository: 'example/widget',
    });
    projector.enqueueSource(job, `initial-receipt:${job.id}`, {
      kind: 'receipt',
      taskId: job.sourceMarker,
      receipt: {
        taskId: job.sourceMarker,
        sessionId: null,
        status: 'Queued',
        updatedAt: job.createdAt,
        context: job.context,
      },
    });
    await projector.deliver('writer');
    const dispatcher = new JobDispatcher({
      config: fixture.config,
      ledger,
      providers: registry,
      workspaces,
      observer,
      projector,
    });

    const result = await dispatcher.dispatch();
    await projector.deliver('writer');

    expect(result.launched).toEqual([]);
    expect(result.unavailable[0]?.reason).toBe('fixture request construction failed');
    expect(ledger.listAttempts(job.id)[0]?.state).toBe('Terminal');
    expect(ledger.listLeases()[0]?.state).toBe('Released');
    expect(readFileSync(note, 'utf8')).toContain('fixture request construction failed');
    database.close();
  });
});

describe('repository queue', () => {
  it('runs two jobs in parallel and preserves FIFO for a third job', async () => {
    const fixture = schedulerFixture(2);
    const note = path.join(fixture.vault, 'Week 29 of 2026.md');
    writeFileSync(
      note,
      [
        '## Saturday',
        '',
        '- PR https://github.com/example/widget/pull/1',
        '  - [ ] @fake Review first',
        '- PR https://github.com/example/widget/pull/2',
        '  - [ ] @fake Review second',
        '- PR https://github.com/example/widget/pull/3',
        '  - [ ] @fake Review third',
        '',
      ].join('\n'),
    );
    const database = openLedgerDatabase(fixture.state);
    const ledger = new LedgerRepository(database);
    const outbox = new OutboxRepository(database);
    const provider = new FakeProvider({ executable: process.execPath });
    const registry = new ProviderRegistry([provider]);
    const projector = new NoteProjector({ config: fixture.config, ledger, outbox, now });
    const observer = new AttemptObserver({ config: fixture.config, ledger, projector, now });
    const workspaces = new WorkspacePool({ repositories: fixture.config.repositories, ledger });
    const scanner = new MarkdownNoteScanner({
      vaults: [fixture.vault],
      providers: { fake: '@fake' },
      idFactory: sequentialIds('task'),
    });
    let active = 0;
    let maximumActive = 0;
    let sequence = 0;
    const starts: string[] = [];
    let releaseCapacity: (() => void) | undefined;
    const capacityGate = new Promise<void>((resolve) => {
      releaseCapacity = resolve;
    });
    const runner: ProviderRunner = async (request, callbacks) => {
      sequence += 1;
      const sessionId = `fake-queue-${String(sequence)}`;
      starts.push(request.target.cwd.canonicalPath);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await callbacks?.onProcessStarted?.({
        pid: 10_000 + sequence,
        processStartIdentity: `fixture-${String(sequence)}`,
      });
      await callbacks?.onSessionIdentity?.({ sessionId });
      await callbacks?.onEvidence?.({
        kind: 'session',
        eventKey: `session-${String(sequence)}`,
        sessionId,
      });
      await callbacks?.onEvidence?.({
        kind: 'state',
        eventKey: `working-${String(sequence)}`,
        state: 'working',
      });
      if (sequence <= 2) await capacityGate;
      const output = `Completed job ${String(sequence)}`;
      await callbacks?.onEvidence?.({
        kind: 'output',
        eventKey: `output-${String(sequence)}`,
        text: output,
      });
      await callbacks?.onEvidence?.({
        kind: 'terminal',
        eventKey: `terminal-${String(sequence)}`,
        state: 'completed',
        proof: `proof-${String(sequence)}`,
      });
      active -= 1;
      return completedResult(request.logTarget.canonicalPath, sessionId, output, sequence);
    };
    const dispatcher = new JobDispatcher({
      config: fixture.config,
      ledger,
      providers: registry,
      workspaces,
      observer,
      projector,
      runner,
    });
    const reconciler = new Reconciler({
      config: fixture.config,
      database,
      ledger,
      outbox,
      providers: registry,
      workspaces,
      scanner,
      projector,
      observer,
      dispatcher,
    });

    await reconciler.runPass();
    const firstWave = await reconciler.runPass();
    const queuedJob = ledger.listJobs()[2]!;
    expect(ledger.listAttempts(queuedJob.id)).toEqual([]);
    expect(readdirSync(path.join(fixture.state, 'logs'))).toHaveLength(2);
    await reconciler.runPass();
    expect(ledger.listAttempts(queuedJob.id)).toEqual([]);
    expect(readdirSync(path.join(fixture.state, 'logs'))).toHaveLength(2);
    releaseCapacity?.();
    await dispatcher.waitForIdle();
    await reconciler.runPass({ awaitLaunched: true });

    expect(ledger.listJobs().map((job) => job.state)).toEqual([
      'Completed',
      'Completed',
      'Completed',
    ]);
    expect(ledger.listJobs().map((job) => ledger.listAttempts(job.id).length)).toEqual([1, 1, 1]);
    expect(maximumActive).toBe(2);
    expect(starts.slice(0, 2).sort()).toEqual(
      fixture.clones.map((clone) => realpathSync(clone)).sort(),
    );
    expect(firstWave.dispatches[0]?.queuedForCapacity).toHaveLength(1);
    expect(readFileSync(note, 'utf8').match(/Check agent output using command/g)).toHaveLength(3);
    await reconciler.shutdown();
    database.close();
  });

  it('skips a manually dirty first clone and launches in the next clean clone', async () => {
    const fixture = schedulerFixture(2);
    writeFileSync(path.join(fixture.clones[0]!, 'manual.txt'), 'manual work');
    const note = path.join(fixture.vault, 'Week 29 of 2026.md');
    writeFileSync(note, trackedTask('dirty-skip'));
    const database = openLedgerDatabase(fixture.state);
    const ledger = new LedgerRepository(database);
    const outbox = new OutboxRepository(database);
    const provider = new FakeProvider({ executable: process.execPath });
    const registry = new ProviderRegistry([provider]);
    const projector = new NoteProjector({ config: fixture.config, ledger, outbox });
    const observer = new AttemptObserver({
      config: fixture.config,
      ledger,
      projector,
      now,
    });
    const workspaces = new WorkspacePool({ repositories: fixture.config.repositories, ledger });
    const job = ledger.claimJob({
      sourceMarker: 'dirty-skip',
      sourcePath: note,
      provider: 'fake',
      directive: 'Review',
      context: 'Repository (direct): example/widget',
      repository: 'example/widget',
    });
    projector.enqueueSource(job, `initial-receipt:${job.id}`, {
      kind: 'receipt',
      taskId: job.sourceMarker,
      receipt: {
        taskId: job.sourceMarker,
        sessionId: null,
        status: 'Queued',
        updatedAt: job.createdAt,
        context: job.context,
      },
    });
    await projector.deliver('writer');
    let cwd = '';
    const dispatcher = new JobDispatcher({
      config: fixture.config,
      ledger,
      providers: registry,
      workspaces,
      observer,
      projector,
      runner: async (request, callbacks) => {
        cwd = request.target.cwd.canonicalPath;
        return runProviderProcess(request, callbacks);
      },
    });

    await dispatcher.dispatch();
    await dispatcher.waitForIdle();
    expect(cwd).toBe(realpathSync(fixture.clones[1]!));
    expect(readFileSync(path.join(fixture.clones[0]!, 'manual.txt'), 'utf8')).toBe('manual work');
    database.close();
  });
});

describe('detached provider cancellation', () => {
  it('runs typed cancel argv but waits for later terminal evidence', async () => {
    const fixture = schedulerFixture(1);
    const database = openLedgerDatabase(fixture.state);
    const ledger = new LedgerRepository(database);
    const outbox = new OutboxRepository(database);
    const provider = new FakeProvider({ executable: process.execPath });
    const registry = new ProviderRegistry([provider]);
    const projector = new NoteProjector({ config: fixture.config, ledger, outbox });
    const observer = new AttemptObserver({
      config: fixture.config,
      ledger,
      projector,
      now,
    });
    const workspaces = new WorkspacePool({ repositories: fixture.config.repositories, ledger });
    const job = ledger.claimJob({
      sourceMarker: 'cancel-detached',
      sourcePath: path.join(fixture.vault, 'Week 29 of 2026.md'),
      provider: 'fake',
      directive: 'Review',
      context: '',
    });
    const attempt = ledger.prepareAttempt(job.id, path.join(fixture.state, 'logs', 'cancel.log'));
    ledger.transitionAttempt(attempt.id, 'Launching');
    ledger.recordAttemptSession(attempt.id, 'fake', 'fake-detached');
    ledger.transitionAttempt(attempt.id, 'Running');
    ledger.transitionJob(job.id, 'Working');
    ledger.requestCancellation(job.id);
    const commands: Array<{ executable: string; args: readonly string[] }> = [];
    const dispatcher = new JobDispatcher({
      config: fixture.config,
      ledger,
      providers: registry,
      workspaces,
      observer,
      projector,
      controlRunner: (executable, args) => {
        commands.push({ executable, args });
        return Promise.resolve(true);
      },
    });

    await expect(dispatcher.cancel(job.id)).resolves.toBe(true);
    expect(commands[0]).toMatchObject({
      executable: process.execPath,
      args: [expect.stringContaining('fake-agent.mjs'), '--cancel', 'fake-detached'],
    });
    expect(ledger.getJob(job.id)).toMatchObject({
      state: 'Working',
      cancellationRequested: true,
    });
    expect(ledger.getAttempt(attempt.id)?.state).toBe('Running');
    database.close();
  });

  it('cancels an attached run only after provider terminal proof and creates no review todo', async () => {
    const fixture = schedulerFixture(1);
    const note = path.join(fixture.vault, 'Week 29 of 2026.md');
    writeFileSync(note, trackedTask('cancel-running'));
    const database = openLedgerDatabase(fixture.state);
    const ledger = new LedgerRepository(database);
    const outbox = new OutboxRepository(database);
    const provider = waitCancelProvider();
    const registry = new ProviderRegistry([provider]);
    const projector = new NoteProjector({ config: fixture.config, ledger, outbox, now });
    const observer = new AttemptObserver({ config: fixture.config, ledger, projector, now });
    const workspaces = new WorkspacePool({ repositories: fixture.config.repositories, ledger });
    const job = ledger.claimJob({
      sourceMarker: 'cancel-running',
      sourcePath: note,
      provider: 'fake',
      directive: 'Review',
      context: 'Repository (direct): example/widget',
      repository: 'example/widget',
    });
    projector.enqueueSource(job, `initial-receipt:${job.id}`, {
      kind: 'receipt',
      taskId: job.sourceMarker,
      receipt: {
        taskId: job.sourceMarker,
        sessionId: null,
        status: 'Queued',
        updatedAt: job.createdAt,
        context: job.context,
      },
    });
    await projector.deliver('writer');
    const dispatcher = new JobDispatcher({
      config: fixture.config,
      ledger,
      providers: registry,
      workspaces,
      observer,
      projector,
    });

    await dispatcher.dispatch();
    await waitFor(() => ledger.getJob(job.id)?.state === 'Working');
    ledger.requestCancellation(job.id);
    await expect(dispatcher.cancel(job.id)).resolves.toBe(true);
    expect(ledger.getJob(job.id)?.state).toBe('Working');
    await dispatcher.waitForIdle();
    await projector.deliver('writer');

    expect(ledger.getJob(job.id)).toMatchObject({
      state: 'Cancelled',
      cancellationRequested: true,
    });
    expect(ledger.listAttempts(job.id)[0]?.state).toBe('Terminal');
    expect(readFileSync(note, 'utf8')).toContain('Status: Cancelled');
    expect(readFileSync(note, 'utf8')).not.toContain('Check agent output using command');
    expect(readFileSync(note, 'utf8')).toContain('Inspect cancelled agent session using command');
    database.close();
  });

  it('projects queued cancellation even after a historical capacity attempt', async () => {
    const fixture = schedulerFixture(1);
    const note = path.join(fixture.vault, 'Week 29 of 2026.md');
    writeFileSync(note, trackedTask('cancel-queued'));
    const database = openLedgerDatabase(fixture.state);
    const ledger = new LedgerRepository(database);
    const outbox = new OutboxRepository(database);
    const job = ledger.claimJob({
      sourceMarker: 'cancel-queued',
      sourcePath: note,
      provider: 'fake',
      directive: 'Review',
      context: '',
    });
    const historical = ledger.prepareAttempt(
      job.id,
      path.join(fixture.state, 'logs', 'historical-capacity.log'),
    );
    ledger.transitionAttempt(historical.id, 'Terminal');

    expect(ledger.requestCancellation(job.id)).toMatchObject({
      state: 'Cancelled',
      cancellationRequested: true,
    });
    const registry = new ProviderRegistry([new FakeProvider({ executable: process.execPath })]);
    const reconciler = new Reconciler({
      config: fixture.config,
      database,
      ledger,
      outbox,
      providers: registry,
    });
    await reconciler.runPass();

    expect(ledger.listAttempts(job.id)).toHaveLength(1);
    expect(readFileSync(note, 'utf8')).toContain('Status: Cancelled');
    await reconciler.shutdown();
    database.close();
  });
});

describe('terminal workspace disposition', () => {
  it('requires a fresh checked action after an unsafe acknowledgment', async () => {
    const fixture = schedulerFixture(1);
    const note = path.join(fixture.vault, 'Week 29 of 2026.md');
    writeFileSync(note, trackedTask('terminal-quarantine'));
    const database = openLedgerDatabase(fixture.state);
    const ledger = new LedgerRepository(database);
    const outbox = new OutboxRepository(database);
    const provider = new FakeProvider({ executable: process.execPath });
    const registry = new ProviderRegistry([provider]);
    const projector = new NoteProjector({ config: fixture.config, ledger, outbox, now });
    const observer = new AttemptObserver({ config: fixture.config, ledger, projector, now });
    const workspaces = new WorkspacePool({ repositories: fixture.config.repositories, ledger });
    const job = ledger.claimJob({
      sourceMarker: 'terminal-quarantine',
      sourcePath: note,
      provider: 'fake',
      directive: 'Review',
      context: 'Repository (direct): example/widget',
      repository: 'example/widget',
    });
    projector.enqueueSource(job, `initial-receipt:${job.id}`, {
      kind: 'receipt',
      taskId: job.sourceMarker,
      receipt: {
        taskId: job.sourceMarker,
        sessionId: null,
        status: 'Queued',
        updatedAt: job.createdAt,
        context: job.context,
      },
    });
    await projector.deliver('writer');
    const dispatcher = new JobDispatcher({
      config: fixture.config,
      ledger,
      providers: registry,
      workspaces,
      observer,
      projector,
      runner: async (request, callbacks) => {
        await callbacks?.onProcessStarted?.({ pid: 99, processStartIdentity: 'fixture-99' });
        await callbacks?.onSessionIdentity?.({ sessionId: 'fake-quarantine' });
        await callbacks?.onEvidence?.({
          kind: 'session',
          eventKey: 'session-quarantine',
          sessionId: 'fake-quarantine',
        });
        await callbacks?.onEvidence?.({
          kind: 'state',
          eventKey: 'working-quarantine',
          state: 'working',
        });
        writeFileSync(path.join(request.target.cwd.canonicalPath, 'agent-left.txt'), 'preserve');
        await callbacks?.onEvidence?.({
          kind: 'output',
          eventKey: 'output-quarantine',
          text: 'Review completed but workspace changed.',
        });
        await callbacks?.onEvidence?.({
          kind: 'terminal',
          eventKey: 'terminal-quarantine',
          state: 'completed',
          proof: 'proof-quarantine',
        });
        return completedResult(
          request.logTarget.canonicalPath,
          'fake-quarantine',
          'Review completed but workspace changed.',
          99,
        );
      },
    });

    await dispatcher.dispatch();
    await dispatcher.waitForIdle();
    await projector.deliver('writer');

    expect(ledger.getJob(job.id)?.state).toBe('Completed');
    expect(ledger.listLeases()[0]?.state).toBe('Quarantined');
    expect(readFileSync(note, 'utf8')).toContain('- [ ] Check agent output using command');
    expect(readFileSync(note, 'utf8')).toContain('- [ ] Inspect quarantined workspace:');
    expect(readFileSync(note, 'utf8')).toContain(
      'checking this action will attempt to return the clone to captured branch main and release it',
    );
    expect(readFileSync(note, 'utf8')).not.toContain('workspace acknowledge');
    expect(readFileSync(path.join(fixture.clones[0]!, 'agent-left.txt'), 'utf8')).toBe('preserve');

    const attempt = ledger.listAttempts(job.id)[0]!;
    expect(readFileSync(note, 'utf8')).toContain(
      `data-spool-event="workspace-ack:${attempt.id}:0"`,
    );
    writeFileSync(
      note,
      readFileSync(note, 'utf8').replace(
        '- [ ] Inspect quarantined workspace:',
        '- [x] Inspect quarantined workspace:',
      ),
    );
    const reconciler = new Reconciler({
      config: fixture.config,
      database,
      ledger,
      outbox,
      providers: registry,
      workspaces,
      projector,
      observer,
      dispatcher,
    });

    const refusedPass = await reconciler.runPass();

    expect(refusedPass.scan.workspaceActions).toEqual([
      expect.objectContaining({
        taskId: job.sourceMarker,
        eventKey: `workspace-ack:${attempt.id}:0`,
      }),
    ]);
    expect(ledger.getLease(realpathSync(fixture.clones[0]!))?.state).toBe('Quarantined');
    const refusedActions = ledger.listFollowUps(job.id);
    expect(refusedActions.map(({ eventKey }) => eventKey)).toEqual([
      `workspace-ack:${attempt.id}:0`,
      `workspace-ack:${attempt.id}:1`,
    ]);
    expect(refusedActions[0]?.completedAt).not.toBeNull();
    expect(refusedActions[1]?.completedAt).toBeNull();
    expect(readFileSync(note, 'utf8')).toContain(
      `data-spool-event="workspace-ack:${attempt.id}:1"`,
    );

    unlinkSync(path.join(fixture.clones[0]!, 'agent-left.txt'));
    await reconciler.runPass();

    expect(ledger.getLease(realpathSync(fixture.clones[0]!))?.state).toBe('Quarantined');
    expect(ledger.listFollowUps(job.id)).toHaveLength(2);
    writeFileSync(
      note,
      readFileSync(note, 'utf8').replace(
        '- [ ] Inspect quarantined workspace:',
        '- [x] Inspect quarantined workspace:',
      ),
    );
    await reconciler.runPass();

    expect(ledger.getLease(realpathSync(fixture.clones[0]!))?.state).toBe('Released');
    expect(ledger.listFollowUps(job.id).every((action) => action.completedAt !== null)).toBe(true);
    expect(readFileSync(note, 'utf8')).not.toContain('Workspace: Quarantined');
    await reconciler.runPass();
    expect(ledger.listFollowUps(job.id)).toHaveLength(3);
    await reconciler.shutdown();
    database.close();
  });

  it('reasserts a refused successor after the durable refusal commits before projection', async () => {
    const context = await quarantinedAcknowledgmentFixture('refusal-projection-recovery');
    checkWorkspaceAction(context.note, context.eventKey);
    const successorEventKey = `workspace-ack:${context.attempt.id}:1`;
    const claimed = context.ledger.claimWorkspaceAcknowledgment({
      jobId: context.job.id,
      attemptId: context.attempt.id,
      canonicalWorkspace: context.workspace,
      eventKey: context.eventKey,
      successorEventKey,
      successorText: 'Inspect quarantined workspace',
    });
    if (claimed.kind !== 'claimed') throw new Error(claimed.reason);

    await expect(context.workspaces.acknowledgeClaim(claimed)).resolves.toMatchObject({
      kind: 'refused',
    });
    expect(
      context.ledger.getProjection(`workspace-action:${context.job.id}:${successorEventKey}`),
    ).toBeNull();

    const reconciler = new Reconciler({
      config: context.fixture.config,
      database: context.database,
      ledger: context.ledger,
      outbox: context.outbox,
      providers: context.registry,
      workspaces: context.workspaces,
      projector: context.projector,
      observer: context.observer,
    });
    await reconciler.runPass();

    expect(readFileSync(context.note, 'utf8')).toContain(`data-spool-event="${successorEventKey}"`);
    expect(readFileSync(context.note, 'utf8')).not.toContain('workspace acknowledge');
    expect(context.ledger.listFollowUps(context.job.id)).toHaveLength(2);
    await reconciler.shutdown();
    context.database.close();
  });

  it('reasserts release projections after the durable release commits before projection', async () => {
    const context = await quarantinedAcknowledgmentFixture('release-projection-recovery');
    unlinkSync(context.dirtyPath);
    checkWorkspaceAction(context.note, context.eventKey);
    const claimed = context.ledger.claimWorkspaceAcknowledgment({
      jobId: context.job.id,
      attemptId: context.attempt.id,
      canonicalWorkspace: context.workspace,
      eventKey: context.eventKey,
      successorEventKey: `workspace-ack:${context.attempt.id}:1`,
      successorText: 'Inspect quarantined workspace',
    });
    if (claimed.kind !== 'claimed') throw new Error(claimed.reason);

    await expect(context.workspaces.acknowledgeClaim(claimed)).resolves.toMatchObject({
      kind: 'released',
    });
    const resolvedKey = `workspace-action-resolved:${context.job.id}:${context.eventKey}`;
    expect(context.ledger.getProjection(resolvedKey)).toBeNull();

    const reconciler = new Reconciler({
      config: context.fixture.config,
      database: context.database,
      ledger: context.ledger,
      outbox: context.outbox,
      providers: context.registry,
      workspaces: context.workspaces,
      projector: context.projector,
      observer: context.observer,
    });
    await reconciler.runPass();

    expect(context.ledger.getProjection(resolvedKey)?.state).toBe('Applied');
    expect(readFileSync(context.note, 'utf8')).not.toContain('Workspace: Quarantined');
    expect(
      context.ledger.listFollowUps(context.job.id).every(({ completedAt }) => completedAt),
    ).toBe(true);
    await reconciler.shutdown();
    context.database.close();
  });

  it('consumes a CLI acknowledgment request while the daemon owns the state store', async () => {
    const context = await quarantinedAcknowledgmentFixture('cli-request-daemon-release');
    unlinkSync(context.dirtyPath);
    context.ledger.requestWorkspaceCliAcknowledgment(context.workspace);
    const reconciler = new Reconciler({
      config: context.fixture.config,
      database: context.database,
      ledger: context.ledger,
      outbox: context.outbox,
      providers: context.registry,
      workspaces: context.workspaces,
      projector: context.projector,
      observer: context.observer,
    });

    await reconciler.runPass();

    expect(context.ledger.getLease(context.workspace)?.state).toBe('Released');
    expect(readFileSync(context.note, 'utf8')).not.toContain('Workspace: Quarantined');
    const actionLine = readFileSync(context.note, 'utf8')
      .split('\n')
      .find((line) => line.includes(`data-spool-event="${context.eventKey}"`));
    expect(actionLine).toContain('- [x]');
    expect(
      context.ledger.listFollowUps(context.job.id).every(({ completedAt }) => completedAt),
    ).toBe(true);
    await reconciler.shutdown();
    context.database.close();
  });

  it('refuses an unsafe CLI request once and allows an explicit retry', async () => {
    const context = await quarantinedAcknowledgmentFixture('cli-request-refusal');
    context.ledger.requestWorkspaceCliAcknowledgment(context.workspace);
    const reconciler = new Reconciler({
      config: context.fixture.config,
      database: context.database,
      ledger: context.ledger,
      outbox: context.outbox,
      providers: context.registry,
      workspaces: context.workspaces,
      projector: context.projector,
      observer: context.observer,
    });

    await reconciler.runPass();

    const refused = parseWorkspaceCliAcknowledgmentRequest(
      context.ledger.getLease(context.workspace)?.disposition ?? null,
    );
    expect(refused).toMatchObject({ phase: 'refused' });
    expect(refused?.reason).toContain('not clean');
    await reconciler.runPass();
    expect(
      parseWorkspaceCliAcknowledgmentRequest(
        context.ledger.getLease(context.workspace)?.disposition ?? null,
      ),
    ).toEqual(refused);

    unlinkSync(context.dirtyPath);
    context.ledger.requestWorkspaceCliAcknowledgment(context.workspace);
    await reconciler.runPass();

    expect(context.ledger.getLease(context.workspace)?.state).toBe('Released');
    await reconciler.shutdown();
    context.database.close();
  });

  it('ignores a sole workspace action marker moved to a different watched note', async () => {
    const context = await quarantinedAcknowledgmentFixture('moved-workspace-action');
    const copiedNote = path.join(context.fixture.vault, 'Copied.md');
    const source = readFileSync(context.note, 'utf8');
    const actionLine = source
      .split('\n')
      .find((line) => line.includes(`data-spool-event="${context.eventKey}"`));
    if (!actionLine) throw new Error('Expected generated workspace action');
    writeFileSync(context.note, source.replace(`${actionLine}\n`, ''));
    writeFileSync(copiedNote, `${actionLine.replace('- [ ]', '- [x]')}\n`);

    const reconciler = new Reconciler({
      config: context.fixture.config,
      database: context.database,
      ledger: context.ledger,
      outbox: context.outbox,
      providers: context.registry,
      workspaces: context.workspaces,
      projector: context.projector,
      observer: context.observer,
    });
    await reconciler.runPass();

    expect(context.ledger.getLease(context.workspace)?.state).toBe('Quarantined');
    expect(context.ledger.listFollowUps(context.job.id)).toEqual([
      expect.objectContaining({ eventKey: context.eventKey, completedAt: null }),
    ]);
    await reconciler.shutdown();
    context.database.close();
  });

  it('requires a fresh disclosed action before a legacy check can switch branches', async () => {
    const context = await quarantinedAcknowledgmentFixture('legacy-workspace-action');
    unlinkSync(context.dirtyPath);
    git(context.workspace, ['checkout', '-b', 'human-reviewed']);
    checkWorkspaceAction(context.note, context.eventKey);
    const reconciler = new Reconciler({
      config: context.fixture.config,
      database: context.database,
      ledger: context.ledger,
      outbox: context.outbox,
      providers: context.registry,
      workspaces: context.workspaces,
      projector: context.projector,
      observer: context.observer,
    });

    await reconciler.runPass();

    expect(git(context.workspace, ['branch', '--show-current'])).toBe('human-reviewed');
    expect(context.ledger.getLease(context.workspace)?.state).toBe('Quarantined');
    const actions = context.ledger.listFollowUps(context.job.id);
    expect(actions).toHaveLength(2);
    expect(actions[1]).toMatchObject({ completedAt: null });
    expect(actions[1]?.text).toContain(
      'checking this action will attempt to return the clone to captured branch main',
    );
    await reconciler.shutdown();
    context.database.close();
  });

  it('isolates malformed lease metadata while reconciling a checked action', async () => {
    const context = await quarantinedAcknowledgmentFixture('malformed-workspace-lease');
    checkWorkspaceAction(context.note, context.eventKey);
    context.database.raw
      .prepare('UPDATE workspace_leases SET lease_metadata_json = ? WHERE canonical_workspace = ?')
      .run(JSON.stringify({ version: 2 }), context.workspace);
    const reconciler = new Reconciler({
      config: context.fixture.config,
      database: context.database,
      ledger: context.ledger,
      outbox: context.outbox,
      providers: context.registry,
      workspaces: context.workspaces,
      projector: context.projector,
      observer: context.observer,
    });

    await expect(reconciler.runPass()).resolves.toBeDefined();

    expect(context.ledger.getLease(context.workspace)?.state).toBe('Quarantined');
    expect(context.ledger.listFollowUps(context.job.id)).toHaveLength(2);
    expect(context.ledger.listFollowUps(context.job.id).at(-1)?.completedAt).toBeNull();
    await reconciler.shutdown();
    context.database.close();
  });

  it('resolves a stale checked action after the stopped-daemon CLI released its lease', async () => {
    const context = await quarantinedAcknowledgmentFixture('cli-released-action');
    unlinkSync(context.dirtyPath);
    await expect(context.workspaces.acknowledge(context.workspace)).resolves.toMatchObject({
      kind: 'released',
    });
    checkWorkspaceAction(context.note, context.eventKey);

    const reconciler = new Reconciler({
      config: context.fixture.config,
      database: context.database,
      ledger: context.ledger,
      outbox: context.outbox,
      providers: context.registry,
      workspaces: context.workspaces,
      projector: context.projector,
      observer: context.observer,
    });
    await reconciler.runPass();

    const actions = context.ledger.listFollowUps(context.job.id);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.eventKey).toBe(context.eventKey);
    expect(actions[0]?.completedAt).not.toBeNull();
    expect(readFileSync(context.note, 'utf8')).not.toContain('Workspace: Quarantined');
    await reconciler.shutdown();
    context.database.close();
  });
});

async function quarantinedAcknowledgmentFixture(taskId: string) {
  const fixture = schedulerFixture(1);
  fixture.config.repositories[0]!.clones = fixture.clones.map((clone) => realpathSync(clone));
  const note = path.join(fixture.vault, 'Week 29 of 2026.md');
  writeFileSync(note, trackedTask(taskId));
  const database = openLedgerDatabase(fixture.state);
  const ledger = new LedgerRepository(database);
  const outbox = new OutboxRepository(database);
  const provider = new FakeProvider({ executable: process.execPath });
  const registry = new ProviderRegistry([provider]);
  const projector = new NoteProjector({ config: fixture.config, ledger, outbox, now });
  const observer = new AttemptObserver({ config: fixture.config, ledger, projector, now });
  const workspaces = new WorkspacePool({ repositories: fixture.config.repositories, ledger });
  const job = ledger.claimJob({
    sourceMarker: taskId,
    sourcePath: note,
    provider: 'fake',
    directive: 'Review',
    context: 'Repository (direct): example/widget',
    repository: 'example/widget',
  });
  ledger.transitionJob(job.id, 'Working');
  const attempt = ledger.prepareAttempt(job.id, path.join(fixture.state, 'logs', `${taskId}.log`));
  const acquired = await workspaces.acquire({
    repository: 'example/widget',
    jobId: job.id,
    attemptId: attempt.id,
  });
  if (acquired.kind !== 'acquired') throw new Error('Expected workspace acquisition');
  const workspace = acquired.handle.canonicalWorkspace;
  const dirtyPath = path.join(workspace, 'agent-left.txt');
  writeFileSync(dirtyPath, 'preserve');
  const disposition = await workspaces.reconcileDisposition(acquired.handle);
  if (disposition.kind !== 'quarantined') throw new Error('Expected workspace quarantine');
  ledger.transitionAttempt(attempt.id, 'Terminal');
  ledger.transitionJob(job.id, 'Completed');
  const eventKey = `workspace-ack:${attempt.id}:0`;
  const text = `Inspect quarantined workspace: ${disposition.detail.summary}`;
  ledger.recordFollowUp(job.id, eventKey, text);
  projector.enqueueSource(job, `workspace-action:${job.id}:${eventKey}`, {
    kind: 'follow-up',
    taskId: job.sourceMarker,
    eventKey,
    checked: false,
    text,
  });
  observer.enqueueReceipt(
    job.id,
    provider,
    `quarantine:${eventKey}`,
    undefined,
    disposition.detail.summary,
  );
  await projector.deliver('fixture-writer');
  return {
    fixture,
    note,
    database,
    ledger,
    outbox,
    provider,
    registry,
    projector,
    observer,
    workspaces,
    job,
    attempt,
    workspace,
    dirtyPath,
    eventKey,
  };
}

function checkWorkspaceAction(note: string, eventKey: string): void {
  const source = readFileSync(note, 'utf8');
  const actionLine = source
    .split('\n')
    .find((line) => line.includes(`data-spool-event="${eventKey}"`));
  if (!actionLine) throw new Error('Expected generated workspace action');
  writeFileSync(note, source.replace(actionLine, actionLine.replace('- [ ]', '- [x]')));
}

function schedulerFixture(cloneCount: number): {
  root: string;
  vault: string;
  state: string;
  clones: string[];
  config: SpoolConfig;
} {
  const root = mkdtempSync(path.join(tmpdir(), 'spool-queue-'));
  const vault = path.join(root, 'vault');
  const state = path.join(root, 'state');
  mkdirSync(vault);
  mkdirSync(state);
  const clones = Array.from({ length: cloneCount }, (_, index) => {
    const clone = path.join(root, `clone-${String(index + 1)}`);
    mkdirSync(clone);
    git(clone, ['init']);
    git(clone, ['config', 'user.email', 'fixture@example.com']);
    git(clone, ['config', 'user.name', 'Fixture']);
    writeFileSync(path.join(clone, 'tracked.txt'), 'fixture\n');
    git(clone, ['add', 'tracked.txt']);
    git(clone, ['commit', '-m', 'fixture']);
    git(clone, ['remote', 'add', 'origin', 'git@github.com:example/widget.git']);
    return clone;
  });
  return {
    root,
    vault,
    state,
    clones,
    config: {
      configPath: path.join(root, 'spool.config.yaml'),
      vaults: [vault],
      stateDirectory: state,
      timeZone: 'Europe/Istanbul',
      pollIntervalSeconds: 45,
      dayAliases: { saturday: ['Saturday'] },
      providers: [
        {
          name: 'fake',
          enabled: true,
          executable: process.execPath,
          executableResolved: true,
          directive: '@fake',
          defaultArgs: [],
        },
      ],
      repositories: [{ repository: 'example/widget', clones }],
    },
  };
}

function trackedTask(taskId: string): string {
  const anchor = receiptAnchorFor(taskId);
  return [
    '## Saturday',
    '',
    '- PR https://github.com/example/widget/pull/1',
    '  - [ ] @fake Review',
    '    ```spool',
    `    Task: ${taskId}`,
    `    Anchor: ${anchor}`,
    '    ```',
    '',
  ].join('\n');
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function sequentialIds(prefix: string): () => string {
  let next = 0;
  return () => `${prefix}-${String(++next)}`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for scheduler state');
    await delay(10);
  }
}

function waitCancelProvider(): ProviderAdapter {
  const fake = new FakeProvider({ executable: process.execPath });
  return {
    name: fake.name,
    capabilities: fake.capabilities,
    sessionIdPolicy: fake.sessionIdPolicy,
    createLaunch: (input) => fake.createLaunch({ ...input, scenario: 'wait-cancel' }),
    parseEvent: (value) => fake.parseEvent(value),
    inspectCommand: (sessionId) => fake.inspectCommand(sessionId),
    resumeCommand: (sessionId) => fake.resumeCommand(sessionId),
    cancelCommand: (sessionId) => fake.cancelCommand(sessionId),
  };
}

function completedResult(
  logPath: string,
  sessionId: string,
  output: string,
  sequence: number,
): ProviderRunResult {
  return {
    launchState: 'started',
    processIdentity: {
      pid: 10_000 + sequence,
      processStartIdentity: `fixture-${String(sequence)}`,
    },
    terminalState: 'completed',
    observation: {
      sessionId,
      state: 'completed',
      latestOutput: { text: output, hash: `hash-${String(sequence)}` },
      terminalProof: { state: 'completed', proof: `proof-${String(sequence)}` },
      events: [],
    },
    exit: { code: 0, signal: null },
    diagnostics: [],
    cancelRequested: false,
    timedOut: false,
    log: { path: logPath, bytesWritten: 0, truncated: false },
  };
}
