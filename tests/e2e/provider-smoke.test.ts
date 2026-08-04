import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { openLedgerDatabase } from '../../src/ledger/database.js';
import { LedgerRepository } from '../../src/ledger/repositories.js';
import {
  OPERATIONAL_ACTIVE_FILE,
  OPERATIONAL_LOG_DIRECTORY,
  OperationalLogStore,
} from '../../src/logging/store.js';
import { pruneTerminalAttemptLogs } from '../../src/providers/log-retention.js';

interface SmokeModule {
  readonly hasCompletedTaskReceipt: (source: string, provider: string) => boolean;
  readonly assertPiSmokeEvidence: (input: {
    readonly launchArgv: readonly string[];
    readonly inspectArgs: readonly string[];
    readonly sessionId: string;
    readonly stateDirectory: string;
    readonly workspaceDirectories: readonly string[];
  }) => void;
  readonly parseProviderWaiver: (value: string) => ReadonlySet<string>;
  readonly selectSmokeProviders: (waiver: ReadonlySet<string>) => string[];
}

const smokeModule = (await import(
  // @ts-expect-error The shipped smoke executable is intentionally plain JavaScript.
  '../../scripts/smoke-providers.mjs'
)) as SmokeModule;
const {
  assertPiSmokeEvidence,
  hasCompletedTaskReceipt,
  parseProviderWaiver,
  selectSmokeProviders,
} = smokeModule;

