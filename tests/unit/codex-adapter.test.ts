import { closeSync, mkdtempSync, openSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CodexProvider, parseCodexEvent } from '../../src/providers/codex.js';
import { ProviderObservationAccumulator } from '../../src/providers/observation.js';
import { evaluateBuiltinProviderPreflight } from '../../src/providers/preflight.js';
import type { ProviderEventParseResult } from '../../src/providers/types.js';

const fixtures = path.resolve('tests/fixtures/providers');
const version = readFileSync(path.join(fixtures, 'codex-0.144.5.version.txt'), 'utf8');
const help = 'Run Codex non-interactively\nCommands: resume\nOptions: --json';

function supportedPreflight() {
  return evaluateBuiltinProviderPreflight({
    provider: 'codex',
    versionOutput: version,
    probe: { ok: true, output: help },
  });
}

function launchFixture() {
  const cwd = mkdtempSync(path.join(tmpdir(), 'mdspool-codex-adapter-'));
  const logPath = path.join(cwd, 'attempt.log');
  closeSync(openSync(logPath, 'wx', 0o600));
  return { cwd, logPath };
}

function replay(name: string) {
  const observations = new ProviderObservationAccumulator();
  for (const line of readFileSync(path.join(fixtures, name), 'utf8').trim().split('\n')) {
    ingest(observations, parseCodexEvent(JSON.parse(line) as unknown));
  }
  return observations.snapshot();
}

function ingest(observations: ProviderObservationAccumulator, result: ProviderEventParseResult) {
  if (result.kind === 'event') observations.ingest(result.event);
  if (result.kind === 'events') for (const event of result.events) observations.ingest(event);
}

describe('Codex 0.144.5 adapter', () => {
  it('launches exec JSONL with configured argv unchanged and prompt on stdin', () => {
    const provider = new CodexProvider({
      executable: process.execPath,
      defaultArgs: ['--sandbox', 'read-only'],
      preflight: supportedPreflight(),
    });
    const launch = provider.createLaunch({ ...launchFixture(), prompt: Buffer.from('review it') });

    expect(launch.args).toEqual(['exec', '--sandbox', 'read-only', '--json', '-']);
    expect(launch.prompt).toEqual(Buffer.from('review it'));
    expect(launch.stdoutFormat).toBe('jsonl');
    expect(launch.environmentAllowlist).toEqual(
      expect.arrayContaining(['USER', 'LOGNAME', 'SHELL']),
    );
    expect(launch.environmentAllowlist).not.toContain('OPENAI_API_KEY');
    expect(provider.inspectCommand('0199a213-81c0-7800-8aa1-bbab2a035a53').args).toEqual([
      '--sandbox',
      'read-only',
      'resume',
      '0199a213-81c0-7800-8aa1-bbab2a035a53',
    ]);
    expect(provider.capabilities.needsInput).toBe(false);
  });

  it('captures thread identity, latest completed agent message, and completion proof', () => {
    const snapshot = replay('codex-0.144.5.success.jsonl');

    expect(snapshot.sessionId).toBe('019f74e3-b9a0-7270-98c2-a37c4b61262c');
    expect(snapshot.latestOutput?.text).toBe('Final review result from Codex 0.144.5.');
    expect(snapshot.terminalProof).toEqual({
      state: 'completed',
      proof: 'codex:turn.completed',
    });
  });

  it('turns turn and tool approval failures into actionable failed evidence', () => {
    const failed = replay('codex-0.144.5.failure.jsonl');
    expect(failed.terminalProof?.state).toBe('failed');
    expect(failed.latestOutput?.text).toBe(
      'The configured model requires a newer version of Codex.',
    );
    const failedEvent = failed.events.at(-1);
    expect(failedEvent?.kind).toBe('terminal');
    expect(failedEvent?.kind === 'terminal' ? failedEvent.message : '').toMatch(/newer version/i);

    const toolFailure = replay('codex-0.139.0.tool-failure.jsonl');
    expect(toolFailure.terminalProof?.state).toBe('failed');
    expect(toolFailure.latestOutput?.text).toBe('Tool execution needs approval');
    const toolFailureEvent = toolFailure.events.at(-1);
    expect(toolFailureEvent?.kind).toBe('terminal');
    expect(toolFailureEvent?.kind === 'terminal' ? toolFailureEvent.message : '').toMatch(
      /approval/i,
    );
  });

  it('allows a turn to complete after a recoverable command failure', () => {
    const snapshot = replay('codex-0.144.5.recovered-tool-failure.jsonl');

    expect(snapshot.latestOutput?.text).toBe('Codex recovered and completed the task.');
    expect(snapshot.terminalProof).toEqual({
      state: 'completed',
      proof: 'codex:turn.completed',
    });
  });

  it('emits typed resume inspection and rejects untrusted session IDs', () => {
    const provider = new CodexProvider({
      executable: process.execPath,
      defaultArgs: [],
      preflight: supportedPreflight(),
    });
    const id = '0199a213-81c0-7800-8aa1-bbab2a035a53';
    expect(provider.inspectCommand(id)).toEqual({
      executable: 'codex',
      args: ['resume', id],
    });
    expect(provider.resumeCommand(id)).toEqual({
      executable: 'codex',
      args: ['resume', id],
    });
    expect(() => provider.inspectCommand('id; rm -rf /')).toThrow(/session id/i);
  });

  it('fails required event shapes while allowing version drift with compatible capabilities', () => {
    expect(parseCodexEvent({ type: 'thread.started' })).toMatchObject({ kind: 'malformed' });
    expect(parseCodexEvent({ type: 'future.event', extra: true })).toEqual({ kind: 'ignored' });

    const drift = evaluateBuiltinProviderPreflight({
      provider: 'codex',
      versionOutput: 'codex-cli 0.139.0',
      probe: { ok: true, output: help },
    });
    expect(drift.status).toBe('warning');
    expect(drift.parserSupported).toBe(true);
    expect(
      new CodexProvider({ executable: process.execPath, defaultArgs: [], preflight: drift })
        .capabilities.launch,
    ).toBe(true);
  });
});
