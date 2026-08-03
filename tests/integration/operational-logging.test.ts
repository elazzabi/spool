import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SpoolConfig } from '../../src/config/schema.js';
import { parseOperationalEvent, type OperationalEvent } from '../../src/logging/events.js';
import { OPERATIONAL_ACTIVE_FILE, OPERATIONAL_LOG_DIRECTORY } from '../../src/logging/store.js';
import { FakeProvider } from '../../src/providers/fake.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { MarkdownNoteScanner } from '../../src/scheduler/scanner.js';
import { openSpoolRuntime, runUntilConverged } from '../../src/scheduler/service.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('owned runtime operational logging', () => {
  it('records safe ordered job, workspace, provider, and runtime events across restart', async () => {
    const fixture = runtimeFixture();
    const noteCanary = 'PRIVATE_NOTE_CANARY';
    writeFileSync(
      path.join(fixture.vault, 'Week 29 of 2026.md'),
      `## Saturday\n\n- [ ] Review ${noteCanary} https://github.com/example/widget/pull/1 @fake\n`,
    );
    const providers = new ProviderRegistry([new FakeProvider({ executable: process.execPath })]);
    const runtime = await openSpoolRuntime(fixture.config, {
      providers,
      mode: 'run-once',
    });

    await runUntilConverged(runtime.reconciler);
    expect(runtime.ledger.listJobs()).toHaveLength(1);
    expect(runtime.ledger.listJobs()[0]?.state).toBe('Completed');
    const jobId = runtime.ledger.listJobs()[0]!.id;
    const attemptId = runtime.ledger.listAttempts(jobId)[0]!.id;
    await runtime.close();

    const firstRecords = operationalRecords(fixture.state);
    const types = firstRecords.map((record) => record.type);
    expect(types[0]).toBe('runtime.started');
    expect(types).toContain('job.claimed');
    expect(types).toContain('workspace.acquired');
    expect(types).toContain('provider.launched');
    expect(types).toContain('provider.terminal');
    expect(types).toContain('workspace.released');
    expect(types).toContain('reconciliation.completed');
    expect(types.at(-1)).toBe('runtime.stopped');
    expect(firstRecords).toContainEqual(expect.objectContaining({ type: 'job.claimed', jobId }));
    expect(firstRecords).toContainEqual(
      expect.objectContaining({ type: 'provider.terminal', attemptId, outcome: 'completed' }),
    );

    const encoded = operationalText(fixture.state);
    for (const forbidden of [
      noteCanary,
      fixture.root,
      fixture.vault,
      fixture.clone,
      'example/widget',
      'fake-complete',
      'Review complete.',
    ]) {
      expect(encoded).not.toContain(forbidden);
    }

    const daemonRuntime = await openSpoolRuntime(fixture.config, {
      providers,
      mode: 'daemon',
    });
    await daemonRuntime.reconciler.runPass();
    await daemonRuntime.close();
    const starts = operationalRecords(fixture.state).filter(
      (record): record is Extract<OperationalEvent, { type: 'runtime.started' }> =>
        record.type === 'runtime.started',
    );
    expect(starts.map((record) => record.mode)).toEqual(['run-once', 'daemon']);
    expect(new Set(starts.map((record) => record.runtimeId))).toHaveLength(2);
  });

  it('does not activate or mutate operational history when ownership acquisition fails', async () => {
    const fixture = runtimeFixture();
    const providers = new ProviderRegistry([]);
    const owner = await openSpoolRuntime(fixture.config, { providers, mode: 'daemon' });
    await owner.reconciler.runPass();
    await vi.waitFor(() =>
      expect(operationalText(fixture.state)).toContain('reconciliation.completed'),
    );
    const before = operationalText(fixture.state);
    const contender = await openSpoolRuntime(fixture.config, { providers, mode: 'run-once' });

    await expect(contender.reconciler.runPass()).rejects.toThrow(/daemon owns/i);
    await contender.close('failed');
    expect(operationalText(fixture.state)).toBe(before);

    await owner.close();
  });

  it('coalesces repeated quiet passes until the hourly heartbeat is due', async () => {
    const fixture = runtimeFixture();
    let now = Date.parse('2026-07-20T00:00:00.000Z');
    const runtime = await openSpoolRuntime(fixture.config, {
      providers: new ProviderRegistry([]),
      mode: 'daemon',
      now: () => new Date(now),
    });

    await runtime.reconciler.runPass();
    await vi.waitFor(() =>
      expect(
        operationalRecords(fixture.state).filter(
          (record) => record.type === 'reconciliation.completed',
        ),
      ).toHaveLength(1),
    );
    now += 30 * 60 * 1_000;
    await runtime.reconciler.runPass();
    now += 30 * 60 * 1_000;
    await runtime.reconciler.runPass();
    await runtime.close();

    expect(
      operationalRecords(fixture.state).filter(
        (record) => record.type === 'reconciliation.completed',
      ),
    ).toHaveLength(2);
  });

  it('persists a bounded failure code without leaking the thrown path', async () => {
    const fixture = runtimeFixture();
    const providers = new ProviderRegistry([]);
    const pathCanary = path.join(fixture.root, 'PRIVATE_ERROR_CANARY');
    const scan = vi
      .spyOn(MarkdownNoteScanner.prototype, 'scan')
      .mockRejectedValueOnce(new Error(pathCanary));
    const runtime = await openSpoolRuntime(fixture.config, { providers, mode: 'run-once' });

    await expect(runtime.reconciler.runPass()).rejects.toThrow();
    scan.mockRestore();
    await runtime.close('failed');

    const records = operationalRecords(fixture.state);
    expect(records).toContainEqual(
      expect.objectContaining({
        type: 'reconciliation.failed',
        severity: 'error',
        reason: 'internal_error',
      }),
    );
    expect(records.at(-1)).toEqual(
      expect.objectContaining({ type: 'runtime.stopped', outcome: 'failed' }),
    );
    expect(operationalText(fixture.state)).not.toContain(pathCanary);
  });
});

