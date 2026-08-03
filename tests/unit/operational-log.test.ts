import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  MAX_OPERATIONAL_RECORD_BYTES,
  OPERATIONAL_EVENT_VERSION,
  parseOperationalEvent,
  serializeOperationalEvent,
  type OperationalEvent,
} from '../../src/logging/events.js';
import {
  followOperationalLogs,
  formatOperationalEvent,
  OPERATIONAL_FOLLOW_INITIAL_RECORDS,
  OPERATIONAL_LOG_UNSAFE_ERROR,
  readOperationalLogs,
} from '../../src/logging/reader.js';
import {
  OPERATIONAL_ACTIVE_FILE,
  OPERATIONAL_LOG_DIRECTORY,
  OPERATIONAL_LOG_FAILURE_WARNING,
  OPERATIONAL_MAX_QUEUED_RECORDS,
  OPERATIONAL_MAX_SEGMENTS,
  OPERATIONAL_RETENTION_MS,
  OPERATIONAL_ROTATE_AFTER_MS,
  OperationalLogStore,
  writeOperationalBufferFully,
} from '../../src/logging/store.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('operational event contract', () => {
  it('rejects unknown fields, uncontrolled strings, controls, and oversized records', () => {
    const base = {
      version: 1,
      eventId: randomUUID(),
      timestamp: new Date().toISOString(),
      runtimeId: randomUUID(),
      type: 'job.claimed',
      severity: 'info',
      jobId: randomUUID(),
      provider: 'codex',
    };

    expect(parseOperationalEvent(base)).toEqual(base);
    expect(() => parseOperationalEvent({ ...base, note: 'private note canary' })).toThrow();
    expect(() => parseOperationalEvent({ ...base, provider: 'codex\nforged' })).toThrow();
    expect(() => parseOperationalEvent({ ...base, provider: '\u001b]0;secret\u0007' })).toThrow();
    expect(() => parseOperationalEvent({ ...base, severity: 'debug' })).toThrow();

    const oversized = {
      ...base,
      provider: `p${'x'.repeat(MAX_OPERATIONAL_RECORD_BYTES)}`,
    } as OperationalEvent;
    expect(() => serializeOperationalEvent(oversized)).toThrow();
  });
});

