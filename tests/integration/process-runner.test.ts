import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseFakeProviderEvent } from '../../src/providers/fake.js';
import {
  pinLaunchTarget,
  pinLogTarget,
  runProviderProcess,
} from '../../src/providers/process-runner.js';
import type { ProviderEventParseResult } from '../../src/providers/types.js';

const fakeAgent = path.resolve('examples/providers/fake-agent.mjs');

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'spool-provider-runner-'));
  const logPath = path.join(root, 'attempt.log');
  closeDescriptor(openSync(logPath, 'wx', 0o600));
  return { root, logPath };
}

describe('provider process runner', () => {
  it('passes argv, cwd, allowed environment, and stdin bytes without a shell', async () => {
    const { root, logPath } = fixture();
    const target = pinLaunchTarget(process.execPath, root);
    const hostileArgument = 'literal $(touch should-not-exist); `false`';
    process.env.SPOOL_ALLOWED_FOR_TEST = 'inherited-value';
    process.env.SPOOL_NOT_ALLOWED_FOR_TEST = 'secret-value';

    const result = await runProviderProcess({
      target,
      args: [fakeAgent, '--scenario', 'capture', '--extra', hostileArgument],
      environmentAllowlist: ['SPOOL_ALLOWED_FOR_TEST'],
      environment: { SPOOL_EXPLICIT_FOR_TEST: 'explicit-value' },
      prompt: Buffer.from('prompt\0bytes\n', 'utf8'),
      logTarget: pinLogTarget(logPath),
      limits: { maxLogBytes: 64_000, maxJsonLineBytes: 16_000, maxOutputBytes: 64_000 },
      timeoutMs: 5_000,
      diagnostics: ['provider contract warning'],
      sessionIdPolicy: {
        description: 'fake id',
        pattern: /^fake-[a-z0-9-]+$/,
        maxLength: 64,
      },
      parseEvent: parseFakeProviderEvent,
    });

    expect(result.launchState).toBe('started');
    expect(result.terminalState).toBe('completed');
    expect(result.diagnostics).toContain('provider contract warning');
    const captured = JSON.parse(result.observation.latestOutput?.text ?? '{}') as {
      argv: string[];
      cwd: string;
      env: Record<string, string | undefined>;
      promptBase64: string;
    };
    expect(captured.argv).toContain(hostileArgument);
    expect(captured.cwd).toBe(realpathSync(root));
    expect(captured.env).toEqual({
      allowed: 'inherited-value',
      explicit: 'explicit-value',
    });
    expect(Buffer.from(captured.promptBase64, 'base64')).toEqual(Buffer.from('prompt\0bytes\n'));
    expect(readFileSync(logPath, 'utf8')).toContain('fake-capture');
    expect(pathExists(path.join(root, 'should-not-exist'))).toBe(false);
  });

  it('captures a delayed session from partial JSONL before terminal completion', async () => {
    const { root, logPath } = fixture();
    const identities: string[] = [];
    const result = await runProviderProcess(
      {
        target: pinLaunchTarget(process.execPath, root),
        args: [fakeAgent, '--scenario', 'partial'],
        environmentAllowlist: [],
        environment: {},
        prompt: '',
        logTarget: pinLogTarget(logPath),
        limits: { maxLogBytes: 64_000, maxJsonLineBytes: 16_000, maxOutputBytes: 64_000 },
        timeoutMs: 5_000,
        sessionIdPolicy: {
          description: 'fake id',
          pattern: /^fake-[a-z0-9-]+$/,
          maxLength: 64,
        },
        parseEvent: parseFakeProviderEvent,
      },
      {
        onSessionIdentity(identity) {
          identities.push(identity.sessionId);
        },
      },
    );

    expect(identities).toEqual(['fake-partial']);
    expect(result.observation.sessionId).toBe('fake-partial');
    expect(result.terminalState).toBe('completed');
  });

  it('accepts terminal evidence deferred until the provider stream closes', async () => {
    const { root, logPath } = fixture();
    let deferredTerminal: ProviderEventParseResult = { kind: 'ignored' };
    const request = {
      target: pinLaunchTarget(process.execPath, root),
      args: [fakeAgent, '--scenario', 'complete'],
      environmentAllowlist: [],
      environment: {},
      prompt: '',
      logTarget: pinLogTarget(logPath),
      limits: { maxLogBytes: 64_000, maxJsonLineBytes: 16_000, maxOutputBytes: 64_000 },
      timeoutMs: 5_000,
      sessionIdPolicy: {
        description: 'fake id',
        pattern: /^fake-[a-z0-9-]+$/,
        maxLength: 64,
      },
      parseEvent(value: unknown): ProviderEventParseResult {
        const parsed = parseFakeProviderEvent(value);
        if (parsed.kind === 'event' && parsed.event.kind === 'terminal') {
          deferredTerminal = parsed;
          return { kind: 'ignored' };
        }
        return parsed;
      },
      finishEventStream: () => deferredTerminal,
    };

    const result = await runProviderProcess(request);

    expect(result.observation.latestOutput?.text).toBe('Review complete.');
    expect(result.observation.terminalProof).toEqual({
      state: 'completed',
      proof: 'fake-result',
    });
    expect(result.terminalState).toBe('completed');
  });

  it('delivers duplicate provider events to persistence callbacks only once', async () => {
    const { root, logPath } = fixture();
    const sessions: string[] = [];
    const eventKeys: string[] = [];
    const result = await runProviderProcess(
      {
        target: pinLaunchTarget(process.execPath, root),
        args: [fakeAgent, '--scenario', 'duplicate'],
        environmentAllowlist: [],
        environment: {},
        prompt: '',
        logTarget: pinLogTarget(logPath),
        limits: { maxLogBytes: 64_000, maxJsonLineBytes: 16_000, maxOutputBytes: 64_000 },
        timeoutMs: 5_000,
        sessionIdPolicy: {
          description: 'fake id',
          pattern: /^fake-[a-z0-9-]+$/,
          maxLength: 64,
        },
        parseEvent: parseFakeProviderEvent,
      },
      {
        onSessionIdentity(identity) {
          sessions.push(identity.sessionId);
        },
        onEvidence(event) {
          eventKeys.push(event.eventKey);
        },
      },
    );

    expect(result.terminalState).toBe('completed');
    expect(sessions).toEqual(['fake-duplicate']);
    expect(eventKeys).toEqual(['session:duplicate', 'terminal:duplicate']);
  });

  it('fails closed for malformed required events, silence, and missing terminal proof', async () => {
    for (const scenario of ['malformed', 'silent', 'no-terminal']) {
      const { root, logPath } = fixture();
      const result = await runProviderProcess({
        target: pinLaunchTarget(process.execPath, root),
        args: [fakeAgent, '--scenario', scenario],
        environmentAllowlist: [],
        environment: {},
        prompt: '',
        logTarget: pinLogTarget(logPath),
        limits: { maxLogBytes: 4_096, maxJsonLineBytes: 1_024, maxOutputBytes: 4_096 },
        timeoutMs: 2_000,
        sessionIdPolicy: {
          description: 'fake id',
          pattern: /^fake-[a-z0-9-]+$/,
          maxLength: 64,
        },
        parseEvent: parseFakeProviderEvent,
      });

      expect(result.terminalState, scenario).toBe('unproven');
      expect(result.diagnostics.length, scenario).toBeGreaterThan(0);
    }
  });

  it('marks the launch uncertain if durable identity capture fails and does not relaunch', async () => {
    const { root, logPath } = fixture();
    let starts = 0;
    const result = await runProviderProcess(
      {
        target: pinLaunchTarget(process.execPath, root),
        args: [fakeAgent, '--scenario', 'complete'],
        environmentAllowlist: [],
        environment: {},
        prompt: '',
        logTarget: pinLogTarget(logPath),
        limits: { maxLogBytes: 64_000, maxJsonLineBytes: 16_000, maxOutputBytes: 64_000 },
        timeoutMs: 5_000,
        sessionIdPolicy: {
          description: 'fake id',
          pattern: /^fake-[a-z0-9-]+$/,
          maxLength: 64,
        },
        parseEvent: parseFakeProviderEvent,
      },
      {
        onProcessStarted() {
          starts += 1;
        },
        onSessionIdentity() {
          throw new Error('ledger unavailable');
        },
      },
    );

    expect(starts).toBe(1);
    expect(result.launchState).toBe('uncertain');
    expect(result.terminalState).toBe('unproven');
  });

  it('cancels a process group and accepts cancellation only with provider proof', async () => {
    const { root, logPath } = fixture();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100).unref();

    const result = await runProviderProcess({
      target: pinLaunchTarget(process.execPath, root),
      args: [fakeAgent, '--scenario', 'wait-cancel'],
      environmentAllowlist: [],
      environment: {},
      prompt: '',
      logTarget: pinLogTarget(logPath),
      limits: { maxLogBytes: 64_000, maxJsonLineBytes: 16_000, maxOutputBytes: 64_000 },
      timeoutMs: 5_000,
      cancelGraceMs: 1_000,
      signal: controller.signal,
      sessionIdPolicy: {
        description: 'fake id',
        pattern: /^fake-[a-z0-9-]+$/,
        maxLength: 64,
      },
      parseEvent: parseFakeProviderEvent,
    });

    expect(result.cancelRequested).toBe(true);
    expect(result.terminalState).toBe('cancelled');
  });

  it('refuses a caller-persisted log that is replaced by a symlink before spawn', async () => {
    const { root, logPath } = fixture();
    const logTarget = pinLogTarget(logPath);
    const replacement = path.join(root, 'replacement.log');
    writeFileSync(replacement, 'do not write here', { mode: 0o600 });
    unlinkSync(logPath);
    symlinkSync(replacement, logPath);
    let starts = 0;

    const result = await runProviderProcess(
      {
        target: pinLaunchTarget(process.execPath, root),
        args: [fakeAgent, '--scenario', 'complete'],
        environmentAllowlist: [],
        environment: {},
        prompt: '',
        logTarget,
        limits: { maxLogBytes: 64_000, maxJsonLineBytes: 16_000, maxOutputBytes: 64_000 },
        timeoutMs: 5_000,
        sessionIdPolicy: {
          description: 'fake id',
          pattern: /^fake-[a-z0-9-]+$/,
          maxLength: 64,
        },
        parseEvent: parseFakeProviderEvent,
      },
      {
        onProcessStarted() {
          starts += 1;
        },
      },
    );

    expect(starts).toBe(0);
    expect(result.launchState).toBe('not_started');
    expect(readFileSync(replacement, 'utf8')).toBe('do not write here');
  });
});

function closeDescriptor(descriptor: number): void {
  closeSync(descriptor);
}

function pathExists(value: string): boolean {
  return process.getBuiltinModule('node:fs').existsSync(value);
}