function runtimeFixture(): {
  root: string;
  vault: string;
  state: string;
  clone: string;
  config: SpoolConfig;
} {
  const root = realpathSync(mkdtempSync(path.join(realpathSync(tmpdir()), 'spool-operational-')));
  roots.push(root);
  const vault = path.join(root, 'vault');
  const state = path.join(root, 'state');
  const clone = path.join(root, 'clone');
  mkdirSync(vault);
  mkdirSync(state, { mode: 0o700 });
  mkdirSync(clone);
  git(clone, ['init']);
  git(clone, ['config', 'user.email', 'fixture@example.com']);
  git(clone, ['config', 'user.name', 'Fixture']);
  writeFileSync(path.join(clone, 'tracked.txt'), 'fixture\n');
  git(clone, ['add', 'tracked.txt']);
  git(clone, ['commit', '-m', 'fixture']);
  git(clone, ['remote', 'add', 'origin', 'git@github.com:example/widget.git']);
  return {
    root,
    vault,
    state,
    clone,
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
      repositories: [{ repository: 'example/widget', clones: [clone] }],
    },
  };
}

function operationalRecords(state: string): OperationalEvent[] {
  const directory = path.join(state, OPERATIONAL_LOG_DIRECTORY);
  return operationalSegmentNames(directory).flatMap((name) =>
    readFileSync(path.join(directory, name), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => parseOperationalEvent(JSON.parse(line))),
  );
}

function operationalText(state: string): string {
  const directory = path.join(state, OPERATIONAL_LOG_DIRECTORY);
  return operationalSegmentNames(directory)
    .map((name) => readFileSync(path.join(directory, name), 'utf8'))
    .join('');
}

function operationalSegmentNames(directory: string): string[] {
  return readdirSync(directory)
    .filter((name) => name === OPERATIONAL_ACTIVE_FILE || /^operations-\d{12}\.jsonl$/u.test(name))
    .sort((left, right) => {
      if (left === OPERATIONAL_ACTIVE_FILE) return 1;
      if (right === OPERATIONAL_ACTIVE_FILE) return -1;
      return left.localeCompare(right);
    });
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