describe('provider smoke safety boundaries', () => {
  it('recognizes completed fenced receipts for the requested provider task', () => {
    const note = [
      '- [x] @cursor Read the local marker.',
      '  ```spool',
      '  Task: cursor-task',
      '  Status: Completed',
      '  ```',
      '- [ ] @codex Still pending.',
      '  ```spool',
      '  Task: codex-task',
      '  Status: Queued',
      '  ```',
    ].join('\n');

    expect(hasCompletedTaskReceipt(note, 'cursor')).toBe(true);
    expect(hasCompletedTaskReceipt(note, 'codex')).toBe(false);

    const laterProviderCompleted = [
      '- [ ] @cursor Read the local marker.',
      '  ```spool',
      '  Task: cursor-task',
      '  Status: Queued',
      '  ```',
      '- [x] @codex Read the local marker.',
      '  ```spool',
      '  Task: codex-task',
      '  Status: Completed',
      '  ```',
    ].join('\n');

    expect(hasCompletedTaskReceipt(laterProviderCompleted, 'cursor')).toBe(false);
    expect(hasCompletedTaskReceipt(laterProviderCompleted, 'codex')).toBe(true);
  });

  it('requires Pi by default and permits only an explicit pre-launch Pi waiver', () => {
    expect(selectSmokeProviders(parseProviderWaiver(''))).toEqual([
      'claude',
      'codex',
      'cursor',
      'pi',
    ]);
    expect(selectSmokeProviders(parseProviderWaiver('pi'))).toEqual(['claude', 'codex', 'cursor']);
    expect([...parseProviderWaiver('pi,PI,pi')]).toEqual(['pi']);
    expect(() => parseProviderWaiver('unknown')).toThrow('Unknown provider waiver: unknown');
    expect(() => selectSmokeProviders(parseProviderWaiver('claude,codex,cursor,pi'))).toThrow(
      'Every provider was waived',
    );
  });

  it('proves the Pi launch, inspect, and owner-private managed-session contract', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'spool-pi-smoke-contract-'));
    const state = path.join(root, 'state');
    const sessions = path.join(state, 'pi', 'sessions');
    const workspace = path.join(root, 'workspace');
    mkdirSync(sessions, { recursive: true, mode: 0o700 });
    chmodSync(state, 0o700);
    chmodSync(path.join(state, 'pi'), 0o700);
    chmodSync(sessions, 0o700);
    mkdirSync(workspace);
    const canonicalSessions = realpathSync(sessions);
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const safeArgs = [
      '--offline',
      '--tools',
      'read,grep,find,ls',
      '--no-extensions',
      '--no-context-files',
      '--no-skills',
      '--no-prompt-templates',
    ];

    expect(() =>
      assertPiSmokeEvidence({
        launchArgv: [...safeArgs, '--session-dir', canonicalSessions],
        inspectArgs: [...safeArgs, '--session-dir', canonicalSessions, '--session', sessionId],
        sessionId,
        stateDirectory: state,
        workspaceDirectories: [workspace],
      }),
    ).toThrow('JSON mode');

    expect(() =>
      assertPiSmokeEvidence({
        launchArgv: [...safeArgs, '--session-dir', canonicalSessions, '--mode', 'json'],
        inspectArgs: [...safeArgs, '--session-dir', canonicalSessions, '--session', sessionId],
        sessionId,
        stateDirectory: state,
        workspaceDirectories: [workspace],
      }),
    ).not.toThrow();

    chmodSync(sessions, 0o755);
    expect(() =>
      assertPiSmokeEvidence({
        launchArgv: [...safeArgs, '--session-dir', canonicalSessions, '--mode', 'json'],
        inspectArgs: [...safeArgs, '--session-dir', canonicalSessions, '--session', sessionId],
        sessionId,
        stateDirectory: state,
        workspaceDirectories: [workspace],
      }),
    ).toThrow('owner-private');
  });

  it('retains active and unsafe evidence while pruning only old fully terminal logs', async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'spool-retention-')));
    const state = path.join(root, 'state');
    mkdirSync(state);
    const database = openLedgerDatabase(state);
    const logs = path.join(state, 'logs');
    const outside = path.join(root, 'outside.log');
    writeFileSync(outside, 'outside evidence\n', { mode: 0o600 });
    const oldNow = () => new Date('2026-01-01T00:00:00.000Z');
    const ledger = new LedgerRepository(database, { now: oldNow });

    const eligible = terminalFixture(ledger, path.join(logs, 'eligible.log'), 'eligible');
    const active = ledger.claimJob({
      sourceMarker: 'active',
      sourcePath: '/fixture/Week 1 of 2026.md',
      provider: 'fake',
      directive: 'active',
      context: 'active',
    });
    const activeLog = path.join(logs, 'active.log');
    writeFileSync(activeLog, 'active evidence\n', { mode: 0o600 });
    const activeAttempt = ledger.prepareAttempt(active.id, activeLog);
    ledger.transitionAttempt(activeAttempt.id, 'Launching');
    ledger.markAttemptUncertain(activeAttempt.id, 'fixture uncertainty');
    ledger.transitionJob(active.id, 'Working');

    const nonterminalJob = ledger.claimJob({
      sourceMarker: 'nonterminal-job',
      sourcePath: '/fixture/Week 1 of 2026.md',
      provider: 'fake',
      directive: 'nonterminal',
      context: 'nonterminal',
    });
    const nonterminalLog = path.join(logs, 'nonterminal.log');
    writeFileSync(nonterminalLog, 'keep until job terminal\n', { mode: 0o600 });
    const nonterminalAttempt = ledger.prepareAttempt(nonterminalJob.id, nonterminalLog);
    ledger.transitionAttempt(nonterminalAttempt.id, 'Terminal');
    ledger.transitionJob(nonterminalJob.id, 'Working');

    const unsafe = terminalFixture(ledger, outside, 'unsafe');
    const linkPath = path.join(logs, 'linked.log');
    symlinkSync(outside, linkPath);
    const linked = terminalFixture(ledger, linkPath, 'linked');
    const freshLedger = new LedgerRepository(database, {
      now: () => new Date('2026-07-18T00:00:00.000Z'),
    });
    const fresh = terminalFixture(freshLedger, path.join(logs, 'fresh.log'), 'fresh');
    const operational = new OperationalLogStore({
      stateDirectory: state,
      runtimeId: '10000000-0000-4000-8000-000000000000',
      mode: 'run-once',
    });
    expect(await operational.activate()).toBe(true);
    expect(await operational.runtimeStarted()).toBe(true);
    await operational.close();

    const result = await pruneTerminalAttemptLogs({
      stateDirectory: state,
      ledger,
      olderThan: new Date('2026-06-01T00:00:00.000Z'),
    });

    expect(result.removed).toEqual([
      path.join(realpathSync(path.dirname(eligible)), path.basename(eligible)),
    ]);
    expect(result.skippedUnsafe).toEqual(expect.arrayContaining([unsafe, linked]));
    expect(() => readFileSync(eligible, 'utf8')).toThrow();
    expect(readFileSync(activeLog, 'utf8')).toContain('active evidence');
    expect(readFileSync(nonterminalLog, 'utf8')).toContain('keep until job terminal');
    expect(readFileSync(outside, 'utf8')).toContain('outside evidence');
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(fresh, 'utf8')).toContain('fresh evidence');
    const operationalDirectory = path.join(state, OPERATIONAL_LOG_DIRECTORY);
    expect(readdirSync(operationalDirectory)).toContain(OPERATIONAL_ACTIVE_FILE);
    expect(
      readFileSync(path.join(operationalDirectory, OPERATIONAL_ACTIVE_FILE), 'utf8'),
    ).toContain('runtime.started');
    expect(lstatSync(state).mode & 0o777).toBe(0o700);
    expect(lstatSync(path.join(state, 'spool.sqlite')).mode & 0o777).toBe(0o600);

    const refused = terminalFixture(ledger, path.join(logs, 'unlink-refused.log'), 'refused');
    chmodSync(logs, 0o500);
    try {
      const refusedResult = await pruneTerminalAttemptLogs({
        stateDirectory: state,
        ledger,
        olderThan: new Date('2026-06-01T00:00:00.000Z'),
      });
      expect(refusedResult.skippedUnsafe).toContain(refused);
      expect(readFileSync(refused, 'utf8')).toContain('refused evidence');
    } finally {
      chmodSync(logs, 0o700);
    }

    database.close();
  });
});

function terminalFixture(ledger: LedgerRepository, logPath: string, marker: string): string {
  if (!lstatExists(logPath)) writeFileSync(logPath, `${marker} evidence\n`, { mode: 0o600 });
  else if (!lstatSync(logPath).isSymbolicLink()) chmodSync(logPath, 0o600);
  const job = ledger.claimJob({
    sourceMarker: marker,
    sourcePath: '/fixture/Week 1 of 2026.md',
    provider: 'fake',
    directive: marker,
    context: marker,
  });
  const attempt = ledger.prepareAttempt(job.id, logPath);
  ledger.transitionAttempt(attempt.id, 'Terminal');
  ledger.transitionJob(job.id, 'Working');
  ledger.transitionJob(job.id, 'Completed');
  return logPath;
}

function lstatExists(value: string): boolean {
  try {
    lstatSync(value);
    return true;
  } catch {
    return false;
  }
}
