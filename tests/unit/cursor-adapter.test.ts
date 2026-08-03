import { closeSync, mkdtempSync, openSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CursorProvider, parseCursorEvent } from '../../src/providers/cursor.js';
import { ProviderObservationAccumulator } from '../../src/providers/observation.js';
import { evaluateBuiltinProviderPreflight } from '../../src/providers/preflight.js';
import type { ProviderEventParseResult } from '../../src/providers/types.js';

const fixtures = path.resolve('tests/fixtures/providers');
const version = readFileSync(path.join(fixtures, 'cursor-2026.01.28.version.txt'), 'utf8');
const help = '--print --output-format stream-json --workspace <path> --resume [chatId]';

function supportedPreflight() {
  return evaluateBuiltinProviderPreflight({
    provider: 'cursor',
    versionOutput: version,
    probe: { ok: true, output: help },
  });
}

function launchFixture() {
  const cwd = mkdtempSync(path.join(tmpdir(), 'spool-cursor-adapter-'));
  const logPath = path.join(cwd, 'attempt.log');
  closeSync(openSync(logPath, 'wx', 0o600));
  return { cwd, logPath };
}

function replay(name: string) {
  const observations = new ProviderObservationAccumulator();
  for (const line of readFileSync(path.join(fixtures, name), 'utf8').trim().split('\n')) {
    ingest(observations, parseCursorEvent(JSON.parse(line) as unknown));
  }
  return observations.snapshot();
}

function ingest(observations: ProviderObservationAccumulator, result: ProviderEventParseResult) {
  if (result.kind === 'event') observations.ingest(result.event);
  if (result.kind === 'events') for (const event of result.events) observations.ingest(event);
}

describe('Cursor Agent 2026.01.28 adapter', () => {
  it('launches explicit stream JSON in the requested workspace with defaults unchanged', () => {
    const provider = new CursorProvider({
      executable: process.execPath,
      defaultArgs: ['--mode', 'plan'],
      preflight: supportedPreflight(),
    });
    const fixture = launchFixture();
    const launch = provider.createLaunch({ ...fixture, prompt: 'review it' });

    expect(launch.args).toEqual([
      '--mode',
      'plan',
      '--print',
      '--output-format',
      'stream-json',
      '--workspace',
      launch.target.cwd.canonicalPath,
    ]);
    expect(launch.prompt).toBe('review it');
    expect(launch.environmentAllowlist).toEqual(
      expect.arrayContaining(['USER', 'LOGNAME', 'SHELL']),
    );
    expect(launch.environmentAllowlist).not.toContain('CURSOR_API_KEY');
    expect(provider.inspectCommand('c6b62c6f-7ead-4fd6-9922-e952131177ff').args).toEqual([
      '--mode',
      'plan',
      '--resume',
      'c6b62c6f-7ead-4fd6-9922-e952131177ff',
    ]);
    expect(provider.capabilities.needsInput).toBe(false);
  });

  it('captures init identity and requires a successful result for terminal proof', () => {
    const snapshot = replay('cursor-2026.01.28.success.jsonl');
    expect(snapshot.sessionId).toBe('c6b62c6f-7ead-4fd6-9922-e952131177ff');
    expect(snapshot.latestOutput?.text).toBe('Cursor review complete.');
    expect(snapshot.terminalProof).toEqual({
      state: 'completed',
      proof: 'cursor:result:success',
    });

    const noResult = replay('cursor-2026.01.28.no-result.jsonl');
    expect(noResult.terminalProof).toBeNull();
    expect(noResult.state).toBe('working');
  });

  it('ignores unknown tool events and emits explicit failures as actionable output', () => {
    expect(
      parseCursorEvent({
        type: 'tool_call',
        subtype: 'future_tool_shape',
        session_id: 'c6b62c6f-7ead-4fd6-9922-e952131177ff',
        future: true,
      }),
    ).toEqual({ kind: 'ignored' });

    const failed = replay('cursor-2026.01.28.failure.jsonl');
    expect(failed.latestOutput?.text).toMatch(/approval/i);
    expect(failed.terminalProof?.state).toBe('failed');
  });

  it('provides typed resume inspection and validates IDs before argv rendering', () => {
    const provider = new CursorProvider({
      executable: process.execPath,
      defaultArgs: [],
      preflight: supportedPreflight(),
    });
    const id = 'c6b62c6f-7ead-4fd6-9922-e952131177ff';
    expect(provider.inspectCommand(id)).toEqual({
      executable: process.execPath,
      args: ['--resume', id],
    });
    expect(provider.resumeCommand(id)).toEqual({
      executable: process.execPath,
      args: ['--resume', id],
    });
    expect(() => provider.resumeCommand('../../escape')).toThrow(/session id/i);
  });

  it('fails malformed results while allowing version drift with compatible capabilities', () => {
    expect(parseCursorEvent({ type: 'result', subtype: 'success', is_error: false })).toMatchObject(
      {
        kind: 'malformed',
      },
    );

    const drift = evaluateBuiltinProviderPreflight({
      provider: 'cursor',
      versionOutput: '2026.01.29-future',
      probe: { ok: true, output: help },
    });
    expect(drift.status).toBe('warning');
    expect(drift.parserSupported).toBe(true);
    expect(
      new CursorProvider({ executable: process.execPath, defaultArgs: [], preflight: drift })
        .capabilities.launch,
    ).toBe(true);
  });
});
