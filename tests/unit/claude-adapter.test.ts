import { closeSync, mkdtempSync, openSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ClaudeProvider, parseClaudeStreamEvent } from '../../src/providers/claude.js';
import { evaluateBuiltinProviderPreflight } from '../../src/providers/preflight.js';
import { ProviderObservationAccumulator } from '../../src/providers/observation.js';
import type { ProviderEventParseResult } from '../../src/providers/types.js';

const fixtures = path.resolve('tests/fixtures/providers');
const version = readFileSync(path.join(fixtures, 'claude-2.1.212.version.txt'), 'utf8');

function supportedPreflight() {
  return evaluateBuiltinProviderPreflight({
    provider: 'claude',
    versionOutput: version,
    probe: { ok: true, output: '--print --output-format stream-json --resume' },
  });
}

function replay(name: string) {
  const observations = new ProviderObservationAccumulator();
  for (const line of readFileSync(path.join(fixtures, name), 'utf8').trim().split('\n')) {
    ingest(observations, parseClaudeStreamEvent(JSON.parse(line) as unknown));
  }
  return observations.snapshot();
}

function ingest(observations: ProviderObservationAccumulator, result: ProviderEventParseResult) {
  if (result.kind === 'event') observations.ingest(result.event);
  if (result.kind === 'events') for (const event of result.events) observations.ingest(event);
}

function launchFixture() {
  const cwd = mkdtempSync(path.join(tmpdir(), 'spool-claude-adapter-'));
  const logPath = path.join(cwd, 'attempt.log');
  closeSync(openSync(logPath, 'wx', 0o600));
  return { cwd, logPath };
}

describe('Claude 2.1.212 adapter', () => {
  it('passes configured defaults unchanged and launches the required print stream contract', () => {
    const provider = new ClaudeProvider({
      executable: process.execPath,
      defaultArgs: ['--permission-mode', 'plan'],
      preflight: supportedPreflight(),
    });
    const launch = provider.createLaunch({ ...launchFixture(), prompt: 'first prompt' });
    expect(launch.args).toEqual([
      '--permission-mode',
      'plan',
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
    ]);
    expect(launch.prompt).toBe('first prompt');
    expect(launch.stdoutFormat).toBe('jsonl');
    expect(launch.timeoutMs).toBe(8 * 60 * 60 * 1_000);
    expect(launch.limits).toEqual({
      maxLogBytes: 8 * 1024 * 1024,
      maxJsonLineBytes: 1024 * 1024,
      maxOutputBytes: 8 * 1024 * 1024,
    });
    expect(launch.environmentAllowlist).toEqual(
      expect.arrayContaining(['USER', 'LOGNAME', 'SHELL']),
    );
    expect(launch.environmentAllowlist).not.toContain('ANTHROPIC_API_KEY');
    expect(launch.environmentAllowlist).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');

    const id = 'befd3a17-851f-4062-bfda-9a62f313d7de';
    expect(provider.inspectCommand(id)).toEqual({
      executable: 'claude',
      args: ['--permission-mode', 'plan', '--resume', id],
    });
  });

  it('keeps the last Claude result when background agents emit multiple result checkpoints', () => {
    const provider = new ClaudeProvider({
      executable: process.execPath,
      defaultArgs: [],
      preflight: supportedPreflight(),
    });
    const launch = provider.createLaunch({ ...launchFixture(), prompt: 'review it' });
    const observations = new ProviderObservationAccumulator();
    const sessionId = 'befd3a17-851f-4062-bfda-9a62f313d7de';

    for (const result of [
      'Waiting for background review agents.',
      'One review agent is still running.',
      'Review complete. Final verdict: approve.',
    ]) {
      ingest(
        observations,
        launch.parseEvent({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result,
          session_id: sessionId,
        }),
      );
    }
    const finishEventStream = launch.finishEventStream;
    expect(finishEventStream).toBeTypeOf('function');
    if (finishEventStream) ingest(observations, finishEventStream());

    expect(observations.snapshot().latestOutput?.text).toBe(
      'Review complete. Final verdict: approve.',
    );
    expect(observations.snapshot().terminalProof).toEqual({
      state: 'completed',
      proof: 'claude:result:success',
    });
  });

  it('captures full session identity, final result output, and explicit terminal proof', () => {
    const success = replay('claude-2.1.212.success.jsonl');
    expect(success.sessionId).toBe('befd3a17-851f-4062-bfda-9a62f313d7de');
    expect(success.latestOutput?.text).toBe('Claude review complete.');
    expect(success.terminalProof).toEqual({
      state: 'completed',
      proof: 'claude:result:success',
    });

    const failure = replay('claude-2.1.212.failure.jsonl');
    expect(failure.latestOutput?.text).toBe('Claude review failed.');
    expect(failure.terminalProof?.state).toBe('failed');
    expect(parseClaudeStreamEvent({ type: 'result', subtype: 'success' })).toMatchObject({
      kind: 'malformed',
    });
  });

  it('exposes only proven capabilities and validates IDs before every command', () => {
    const preflight = supportedPreflight();
    const provider = new ClaudeProvider({
      executable: process.execPath,
      defaultArgs: [],
      preflight,
    });
    const id = '99999999-9999-4999-8999-999999999999';

    expect(preflight.parserSupported).toBe(true);
    expect(provider.capabilities.needsInput).toBe(false);
    expect(provider.resumeCommand(id)).toEqual({
      executable: 'claude',
      args: ['--resume', id],
    });
    expect(provider.capabilities.observe).toBe(false);
    expect(provider.capabilities.cancel).toBe(false);
    expect(() => provider.inspectCommand('../unsafe')).toThrow(/session id/i);
  });

  it('keeps a newer CLI version available when its required capabilities are present', () => {
    const drift = evaluateBuiltinProviderPreflight({
      provider: 'claude',
      versionOutput: '2.1.215 (Claude Code)',
      probe: { ok: true, output: '--print --output-format stream-json --resume' },
    });
    expect(drift.status).toBe('warning');
    expect(drift.parserSupported).toBe(true);
    expect(drift.warnings).toContain(
      'claude 2.1.215 differs from validated baseline 2.1.212; continuing with the detected machine contract',
    );
    expect(
      new ClaudeProvider({ executable: process.execPath, defaultArgs: [], preflight: drift })
        .capabilities.launch,
    ).toBe(true);
  });

  it('still rejects version-drifted CLIs that lack the required machine contract', () => {
    const unsupported = evaluateBuiltinProviderPreflight({
      provider: 'claude',
      versionOutput: '2.1.215 (Claude Code)',
      probe: { ok: true, output: '--print only' },
    });

    expect(unsupported.status).toBe('unsupported');
    expect(unsupported.parserSupported).toBe(false);
    expect(unsupported.warnings[0]).toMatch(/does not expose the required/i);
  });
});
