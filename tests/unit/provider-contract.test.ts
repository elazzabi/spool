import { closeSync, mkdtempSync, openSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { defineCapabilities } from '../../src/providers/capabilities.js';
import { replayAttemptLog, sanitizeOperatorText } from '../../src/providers/logs.js';
import { ProviderObservationAccumulator } from '../../src/providers/observation.js';
import { pinLogTarget } from '../../src/providers/process-runner.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import {
  defineSessionIdPolicy,
  type ProviderAdapter,
  type ProviderEventParseResult,
} from '../../src/providers/types.js';

const sessionPolicy = defineSessionIdPolicy({
  description: 'fixture session id',
  pattern: /^[a-z][a-z0-9-]*$/,
  maxLength: 24,
});

function adapter(name: string): ProviderAdapter {
  return {
    name,
    capabilities: defineCapabilities({
      launch: true,
      observe: true,
      inspect: true,
      resume: true,
      cancel: false,
      needsInput: false,
    }),
    sessionIdPolicy: sessionPolicy,
    createLaunch() {
      throw new Error('not used by this contract test');
    },
    parseEvent(value): ProviderEventParseResult {
      if (!value || typeof value !== 'object') return { kind: 'ignored' };
      return { kind: 'ignored' };
    },
    inspectCommand(sessionId) {
      return { executable: '/fixture/provider', args: ['inspect', sessionId] };
    },
  };
}

describe('provider contract', () => {
  it('validates bounded session identities before commands can use them', () => {
    expect(sessionPolicy.parse('session-123')).toBe('session-123');
    expect(() => sessionPolicy.parse('../escape')).toThrow(/fixture session id/i);
    expect(() => sessionPolicy.parse(`s${'x'.repeat(40)}`)).toThrow(/24/);
  });

  it('rejects contradictory capability declarations and duplicate adapters', () => {
    expect(() =>
      defineCapabilities({
        launch: true,
        observe: false,
        inspect: false,
        resume: false,
        cancel: false,
        needsInput: true,
      }),
    ).toThrow(/needs input.*observe/i);

    const registry = new ProviderRegistry([adapter('fixture')]);
    expect(registry.require('fixture').name).toBe('fixture');
    expect(() => registry.register(adapter('fixture'))).toThrow(/already registered/i);
    expect(() => registry.require('missing')).toThrow(/unknown provider/i);
  });

  it('deduplicates observations, preserves terminal proof, and updates output by hash', () => {
    const observations = new ProviderObservationAccumulator();
    observations.ingest({
      kind: 'session',
      eventKey: 'session:1',
      sessionId: 'session-1',
    });
    observations.ingest({
      kind: 'state',
      eventKey: 'state:working',
      state: 'working',
    });
    observations.ingest({
      kind: 'output',
      eventKey: 'output:a',
      text: 'first result',
    });
    observations.ingest({
      kind: 'output',
      eventKey: 'output:b',
      text: 'new result',
    });
    observations.ingest({
      kind: 'terminal',
      eventKey: 'terminal:done',
      state: 'completed',
      proof: 'fixture-result',
    });
    expect(
      observations.ingest({
        kind: 'state',
        eventKey: 'late-working',
        state: 'working',
      }),
    ).toBe('ignored-after-terminal');
    expect(
      observations.ingest({
        kind: 'terminal',
        eventKey: 'terminal:done',
        state: 'completed',
        proof: 'fixture-result',
      }),
    ).toBe('duplicate');

    const snapshot = observations.snapshot();
    expect(snapshot.sessionId).toBe('session-1');
    expect(snapshot.state).toBe('completed');
    expect(snapshot.terminalProof).toEqual({ state: 'completed', proof: 'fixture-result' });
    expect(snapshot.latestOutput?.text).toBe('new result');
    expect(snapshot.latestOutput?.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.events).toHaveLength(5);
  });

  it('visibly escapes terminal controls, bidi overrides, and invalid UTF-8', () => {
    const hostile = Buffer.concat([
      Buffer.from('\u001b]0;title\u0007\u001bPpayload\u001b\\\u001b[31mred\u001b[0m\u202e'),
      Buffer.from([0xff, 0x01]),
    ]);

    const sanitized = sanitizeOperatorText(hostile);

    expect(sanitized).not.toContain('\u001b');
    expect(sanitized).not.toContain('\u202e');
    expect(sanitized).toContain('\\u{001B}]0;title\\u{0007}');
    expect(sanitized).toContain('\\u{202E}');
    expect(sanitized).toContain('\\u{FFFD}');
    expect(sanitized).toContain('\\u{0001}');
  });

  it('replays logs sanitized by default and requires an explicit unsafe raw mode', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'spool-log-replay-'));
    const logPath = path.join(root, 'attempt.log');
    closeSync(openSync(logPath, 'wx', 0o600));
    writeFileSync(logPath, Buffer.from('safe\u001b[31mred\u001b[0m'));
    const target = pinLogTarget(logPath);

    const safe = replayAttemptLog(target, { maxBytes: 1024 });
    expect(safe.mode).toBe('sanitized');
    expect(safe.content).toContain('\\u{001B}[31m');

    const raw = replayAttemptLog(target, { maxBytes: 1024, mode: 'unsafe-raw' });
    expect(raw.mode).toBe('unsafe-raw');
    if (raw.mode !== 'unsafe-raw') throw new Error('Expected explicit raw log replay');
    expect(raw.warning).toMatch(/active terminal control/i);
    expect(raw.content).toEqual(Buffer.from('safe\u001b[31mred\u001b[0m'));
  });
});
