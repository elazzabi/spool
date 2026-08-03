import { describe, expect, it } from 'vitest';

import {
  assertAllowedProviderArgv,
  assertNoSensitiveArgv,
  redactSensitiveArgv,
  type ProviderArgvPolicy,
} from '../../src/providers/argv.js';

const policy: ProviderArgvPolicy = {
  reservedArgs: ['--output-format', '--resume', '-p', '-'],
  deniedRules: [
    { names: ['--dangerously-skip-permissions'] },
    { names: ['--permission-mode'], values: ['bypassPermissions'] },
    { names: ['--force', '--yolo'] },
  ],
};

describe('provider argv safety', () => {
  it('does not mistake the Codex bypass flag for a password flag', () => {
    const argv = [
      'codex',
      '--dangerously-bypass-approvals-and-sandbox',
      'resume',
      '019f74ee-4f00-7212-9fb9-14722b312860',
    ];

    expect(redactSensitiveArgv(argv)).toEqual(argv);
    expect(() => assertNoSensitiveArgv(argv.slice(1, 2))).not.toThrow();
  });

  it('still redacts and rejects credential flags at complete name boundaries', () => {
    expect(redactSensitiveArgv(['agent', '--api-key', 'private', '--label', 'safe'])).toEqual([
      'agent',
      '--api-key',
      '[REDACTED]',
      '--label',
      'safe',
    ]);
    expect(redactSensitiveArgv(['agent', '--authToken=private'])).toEqual([
      'agent',
      '--authToken=[REDACTED]',
    ]);
    expect(() => assertNoSensitiveArgv(['--password-file', '/tmp/private'])).toThrow(
      /credentials/i,
    );
  });

  it.each([
    [['--output-format', 'json']],
    [['--output_format=json']],
    [['--resume=known-session']],
    [['-p']],
    [['-']],
  ])('rejects adapter-owned arguments in paired, inline, short, and positional forms', (args) => {
    expect(() => assertAllowedProviderArgv(args, policy)).toThrow(/MDSpool-managed/i);
  });

  it.each([
    [['--dangerously-skip-permissions']],
    [['--permission-mode', 'bypassPermissions']],
    [['--permission_mode=bypass-permissions']],
    [['--force']],
    [['--yolo']],
  ])('rejects dangerous aliases that bypass the warned profile', (args) => {
    expect(() => assertAllowedProviderArgv(args, policy)).toThrow(/warned access profile/i);
  });

  it('validates the accumulated argv so paired dangerous values cannot arrive separately', () => {
    expect(() => assertAllowedProviderArgv(['--permission-mode'], policy)).not.toThrow();
    expect(() =>
      assertAllowedProviderArgv(['--permission-mode', 'bypassPermissions'], policy),
    ).toThrow(/warned access profile/i);
  });

  it('rejects empty and credential-shaped arguments without including the input value', () => {
    expect(() => assertAllowedProviderArgv([''], policy)).toThrow(/must not be empty/i);

    const canary = '--api-key=private-canary-value';
    let message = '';
    try {
      assertAllowedProviderArgv([canary], policy);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/credentials/i);
    expect(message).not.toContain('private-canary-value');
  });

  it('accepts harmless literal arguments without interpreting shell text or sensitive substrings', () => {
    expect(() =>
      assertAllowedProviderArgv(
        ['--model', 'safe model; touch /tmp/nope', '--monkey-mode', '--authorship-style'],
        policy,
      ),
    ).not.toThrow();
  });
});
