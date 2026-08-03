import { closeSync, mkdtempSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { FakeProvider } from '../../src/providers/fake.js';
import { runProviderProcess } from '../../src/providers/process-runner.js';

describe('fake provider', () => {
  it('drives two distinct needs-input episodes across resumptions, then completes', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'spool-fake-provider-'));
    const statePath = path.join(root, 'state.json');
    const provider = new FakeProvider({ executable: process.execPath });
    const states: string[] = [];

    for (let phase = 0; phase < 3; phase += 1) {
      const logPath = path.join(root, `attempt-${String(phase)}.log`);
      closeSync(openSync(logPath, 'wx', 0o600));
      const request = provider.createLaunch({
        cwd: root,
        logPath,
        prompt: 'Review the fixture',
        scenario: 'lifecycle',
        statePath,
      });
      const result = await runProviderProcess(request);
      states.push(result.observation.state ?? 'missing');
      expect(result.observation.sessionId).toBe('fake-lifecycle');
      expect(result.observation.events).toContainEqual(
        expect.objectContaining({ kind: 'state', state: 'working' }),
      );
    }

    expect(states).toEqual(['needs_input', 'needs_input', 'completed']);
  });

  it.each([
    ['complete', 'completed'],
    ['fail', 'failed'],
    ['truncated', 'unproven'],
  ] as const)('maps the %s script to %s', async (scenario, expected) => {
    const root = mkdtempSync(path.join(tmpdir(), 'spool-fake-provider-'));
    const logPath = path.join(root, 'attempt.log');
    closeSync(openSync(logPath, 'wx', 0o600));
    const provider = new FakeProvider({ executable: process.execPath });

    const result = await runProviderProcess(
      provider.createLaunch({ cwd: root, logPath, prompt: '', scenario }),
    );

    expect(result.terminalState).toBe(expected);
  });

  it('exposes typed inspect, resume, and cancel argv', () => {
    const provider = new FakeProvider({ executable: process.execPath });
    expect(provider.inspectCommand('fake-session')).toEqual({
      executable: process.execPath,
      args: [expect.stringContaining('fake-agent.mjs'), '--inspect', 'fake-session'],
    });
    expect(provider.resumeCommand?.('fake-session')).toEqual({
      executable: process.execPath,
      args: [expect.stringContaining('fake-agent.mjs'), '--resume', 'fake-session'],
    });
    expect(provider.cancelCommand?.('fake-session')).toEqual({
      executable: process.execPath,
      args: [expect.stringContaining('fake-agent.mjs'), '--cancel', 'fake-session'],
    });
  });
});