describe('operational log store', () => {
  it('retries short writes until the complete record is accepted', async () => {
    const written: Buffer[] = [];

    await writeOperationalBufferFully((remaining) => {
      const bytesWritten = Math.min(3, remaining.byteLength);
      written.push(Buffer.from(remaining.subarray(0, bytesWritten)));
      return Promise.resolve({ bytesWritten });
    }, Buffer.from('complete-record'));

    expect(Buffer.concat(written).toString('utf8')).toBe('complete-record');
    await expect(
      writeOperationalBufferFully(
        () => Promise.resolve({ bytesWritten: 0 }),
        Buffer.from('stalled'),
      ),
    ).rejects.toThrow(/no progress/u);
  });

  it('persists every supported event variant as strict JSON Lines in invocation order', async () => {
    const state = fixtureState();
    const runtimeId = randomUUID();
    const jobId = randomUUID();
    const attemptId = randomUUID();
    const store = new OperationalLogStore({ stateDirectory: state, runtimeId, mode: 'run-once' });

    expect(await store.activate()).toBe(true);
    const writes = [
      store.runtimeStarted(),
      store.jobClaimed(jobId, 'codex'),
      store.reconciliationCompleted({
        claimedJobs: 1,
        launchedJobs: 1,
        waitingJobs: 0,
        projected: 2,
        blockedProjections: 0,
      }),
      store.dispatchWaiting(jobId, 'workspace_capacity'),
      store.workspaceAcquired(jobId, attemptId),
      store.providerLaunched(jobId, attemptId, 'codex'),
      store.workspaceQuarantined(jobId, attemptId, 'changed_before_spawn'),
      store.workspaceReleased(jobId, attemptId),
      store.providerTerminal(jobId, attemptId, 'codex', 'completed'),
      store.reconciliationFailed(),
      store.runtimeStopped('clean'),
    ];
    await expect(Promise.all(writes)).resolves.toEqual(Array(writes.length).fill(true));
    await store.close();

    const records = activeRecords(state);
    expect(records.map((record) => record.type)).toEqual([
      'runtime.started',
      'job.claimed',
      'reconciliation.completed',
      'dispatch.waiting',
      'workspace.acquired',
      'provider.launched',
      'workspace.quarantined',
      'workspace.released',
      'provider.terminal',
      'reconciliation.failed',
      'runtime.stopped',
    ]);
    expect(new Set(records.map((record) => record.eventId))).toHaveLength(records.length);
    expect(records.every((record) => record.runtimeId === runtimeId)).toBe(true);
    expect(
      readFileSync(activePath(state), 'utf8')
        .trimEnd()
        .split('\n')
        .every((line) => Buffer.byteLength(`${line}\n`) <= MAX_OPERATIONAL_RECORD_BYTES),
    ).toBe(true);
  });

  it('creates owner-private storage and rotates a prior active segment at activation', async () => {
    const state = fixtureState();
    const directory = operationalDirectory(state);
    mkdirSync(directory, { mode: 0o700 });
    writeFileSync(activePath(state), '{"prior":true}\n', { mode: 0o600 });
    const store = new OperationalLogStore({
      stateDirectory: state,
      runtimeId: randomUUID(),
      mode: 'daemon',
    });

    expect(await store.activate()).toBe(true);
    await store.runtimeStarted();
    await store.close();

    const names = readdirSync(directory).sort();
    expect(names).toEqual(['operations-000000000001.jsonl', OPERATIONAL_ACTIVE_FILE]);
    if (process.platform !== 'win32') {
      expect(lstatSync(directory).mode & 0o777).toBe(0o700);
      for (const name of names)
        expect(lstatSync(path.join(directory, name)).mode & 0o777).toBe(0o600);
    }
  });

  it('prunes an expired prior active segment after rotating it at activation', async () => {
    const state = fixtureState();
    const directory = operationalDirectory(state);
    const now = Date.parse('2026-07-20T00:00:00.000Z');
    mkdirSync(directory, { mode: 0o700 });
    writeFileSync(activePath(state), '{}\n', { mode: 0o600 });
    const old = new Date(now - OPERATIONAL_RETENTION_MS - 1);
    utimesSync(activePath(state), old, old);
    const store = new OperationalLogStore({
      stateDirectory: state,
      runtimeId: randomUUID(),
      mode: 'daemon',
      now: () => new Date(now),
    });

    expect(await store.activate()).toBe(true);
    await store.close();

    expect(readdirSync(directory)).toEqual([OPERATIONAL_ACTIVE_FILE]);
  });

  it('rotates on the 24-hour boundary and retains physical record order', async () => {
    const state = fixtureState();
    let now = Date.parse('2026-07-20T00:00:00.000Z');
    const store = new OperationalLogStore({
      stateDirectory: state,
      runtimeId: randomUUID(),
      mode: 'daemon',
      now: () => new Date(now),
    });
    expect(await store.activate()).toBe(true);
    expect(await store.runtimeStarted()).toBe(true);
    now += OPERATIONAL_ROTATE_AFTER_MS;
    expect(
      await store.reconciliationCompleted({
        claimedJobs: 0,
        launchedJobs: 0,
        waitingJobs: 0,
        projected: 0,
        blockedProjections: 0,
      }),
    ).toBe(true);
    await store.close();

    const directory = operationalDirectory(state);
    const archive = readdirSync(directory).find((name) => /^operations-\d{12}\.jsonl$/u.test(name));
    expect(archive).toBeDefined();
    expect(readFileSync(path.join(directory, archive!), 'utf8')).toContain('runtime.started');
    expect(readFileSync(activePath(state), 'utf8')).toContain('reconciliation.completed');
  });

  it('prunes only old canonical archives and keeps the hard eight-segment ceiling', async () => {
    const state = fixtureState();
    const directory = operationalDirectory(state);
    mkdirSync(directory, { mode: 0o700 });
    const now = Date.parse('2026-07-20T00:00:00.000Z');
    for (let generation = 1; generation <= OPERATIONAL_MAX_SEGMENTS - 1; generation += 1) {
      const archive = path.join(
        directory,
        `operations-${String(generation).padStart(12, '0')}.jsonl`,
      );
      writeFileSync(archive, '{}\n', { mode: 0o600 });
      if (generation === 1) {
        const old = new Date(now - OPERATIONAL_RETENTION_MS - 1);
        utimesSync(archive, old, old);
      }
    }
    writeFileSync(activePath(state), '{}\n', { mode: 0o600 });
    const unrelated = path.join(directory, 'attempt-evidence.log');
    writeFileSync(unrelated, 'do not delete', { mode: 0o600 });

    const store = new OperationalLogStore({
      stateDirectory: state,
      runtimeId: randomUUID(),
      mode: 'daemon',
      now: () => new Date(now),
    });
    expect(await store.activate()).toBe(true);
    await store.close();

    const names = readdirSync(directory);
    expect(names).toContain('attempt-evidence.log');
    expect(names).not.toContain('operations-000000000001.jsonl');
    expect(names.filter((name) => name.endsWith('.jsonl'))).toHaveLength(OPERATIONAL_MAX_SEGMENTS);
  });

  it('disables only the sink and reports one constant warning for unsafe or failed storage', async () => {
    const state = fixtureState();
    const directory = operationalDirectory(state);
    const target = path.join(state, 'redirect-target');
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, directory, 'dir');
    const warnings: string[] = [];
    const unsafe = new OperationalLogStore({
      stateDirectory: state,
      runtimeId: randomUUID(),
      mode: 'daemon',
      onWarning: (warning) => warnings.push(warning),
    });

    await expect(unsafe.activate()).resolves.toBe(false);
    await expect(unsafe.runtimeStarted()).resolves.toBe(false);
    await expect(unsafe.close()).resolves.toBeUndefined();
    expect(warnings).toEqual([OPERATIONAL_LOG_FAILURE_WARNING]);

    rmSync(directory);
    const started = new OperationalLogStore({
      stateDirectory: state,
      runtimeId: randomUUID(),
      mode: 'daemon',
      onWarning: (warning) => warnings.push(warning),
    });
    expect(await started.activate()).toBe(true);
    chmodSync(operationalDirectory(state), 0o755);
    expect(await started.runtimeStarted()).toBe(false);
    expect(await started.reconciliationFailed()).toBe(false);
    await started.close();
    expect(warnings).toEqual([OPERATIONAL_LOG_FAILURE_WARNING, OPERATIONAL_LOG_FAILURE_WARNING]);
  });

  it('bounds overload, prefers warning records, and reports aggregate loss', async () => {
    const state = fixtureState();
    const store = new OperationalLogStore({
      stateDirectory: state,
      runtimeId: randomUUID(),
      mode: 'daemon',
    });
    expect(await store.activate()).toBe(true);

    const infoWrites = Array.from({ length: OPERATIONAL_MAX_QUEUED_RECORDS + 1 }, () =>
      store.runtimeStarted(),
    );
    const warningWrite = store.dispatchWaiting(randomUUID(), 'workspace_capacity');
    const results = await Promise.all([...infoWrites, warningWrite]);
    await store.close();

    expect(results.filter((written) => !written)).toHaveLength(2);
    expect(results.at(-1)).toBe(true);
    const records = activeRecords(state);
    expect(records.filter((record) => record.type === 'dispatch.waiting')).toHaveLength(1);
    expect(records.filter((record) => record.type === 'runtime.started')).toHaveLength(
      OPERATIONAL_MAX_QUEUED_RECORDS - 1,
    );
    expect(records).toContainEqual(
      expect.objectContaining({ type: 'logging.records_dropped', count: 2 }),
    );
  }, 30_000);

  it('does not persist forbidden canaries when a producer value fails its grammar', async () => {
    const state = fixtureState();
    const store = new OperationalLogStore({
      stateDirectory: state,
      runtimeId: randomUUID(),
      mode: 'daemon',
    });
    expect(await store.activate()).toBe(true);
    const canaries = [
      '/private/vault/note.md',
      'provider stdout secret',
      '--token=argv-secret',
      'ENV_SECRET=value',
      'session/private-id',
      'Error: arbitrary details',
    ];
    for (const canary of canaries) {
      expect(await store.jobClaimed(randomUUID(), canary)).toBe(false);
    }
    await store.runtimeStarted();
    await store.close();

    const content = readFileSync(activePath(state), 'utf8');
    for (const canary of canaries) expect(content).not.toContain(canary);
  });
});

