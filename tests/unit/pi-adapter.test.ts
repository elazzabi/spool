import { closeSync, mkdtempSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { PiProvider } from '../../src/providers/pi.js';
import { JsonLineDecoder } from '../../src/providers/jsonl.js';
import { ProviderObservationAccumulator } from '../../src/providers/observation.js';
import { evaluateBuiltinProviderPreflight } from '../../src/providers/preflight.js';
import type { ProviderEventParseResult, ProviderLaunchRequest } from '../../src/providers/types.js';

const fixtures = path.resolve('tests/fixtures/providers');
const version = readFileSync(path.join(fixtures, 'pi-0.74.2.version.txt'), 'utf8');
const help =
  '--mode json --session <id> --session-dir <path> --tools <tools> --offline --no-extensions --no-context-files --no-skills --no-prompt-templates --list-models';
const sessionId = '13b2e3b4-82b0-42a7-bce6-08fa5cfcbe63';

function supportedPreflight(versionOutput = version) {
  return evaluateBuiltinProviderPreflight({
    provider: 'pi',
    versionOutput,
    probe: { ok: true, output: help },
  });
}

function launchFixture() {
  const cwd = mkdtempSync(path.join(tmpdir(), 'spool-pi-adapter-'));
  const logPath = path.join(cwd, 'attempt.log');
  const sessionDirectory = path.join(cwd, 'state', 'pi', 'sessions');
  closeSync(openSync(logPath, 'wx', 0o600));
  return { cwd, logPath, sessionDirectory };
}

function providerFixture(defaultArgs: readonly string[] = []) {
  const fixture = launchFixture();
  const provider = new PiProvider({
    executable: process.execPath,
    defaultArgs,
    sessionDirectory: fixture.sessionDirectory,
    preflight: supportedPreflight(),
  });
  return { provider, fixture };
}

function ingest(observations: ProviderObservationAccumulator, result: ProviderEventParseResult) {
  if (result.kind === 'event') observations.ingest(result.event);
  if (result.kind === 'events') for (const event of result.events) observations.ingest(event);
}

function replay(launch: ProviderLaunchRequest, name: string) {
  const observations = new ProviderObservationAccumulator();
  const results: ProviderEventParseResult[] = [];
  for (const line of readFileSync(path.join(fixtures, name), 'utf8').trim().split('\n')) {
    const result = launch.parseEvent(JSON.parse(line) as unknown);
    results.push(result);
    ingest(observations, result);
  }
  return { observations, results };
}

function finish(launch: ProviderLaunchRequest, observations: ProviderObservationAccumulator) {
  expect(launch.finishEventStream).toBeTypeOf('function');
  const result = launch.finishEventStream?.() ?? { kind: 'ignored' as const };
  ingest(observations, result);
  return result;
}

describe('Pi 0.74.2 adapter', () => {
  it('appends adapter-owned safe JSON launch flags and sends the prompt on stdin', () => {
    const { provider, fixture } = providerFixture([
      '--model',
      'configured/model',
      '--tools',
      'bash',
    ]);
    const launch = provider.createLaunch({ ...fixture, prompt: Buffer.from('review it') });

    expect(launch.args).toEqual([
      '--model',
      'configured/model',
      '--tools',
      'bash',
      '--offline',
      '--tools',
      'read,grep,find,ls',
      '--no-extensions',
      '--no-context-files',
      '--no-skills',
      '--no-prompt-templates',
      '--session-dir',
      fixture.sessionDirectory,
      '--mode',
      'json',
    ]);
    expect(launch.prompt).toEqual(Buffer.from('review it'));
    expect(launch.target.cwd.canonicalPath).toBe(realpathSync(fixture.cwd));
    expect(launch.logTarget.canonicalPath).toBe(realpathSync(fixture.logPath));
    expect(launch.stdoutFormat).toBe('jsonl');
    expect(launch.limits).toEqual({
      maxLogBytes: 32 * 1024 * 1024,
      maxJsonLineBytes: 4 * 1024 * 1024,
      maxOutputBytes: 32 * 1024 * 1024,
    });
    expect(launch.environmentAllowlist).toContain('PI_CODING_AGENT_DIR');
    expect(launch.environmentAllowlist).not.toEqual(
      expect.arrayContaining(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY']),
    );
  });

  it('captures the v3 UUID and complete assistant output without early terminal proof', () => {
    const { provider, fixture } = providerFixture();
    const launch = provider.createLaunch({ ...fixture, prompt: 'review it' });
    const { observations, results } = replay(launch, 'pi-0.74.2.success.jsonl');

    expect(observations.snapshot().sessionId).toBe(sessionId);
    expect(observations.snapshot().state).toBe('working');
    expect(observations.snapshot().latestOutput?.text).toBe('Pi review complete.');
    expect(observations.snapshot().terminalProof).toBeNull();
    expect(results.at(-1)).toEqual({ kind: 'ignored' });

    expect(finish(launch, observations)).toMatchObject({
      kind: 'event',
      event: { kind: 'terminal', state: 'completed', proof: 'pi:agent_end:stop' },
    });
    expect(observations.snapshot().terminalProof?.state).toBe('completed');
  });

  it.each([
    ['pi-0.74.2.failure.jsonl', 'failed', 'Configured model rejected the request'],
    ['pi-0.74.2.aborted.jsonl', 'cancelled', 'Review cancelled by operator.'],
  ])('maps the final assistant outcome in %s to %s', (name, state, message) => {
    const { provider, fixture } = providerFixture();
    const launch = provider.createLaunch({ ...fixture, prompt: 'review it' });
    const { observations } = replay(launch, name);

    const terminal = finish(launch, observations);
    expect(terminal).toMatchObject({
      kind: 'event',
      event: { kind: 'terminal', state, message },
    });
  });

  it('replaces a failed attempt across auto-retry and releases only final success', () => {
    const { provider, fixture } = providerFixture();
    const launch = provider.createLaunch({ ...fixture, prompt: 'review it' });
    const { observations } = replay(launch, 'pi-0.74.2.retry-success.jsonl');

    expect(observations.snapshot().terminalProof).toBeNull();
    expect(finish(launch, observations)).toMatchObject({
      kind: 'event',
      event: { kind: 'terminal', state: 'completed' },
    });
    expect(observations.snapshot().latestOutput?.text).toBe('Pi retry completed.');
  });

  it('keeps exhausted retries failed but clears stale proof when another retry begins', () => {
    const { provider, fixture } = providerFixture();
    const failedLaunch = provider.createLaunch({ ...fixture, prompt: 'review it' });
    const failed = replay(failedLaunch, 'pi-0.74.2.failure.jsonl');
    expect(finish(failedLaunch, failed.observations)).toMatchObject({
      kind: 'event',
      event: { kind: 'terminal', state: 'failed' },
    });

    const retryLaunch = provider.createLaunch({ ...fixture, prompt: 'review it' });
    retryLaunch.parseEvent({ type: 'session', version: 3, id: sessionId });
    retryLaunch.parseEvent({
      type: 'agent_end',
      messages: [{ role: 'assistant', content: [], stopReason: 'error', errorMessage: 'retry' }],
    });
    retryLaunch.parseEvent({
      type: 'auto_retry_start',
      attempt: 1,
      maxAttempts: 3,
      delayMs: 1000,
      errorMessage: 'retry',
    });
    expect(retryLaunch.finishEventStream?.()).toEqual({ kind: 'ignored' });
  });

  it('rejects malformed identity and required assistant/terminal shapes conservatively', () => {
    const { provider, fixture } = providerFixture();
    const launch = provider.createLaunch({ ...fixture, prompt: 'review it' });

    for (const value of [
      { type: 'session', version: 2, id: sessionId },
      { type: 'session', version: 3 },
      { type: 'session', version: 3, id: 42 },
      { type: 'session', version: 3, id: '../unsafe' },
      { type: 'session', version: 3, id: 'a'.repeat(37) },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text' }] } },
      { type: 'agent_end', messages: [{ role: 'assistant', content: [] }] },
    ]) {
      expect(launch.parseEvent(value)).toMatchObject({ kind: 'malformed' });
    }
    expect(launch.parseEvent({ type: 'future_event', additive: true })).toEqual({
      kind: 'ignored',
    });
    expect(launch.finishEventStream?.()).toEqual({ kind: 'ignored' });
  });

  it('does not retain a prior terminal candidate after malformed later terminal evidence', () => {
    const { provider, fixture } = providerFixture();
    const launch = provider.createLaunch({ ...fixture, prompt: 'review it' });
    launch.parseEvent({ type: 'session', version: 3, id: sessionId });
    launch.parseEvent({
      type: 'agent_end',
      messages: [{ role: 'assistant', content: [], stopReason: 'stop' }],
    });
    expect(launch.parseEvent({ type: 'agent_end', messages: [] })).toMatchObject({
      kind: 'malformed',
    });
    expect(launch.finishEventStream?.()).toEqual({ kind: 'ignored' });

    const headerOnly = provider.createLaunch({ ...fixture, prompt: 'review it' });
    expect(headerOnly.parseEvent({ type: 'session', version: 3, id: sessionId })).toMatchObject({
      kind: 'events',
    });
    expect(headerOnly.finishEventStream?.()).toEqual({ kind: 'ignored' });

    const noIdentity = provider.createLaunch({ ...fixture, prompt: 'review it' });
    noIdentity.parseEvent({
      type: 'agent_end',
      messages: [{ role: 'assistant', content: [], stopReason: 'stop' }],
    });
    expect(noIdentity.finishEventStream?.()).toEqual({ kind: 'ignored' });
  });

  it('uses the bounded JSONL decoder so oversized and truncated evidence cannot prove success', () => {
    const { provider, fixture } = providerFixture();
    const launch = provider.createLaunch({ ...fixture, prompt: 'review it' });
    const lineDecoder = new JsonLineDecoder({
      maxLineBytes: launch.limits.maxJsonLineBytes,
      maxTotalBytes: launch.limits.maxOutputBytes,
    });
    expect(lineDecoder.push(Buffer.alloc(launch.limits.maxJsonLineBytes + 1, 0x61))).toEqual([
      expect.objectContaining({ kind: 'malformed' }),
    ]);

    const totalDecoder = new JsonLineDecoder({ maxLineBytes: 16, maxTotalBytes: 24 });
    const records = totalDecoder.push(Buffer.from('{}\n'.repeat(20)));
    expect(records).toContainEqual(expect.objectContaining({ kind: 'truncated' }));
    expect(launch.finishEventStream?.()).toEqual({ kind: 'ignored' });
  });

  it('builds deterministic interactive inspect/resume commands and validates the full UUID', () => {
    const { provider, fixture } = providerFixture(['--model', 'configured/model']);
    const expectedArgs = [
      '--model',
      'configured/model',
      '--offline',
      '--tools',
      'read,grep,find,ls',
      '--no-extensions',
      '--no-context-files',
      '--no-skills',
      '--no-prompt-templates',
      '--session-dir',
      fixture.sessionDirectory,
      '--session',
      sessionId,
    ];

    expect(provider.inspectCommand(sessionId)).toEqual({ executable: 'pi', args: expectedArgs });
    expect(provider.resumeCommand(sessionId)).toEqual({ executable: 'pi', args: expectedArgs });
    expect(() => provider.inspectCommand('../../escape')).toThrow(/session id/i);
  });

  it('warns for compatible version drift and rejects drift without the required help contract', () => {
    const drift = supportedPreflight('pi 0.75.0');
    const fixture = launchFixture();
    const driftProvider = new PiProvider({
      executable: process.execPath,
      defaultArgs: [],
      sessionDirectory: fixture.sessionDirectory,
      preflight: drift,
    });
    expect(drift.status).toBe('warning');
    expect(drift.parserSupported).toBe(true);
    expect(drift.warnings).toContain(
      'pi 0.75.0 differs from validated baseline 0.74.2; continuing with the detected machine contract',
    );
    expect(driftProvider.createLaunch({ ...fixture, prompt: 'review' }).diagnostics).toContain(
      'pi 0.75.0 differs from validated baseline 0.74.2; continuing with the detected machine contract',
    );

    const unsupported = evaluateBuiltinProviderPreflight({
      provider: 'pi',
      versionOutput: 'pi 0.75.0',
      probe: { ok: true, output: '--mode json --session' },
    });
    expect(unsupported.status).toBe('unsupported');
    expect(unsupported.parserSupported).toBe(false);
    expect(unsupported.warnings[0]).toMatch(/required/i);
  });
});