describe('operational log reader', () => {
  it('returns deterministic empty history without creating or changing state', async () => {
    const state = fixtureState();
    const before = statSync(state);

    await expect(readOperationalLogs(state)).resolves.toEqual({ events: [], warnings: [] });

    expect(readdirSync(state)).toEqual([]);
    expect(statSync(state).mode).toBe(before.mode);
    expect(statSync(state).mtimeMs).toBe(before.mtimeMs);
  });

  it('reads archives numerically and active last in physical record order', async () => {
    const state = fixtureState();
    const directory = operationalDirectory(state);
    mkdirSync(directory, { mode: 0o700 });
    const events = [fixtureEvent(1), fixtureEvent(2), fixtureEvent(3), fixtureEvent(4)];
    writeSegment(directory, 'operations-000000000002.jsonl', [events[1]!]);
    writeSegment(directory, 'operations-000000000001.jsonl', [events[0]!]);
    writeSegment(directory, 'operations-000000000010.jsonl', [events[2]!]);
    writeSegment(directory, OPERATIONAL_ACTIVE_FILE, [events[3]!]);

    const before = readdirSync(directory).map((name) => ({
      name,
      content: readFileSync(path.join(directory, name)),
      modified: statSync(path.join(directory, name)).mtimeMs,
    }));
    const snapshot = await readOperationalLogs(state);

    expect(snapshot.events.map((event) => event.eventId)).toEqual(
      events.map((event) => event.eventId),
    );
    expect(snapshot.warnings).toEqual([]);
    expect(
      readdirSync(directory).map((name) => ({
        name,
        content: readFileSync(path.join(directory, name)),
        modified: statSync(path.join(directory, name)).mtimeMs,
      })),
    ).toEqual(before);
  });

  it('deduplicates IDs and reports malformed, divergent, and partial records without details', async () => {
    const state = fixtureState();
    const directory = operationalDirectory(state);
    mkdirSync(directory, { mode: 0o700 });
    const event = fixtureEvent(1);
    const divergent = { ...event, timestamp: '2026-07-20T00:00:02.000Z' };
    const canary = 'PRIVATE_MALFORMED_CANARY';
    writeFileSync(
      activePath(state),
      [
        JSON.stringify(event),
        JSON.stringify(event),
        JSON.stringify(divergent),
        `{${canary}`,
        JSON.stringify(fixtureEvent(2)).slice(0, 20),
      ].join('\n'),
      { mode: 0o600 },
    );

    const snapshot = await readOperationalLogs(state);

    expect(snapshot.events).toEqual([event]);
    expect(snapshot.warnings).toHaveLength(1);
    expect(snapshot.warnings[0]).toMatch(/4 invalid or duplicate records \(LOGS_INVALID\)/);
    expect(snapshot.warnings[0]).not.toContain(canary);
  });

  it('follows only the last 100 retained events, then new records across rotation', async () => {
    const state = fixtureState();
    const firstStore = new OperationalLogStore({
      stateDirectory: state,
      runtimeId: randomUUID(),
      mode: 'daemon',
    });
    expect(await firstStore.activate()).toBe(true);
    const retainedJobIds = Array.from({ length: OPERATIONAL_FOLLOW_INITIAL_RECORDS + 5 }, () =>
      randomUUID(),
    );
    for (const jobId of retainedJobIds)
      expect(await firstStore.jobClaimed(jobId, 'codex')).toBe(true);
    await firstStore.close();

    const abort = new AbortController();
    const iterator = followOperationalLogs({
      stateDirectory: state,
      signal: abort.signal,
      pollIntervalMs: 10,
    })[Symbol.asyncIterator]();
    const initial: OperationalEvent[] = [];
    for (let index = 0; index < OPERATIONAL_FOLLOW_INITIAL_RECORDS; index += 1) {
      const item = await iterator.next();
      if (!item.done && item.value.kind === 'event') initial.push(item.value.event);
    }
    expect(initial.map((event) => (event.type === 'job.claimed' ? event.jobId : null))).toEqual(
      retainedJobIds.slice(-OPERATIONAL_FOLLOW_INITIAL_RECORDS),
    );

    const newJobId = randomUUID();
    const nextStore = new OperationalLogStore({
      stateDirectory: state,
      runtimeId: randomUUID(),
      mode: 'daemon',
    });
    expect(await nextStore.activate()).toBe(true);
    expect(await nextStore.jobClaimed(newJobId, 'codex')).toBe(true);
    const next = await iterator.next();
    if (next.done || next.value.kind !== 'event') throw new Error('Expected a followed event');
    expect(next.value.event).toMatchObject({ type: 'job.claimed', jobId: newJobId });
    abort.abort();
    await iterator.return?.(undefined);
    await nextStore.close();
  });

  it('waits for operational storage to appear without creating it', async () => {
    const state = fixtureState();
    const abort = new AbortController();
    const iterator = followOperationalLogs({
      stateDirectory: state,
      signal: abort.signal,
      pollIntervalMs: 10,
    })[Symbol.asyncIterator]();
    const pending = iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(readdirSync(state)).toEqual([]);

    const jobId = randomUUID();
    const store = new OperationalLogStore({
      stateDirectory: state,
      runtimeId: randomUUID(),
      mode: 'daemon',
    });
    expect(await store.activate()).toBe(true);
    expect(await store.jobClaimed(jobId, 'codex')).toBe(true);

    const next = await pending;
    if (next.done || next.value.kind !== 'event') throw new Error('Expected a followed event');
    expect(next.value.event).toMatchObject({ type: 'job.claimed', jobId });
    abort.abort();
    await iterator.return?.(undefined);
    await store.close();
  });

  it('defers an active partial line until its newline arrives and aborts promptly', async () => {
    const state = fixtureState();
    const directory = operationalDirectory(state);
    mkdirSync(directory, { mode: 0o700 });
    const encoded = serializeOperationalEvent(fixtureEvent(1)).toString('utf8');
    const split = Math.floor(encoded.length / 2);
    writeFileSync(activePath(state), encoded.slice(0, split), { mode: 0o600 });
    const abort = new AbortController();
    const iterator = followOperationalLogs({
      stateDirectory: state,
      signal: abort.signal,
      pollIntervalMs: 10,
    })[Symbol.asyncIterator]();
    const pending = iterator.next();
    appendFileSync(activePath(state), encoded.slice(split));

    await expect(pending).resolves.toEqual({
      done: false,
      value: { kind: 'event', event: fixtureEvent(1) },
    });
    abort.abort();
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it('refuses unsafe segment links with a constant error', async () => {
    const state = fixtureState();
    const directory = operationalDirectory(state);
    mkdirSync(directory, { mode: 0o700 });
    const target = path.join(state, 'target.jsonl');
    writeFileSync(target, serializeOperationalEvent(fixtureEvent(1)), { mode: 0o600 });
    symlinkSync(target, activePath(state));

    await expect(readOperationalLogs(state)).rejects.toThrow(OPERATIONAL_LOG_UNSAFE_ERROR);
  });

  it('renders every event on one safe line with correlation IDs', () => {
    const event = fixtureEvent(1);
    const rendered = formatOperationalEvent(event);

    expect(rendered).toContain(event.runtimeId);
    expect(rendered).toContain(event.jobId);
    expect(rendered).not.toContain('\r');
    expect(rendered).not.toContain('\n');
    expect(rendered).not.toContain('\u001b');
  });
});

function fixtureState(): string {
  const root = realpathSync(mkdtempSync(path.join(realpathSync(tmpdir()), 'mdspool-operational-')));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function operationalDirectory(state: string): string {
  return path.join(state, OPERATIONAL_LOG_DIRECTORY);
}

function activePath(state: string): string {
  return path.join(operationalDirectory(state), OPERATIONAL_ACTIVE_FILE);
}

function activeRecords(state: string): OperationalEvent[] {
  return readFileSync(activePath(state), 'utf8')
    .trimEnd()
    .split('\n')
    .filter(Boolean)
    .map((line) => parseOperationalEvent(JSON.parse(line) as unknown));
}

function fixtureEvent(sequence: number): Extract<OperationalEvent, { type: 'job.claimed' }> {
  return {
    version: OPERATIONAL_EVENT_VERSION,
    eventId: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    timestamp: `2026-07-20T00:00:${String(sequence).padStart(2, '0')}.000Z`,
    runtimeId: '10000000-0000-4000-8000-000000000000',
    type: 'job.claimed',
    severity: 'info',
    jobId: `20000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    provider: 'codex',
  };
}

function writeSegment(directory: string, name: string, events: OperationalEvent[]): void {
  writeFileSync(
    path.join(directory, name),
    Buffer.concat(events.map((event) => serializeOperationalEvent(event))),
    { mode: 0o600 },
  );
}
