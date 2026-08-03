import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  assertProviderArgumentChoice,
  detectBuiltinProviders,
  assessSetupConfiguration,
  deriveRepositoryMappings,
  mapSelectedProviders,
  publishSetupConfiguration,
  providerSetupDefinitions,
  SetupError,
  type ProviderProbeRunner,
  type ProviderArgumentChoice,
  type ProviderSetupDefinition,
  type ProviderSetupStatus,
} from '../../src/config/setup.js';
import type { BuiltinProviderName } from '../../src/providers/preflight.js';
import type { RawConfig } from '../../src/config/schema.js';
import type { GitRunner } from '../../src/workspaces/git.js';

describe('provider setup configuration', () => {
  it('maps every catalog provider in stable order while keeping ready unchecked providers disabled', () => {
    const statuses = providerSetupDefinitions.map((definition) => readyStatus(definition));

    const providers = mapSelectedProviders(statuses, new Set(['codex']));

    expect(Object.entries(providers).map(([name, provider]) => [name, provider.enabled])).toEqual([
      ['claude', false],
      ['codex', true],
      ['cursor', false],
      ['pi', false],
    ]);
    expect(Object.keys(providers)).toEqual(
      providerSetupDefinitions.map((definition) => definition.name),
    );
    for (const definition of providerSetupDefinitions) {
      expect(providers[definition.name]).toEqual({
        enabled: definition.name === 'codex',
        executable: definition.executable,
        directive: definition.directive,
        defaultArgs: definition.recommendedArgs,
      });
    }
  });

  it.each([
    ['missing', { installed: false, parserSupported: false, reason: 'executable not found' }],
    ['logged out', { authenticated: false, reason: 'not logged in' }],
    ['unsupported', { parserSupported: false, reason: 'provider contract is unsupported' }],
    ['timed out', { reason: 'provider check timed out' }],
    ['failed', { reason: 'provider check failed' }],
  ] as const)('rejects a selected provider that is %s', (_, overrides) => {
    const statuses = providerSetupDefinitions.map((definition) => {
      if (definition.name !== 'claude') return readyStatus(definition);
      return unavailableStatus(definition, overrides.reason, overrides);
    });

    expect(() => mapSelectedProviders(statuses, new Set(['claude']))).toThrow(SetupError);
  });

  it('rejects a selected name absent from the readiness results', () => {
    const statuses = providerSetupDefinitions.map((definition) => readyStatus(definition));

    expect(() => mapSelectedProviders(statuses, new Set(['future']))).toThrow(SetupError);
  });

  it('maps a future catalog definition without provider-specific logic', () => {
    const futureDefinition: ProviderSetupDefinition = {
      name: 'future' as BuiltinProviderName,
      executable: 'future-agent',
      directive: '@future',
      recommendedArgs: ['--safe-mode'],
      authenticationArgs: ['auth', 'status'],
      access: {
        recommendedDescription: 'Keep the future agent in safe mode.',
        customOnlyDescription: 'Start without the recommended baseline.',
      },
      argvPolicy: { reservedArgs: ['--managed-output'], deniedRules: [] },
      adapterOwnedArgs: ['--managed-output'],
    };

    expect(mapSelectedProviders([readyStatus(futureDefinition)], new Set(['future']))).toEqual({
      future: {
        enabled: true,
        executable: 'future-agent',
        directive: '@future',
        defaultArgs: ['--safe-mode'],
      },
    });
  });

  it('maps recommended, unrestricted, and custom-only choices without merging baselines', () => {
    const statuses = providerSetupDefinitions.map((definition) => readyStatus(definition));
    const selected = new Set<BuiltinProviderName>(['claude', 'codex', 'cursor', 'pi']);
    const choices = new Map<BuiltinProviderName, ProviderArgumentChoice>([
      ['claude', { profile: 'unrestricted', extraArgs: ['--model', 'opus'] }],
      ['codex', { profile: 'unrestricted', extraArgs: ['--model', 'gpt-5.6'] }],
      ['cursor', { profile: 'unrestricted', extraArgs: ['--model', 'composer-1'] }],
      ['pi', { profile: 'custom-only', extraArgs: ['--model', 'local/model'] }],
    ]);

    const providers = mapSelectedProviders(statuses, selected, choices);

    expect(providers.claude?.defaultArgs).toEqual([
      '--dangerously-skip-permissions',
      '--model',
      'opus',
    ]);
    expect(providers.codex?.defaultArgs).toEqual([
      '--dangerously-bypass-approvals-and-sandbox',
      '--model',
      'gpt-5.6',
    ]);
    expect(providers.cursor?.defaultArgs).toEqual(['--force', '--model', 'composer-1']);
    expect(providers.pi?.defaultArgs).toEqual(['--model', 'local/model']);
  });

  it('preserves repeated literal extras after the recommended baseline', () => {
    const statuses = providerSetupDefinitions.map((definition) => readyStatus(definition));
    const choices = new Map<BuiltinProviderName, ProviderArgumentChoice>([
      [
        'codex',
        {
          profile: 'recommended',
          extraArgs: ['--model', 'gpt-5.6', '--config', 'x=1', '--config', 'x=2'],
        },
      ],
    ]);

    expect(mapSelectedProviders(statuses, new Set(['codex']), choices).codex?.defaultArgs).toEqual([
      '--sandbox',
      'read-only',
      '--model',
      'gpt-5.6',
      '--config',
      'x=1',
      '--config',
      'x=2',
    ]);
  });

  it('rejects unsupported unrestricted profiles and unsafe custom extras', () => {
    const statuses = providerSetupDefinitions.map((definition) => readyStatus(definition));

    expect(() =>
      mapSelectedProviders(
        statuses,
        new Set(['pi']),
        new Map([['pi', { profile: 'unrestricted', extraArgs: [] }]]),
      ),
    ).toThrow(/unrestricted profile/i);
    expect(() =>
      mapSelectedProviders(
        statuses,
        new Set(['cursor']),
        new Map([['cursor', { profile: 'custom-only', extraArgs: ['--yolo'] }]]),
      ),
    ).toThrow(/warned access profile/i);
    expect(() =>
      mapSelectedProviders(
        statuses,
        new Set(['pi']),
        new Map([['pi', { profile: 'custom-only', extraArgs: ['--tools=all'] }]]),
      ),
    ).toThrow(/MDSpool-managed/i);
  });

  it.each([
    ['claude', ['-r', 'known-session']],
    ['claude', ['--continue']],
    ['claude', ['--no-session-persistence']],
    ['codex', ['--ephemeral']],
    ['cursor', ['--continue']],
    ['pi', ['-t', 'bash']],
    ['pi', ['--extension', '/tmp/extension.ts']],
    ['pi', ['-e=/tmp/extension.ts']],
    ['pi', ['--skill', '/tmp/skill']],
    ['pi', ['--prompt-template', '/tmp/template.md']],
    ['pi', ['--mcp-config', '/tmp/mcp.json']],
    ['pi', ['--no-session']],
    ['pi', ['--continue']],
    ['pi', ['-c']],
    ['pi', ['--resume', 'known-session']],
    ['pi', ['-r', 'known-session']],
    ['pi', ['--fork', 'known-session']],
  ] as const)(
    'rejects %s arguments that conflict with resource or session ownership',
    (name, args) => {
      const definition = providerSetupDefinitions.find((candidate) => candidate.name === name);
      if (!definition) throw new Error(`missing provider definition: ${name}`);

      expect(() =>
        assertProviderArgumentChoice(definition, { profile: 'custom-only', extraArgs: args }),
      ).toThrow(/MDSpool-managed/i);
    },
  );

  it('ignores stale choices for disabled or unavailable providers', () => {
    const statuses = providerSetupDefinitions.map((definition) =>
      definition.name === 'codex'
        ? unavailableStatus(definition, 'not logged in', { authenticated: false })
        : readyStatus(definition),
    );
    const choices = new Map<BuiltinProviderName, ProviderArgumentChoice>([
      ['claude', { profile: 'unrestricted', extraArgs: [] }],
      ['codex', { profile: 'unrestricted', extraArgs: [] }],
    ]);

    const providers = mapSelectedProviders(statuses, new Set(['cursor']), choices);

    expect(providers.claude?.defaultArgs).toEqual(
      providerSetupDefinitions.find(({ name }) => name === 'claude')?.recommendedArgs,
    );
    expect(providers.codex?.defaultArgs).toEqual(
      providerSetupDefinitions.find(({ name }) => name === 'codex')?.recommendedArgs,
    );
  });

  it('detects catalog readiness in stable order with bounded non-shell probes', async () => {
    const fixture = createExecutableFixture();
    const runner = providerRunner();

    const statuses = await detectBuiltinProviders({
      commandRunner: runner,
      pathValue: fixture.bin,
      environment: {
        PATH: fixture.bin,
        PI_CODING_AGENT_DIR: '/stored/pi',
        OPENAI_API_KEY: 'ambient-only-secret',
      },
    });

    expect(statuses.map(({ definition, ready }) => [definition.name, ready])).toEqual([
      ['claude', true],
      ['codex', true],
      ['cursor', false],
      ['pi', true],
    ]);
    expect(runner).toHaveBeenCalledTimes(12);
    for (const [executable, , options] of runner.mock.calls) {
      expect(options).toMatchObject({ shell: false, timeoutMs: 5_000 });
      if (path.basename(executable) === 'pi') {
        expect(options.environment).toMatchObject({ PI_CODING_AGENT_DIR: '/stored/pi' });
        expect(options.environment).not.toHaveProperty('OPENAI_API_KEY');
      }
    }
  });

  it.each([
    ['', ''],
    ['', 'provider model context max-out thinking images\n'],
    ['', 'Checking configured models...\nprovider model context max-out thinking images\n'],
    ['', 'provider model context max-out thinking images\nmalformed\n'],
  ])('keeps Pi unavailable when the model table has no actual row', async (stdout, stderr) => {
    const fixture = createExecutableFixture();
    const baseRunner = providerRunner();
    const runner = vi.fn<ProviderProbeRunner>((executable, args, options) =>
      path.basename(executable) === 'pi' && args.includes('--list-models')
        ? Promise.resolve({ ok: true, stdout, stderr })
        : baseRunner(executable, args, options),
    );

    const [status] = await detectBuiltinProviders({
      commandRunner: runner,
      pathValue: fixture.bin,
      providerNames: ['pi'],
      environment: { PATH: fixture.bin },
    });

    expect(status).toMatchObject({ authenticated: false, ready: false });
    expect(status?.reason).toMatch(/stored Pi auth/i);
  });

  it('accepts a Pi model table written to stderr under the sanitized runtime environment', async () => {
    const fixture = createExecutableFixture();
    const baseRunner = providerRunner();
    const runner = vi.fn<ProviderProbeRunner>((executable, args, options) => {
      if (path.basename(executable) === 'pi') {
        expect(options.environment).toEqual({
          PATH: fixture.bin,
          PI_CODING_AGENT_DIR: '/stored/pi',
        });
      }
      return baseRunner(executable, args, options);
    });

    const [status] = await detectBuiltinProviders({
      commandRunner: runner,
      pathValue: fixture.bin,
      providerNames: ['pi'],
      environment: {
        PATH: fixture.bin,
        PI_CODING_AGENT_DIR: '/stored/pi',
        OPENAI_API_KEY: 'ambient-only-secret',
      },
    });

    expect(status).toMatchObject({ authenticated: true, parserSupported: true, ready: true });
    expect(runner).toHaveBeenCalledWith(
      expect.any(String),
      ['--offline', '--no-extensions', '--list-models'],
      expect.objectContaining({ shell: false }),
    );
  });

  it('does not treat ambient provider keys as Pi readiness', async () => {
    const fixture = createExecutableFixture();
    const baseRunner = providerRunner();
    const runner = vi.fn<ProviderProbeRunner>((executable, args, options) => {
      if (path.basename(executable) === 'pi') {
        expect(options.environment).not.toHaveProperty('OPENAI_API_KEY');
      }
      if (path.basename(executable) === 'pi' && args.includes('--list-models')) {
        return Promise.resolve({ ok: true, stdout: '', stderr: '' });
      }
      return baseRunner(executable, args, options);
    });

    const [status] = await detectBuiltinProviders({
      commandRunner: runner,
      pathValue: fixture.bin,
      providerNames: ['pi'],
      environment: { PATH: fixture.bin, OPENAI_API_KEY: 'ambient-only-secret' },
    });

    expect(status).toMatchObject({ authenticated: false, ready: false });
    expect(status?.reason).toMatch(/stored Pi auth/i);
    expect(status?.reason).not.toMatch(/OPENAI|ambient-only-secret/);
  });

  it('keeps Pi unavailable when the bounded model probe times out', async () => {
    const fixture = createExecutableFixture();
    const baseRunner = providerRunner();
    const runner = vi.fn<ProviderProbeRunner>((executable, args, options) =>
      path.basename(executable) === 'pi' && args.includes('--list-models')
        ? Promise.resolve({
            ok: false,
            stdout: '',
            stderr: '',
            failure: 'timed-out',
          })
        : baseRunner(executable, args, options),
    );

    const [status] = await detectBuiltinProviders({
      commandRunner: runner,
      pathValue: fixture.bin,
      providerNames: ['pi'],
      environment: { PATH: fixture.bin },
    });

    expect(status).toMatchObject({ ready: false, reason: 'provider check timed out' });
  });

  it('keeps a provider selectable when its version differs but its contract and login are ready', async () => {
    const fixture = createExecutableFixture();
    const baseRunner = providerRunner();
    const runner = vi.fn<ProviderProbeRunner>((executable, args, options) =>
      path.basename(executable) === 'claude' && args[0] === '--version'
        ? Promise.resolve({ ok: true, stdout: '2.1.215 (Claude Code)', stderr: '' })
        : baseRunner(executable, args, options),
    );

    const [status] = await detectBuiltinProviders({
      commandRunner: runner,
      pathValue: fixture.bin,
      providerNames: ['claude'],
    });

    expect(status).toMatchObject({
      installedVersion: '2.1.215',
      parserSupported: true,
      authenticated: true,
      ready: true,
      reason: 'ready',
    });
  });

  it('reports a missing executable without launching a probe', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mdspool-config-missing-'));
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    const runner = vi.fn<ProviderProbeRunner>();

    const [status] = await detectBuiltinProviders({
      commandRunner: runner,
      pathValue: bin,
      providerNames: ['codex'],
    });

    expect(status).toMatchObject({
      installed: false,
      parserSupported: false,
      authenticated: false,
      ready: false,
      reason: 'executable not found',
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it('distinguishes timed-out and failed provider checks', async () => {
    const fixture = createExecutableFixture();
    const baseRunner = providerRunner();
    const timedOutRunner = vi.fn<ProviderProbeRunner>((executable, args, options) =>
      args[0] === 'exec'
        ? Promise.resolve({
            ok: false,
            stdout: '',
            stderr: '',
            failure: 'timed-out',
          })
        : baseRunner(executable, args, options),
    );
    const failedAuthRunner = vi.fn<ProviderProbeRunner>((executable, args, options) =>
      args[0] === 'login'
        ? Promise.resolve({ ok: false, stdout: '', stderr: '', failure: 'failed' })
        : baseRunner(executable, args, options),
    );

    const [timedOut] = await detectBuiltinProviders({
      commandRunner: timedOutRunner,
      pathValue: fixture.bin,
      providerNames: ['codex'],
    });
    const [failedAuth] = await detectBuiltinProviders({
      commandRunner: failedAuthRunner,
      pathValue: fixture.bin,
      providerNames: ['codex'],
    });

    expect(timedOut).toMatchObject({ ready: false, reason: 'provider check timed out' });
    expect(failedAuth).toMatchObject({ ready: false, reason: 'provider check failed' });
  });

  it('reports unsupported and rejected provider probes as unavailable', async () => {
    const fixture = createExecutableFixture();
    const baseRunner = providerRunner();
    const unsupportedRunner = vi.fn<ProviderProbeRunner>((executable, args, options) =>
      args[0] === 'exec'
        ? Promise.resolve({ ok: true, stdout: 'unknown machine contract', stderr: '' })
        : baseRunner(executable, args, options),
    );
    const rejectedRunner = vi.fn<ProviderProbeRunner>(() =>
      Promise.reject(new Error('injected probe rejection')),
    );

    const [unsupported] = await detectBuiltinProviders({
      commandRunner: unsupportedRunner,
      pathValue: fixture.bin,
      providerNames: ['codex'],
    });
    const [rejected] = await detectBuiltinProviders({
      commandRunner: rejectedRunner,
      pathValue: fixture.bin,
      providerNames: ['codex'],
    });

    expect(unsupported).toMatchObject({ parserSupported: false, ready: false });
    expect(unsupported?.reason).not.toBe('provider check failed');
    expect(rejected).toMatchObject({
      installed: true,
      ready: false,
      reason: 'provider check failed',
    });
  });
});

describe('repository setup derivation', () => {
  it('resolves relative clone roots and normalizes GitHub origins', async () => {
    const fixture = createRepositoryFixture(['clone']);
    const runner = repositoryRunner(
      new Map([[fixture.clones[0]!, 'git@github.com:Example/Widget.git']]),
    );

    const repositories = await deriveRepositoryMappings(['clone'], {
      baseDirectory: fixture.root,
      gitRunner: runner,
    });

    expect(repositories).toEqual([{ repository: 'example/widget', clones: [fixture.clones[0]] }]);
  });

  it('groups canonical clone roots that share an HTTPS GitHub origin', async () => {
    const fixture = createRepositoryFixture(['first', 'second']);
    const runner = repositoryRunner(
      new Map([
        [fixture.clones[0]!, 'https://github.com/example/widget.git'],
        [fixture.clones[1]!, 'https://github.com/Example/Widget'],
      ]),
    );

    const repositories = await deriveRepositoryMappings(fixture.clones, { gitRunner: runner });

    expect(repositories).toEqual([{ repository: 'example/widget', clones: fixture.clones }]);
  });

  it('accepts clean or dirty worktree roots without inspecting status', async () => {
    const fixture = createRepositoryFixture(['clean', 'dirty']);
    const runner = repositoryRunner(
      new Map(fixture.clones.map((clone) => [clone, 'https://github.com/example/widget.git'])),
    );

    await expect(deriveRepositoryMappings(fixture.clones, { gitRunner: runner })).resolves.toEqual([
      { repository: 'example/widget', clones: fixture.clones },
    ]);
    expect(runner.run.mock.calls.map(([, args]) => args)).toEqual([
      ['rev-parse', '--show-toplevel'],
      ['remote', 'get-url', 'origin'],
      ['rev-parse', '--show-toplevel'],
      ['remote', 'get-url', 'origin'],
    ]);
  });

  it('rejects a nested worktree directory before inspecting its origin', async () => {
    const fixture = createRepositoryFixture(['clone']);
    const nested = path.join(fixture.clones[0]!, 'packages', 'nested');
    mkdirSync(nested, { recursive: true });
    const run = vi.fn<GitRunner['run']>((cwd, args) => {
      if (args.join(' ') === 'rev-parse --show-toplevel') {
        return Promise.resolve({
          stdout: Buffer.from(`${fixture.clones[0]}\n`),
          stderr: Buffer.alloc(0),
          exitCode: 0,
        });
      }
      return Promise.reject(new Error(`origin must not be inspected for ${cwd}`));
    });
    const runner: GitRunner = { run };

    await expect(deriveRepositoryMappings([nested], { gitRunner: runner })).rejects.toThrow(
      SetupError,
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(nested, ['rev-parse', '--show-toplevel']);
  });

  it.each(['non-repository', 'timed-out Git', 'failed Git'])(
    'rejects a %s with a generic error that excludes Git stderr',
    async () => {
      const fixture = createRepositoryFixture(['clone']);
      const runner: GitRunner = {
        run: vi.fn<GitRunner['run']>(() =>
          Promise.reject(new Error('private Git stderr\u001b[31m with-secret')),
        ),
      };

      const error: unknown = await deriveRepositoryMappings(fixture.clones, {
        gitRunner: runner,
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(SetupError);
      expect(String(error)).not.toMatch(/private Git stderr|with-secret/);
      expect(String(error)).not.toContain('\u001b');
    },
  );

  it('rejects missing, non-GitHub, and credential-bearing origins without leaking them', async () => {
    const fixture = createRepositoryFixture(['missing', 'outside']);
    const secretOrigin = 'https://private-user:private-token@gitlab.example/internal/project.git';
    const runner: GitRunner = {
      run: vi.fn<GitRunner['run']>((cwd, args) => {
        if (args.join(' ') === 'rev-parse --show-toplevel') {
          return Promise.resolve({
            stdout: Buffer.from(`${cwd}\n`),
            stderr: Buffer.alloc(0),
            exitCode: 0,
          });
        }
        if (cwd === fixture.clones[0]) {
          return Promise.reject(new Error('origin does not exist: private-stderr'));
        }
        return Promise.resolve({
          stdout: Buffer.from(`${secretOrigin}\n`),
          stderr: Buffer.from('private-stderr'),
          exitCode: 0,
        });
      }),
    };

    for (const clone of fixture.clones) {
      const result = deriveRepositoryMappings([clone], { gitRunner: runner });
      await expect(result).rejects.toThrow(SetupError);
      await expect(result).rejects.not.toThrow(
        /private-user|private-token|gitlab\.example|private-stderr/,
      );
    }
  });

  it('rejects missing paths and files as sanitized setup failures without invoking Git', async () => {
    const fixture = createRepositoryFixture([]);
    const file = path.join(fixture.root, 'not-a-directory\u001b[31m');
    const missing = path.join(fixture.root, 'missing\u001b[31m');
    writeFileSync(file, 'not a clone');
    const run = vi.fn<GitRunner['run']>();
    const runner: GitRunner = { run };

    for (const configuredPath of [file, missing]) {
      const error: unknown = await deriveRepositoryMappings([configuredPath], {
        gitRunner: runner,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SetupError);
      expect(String(error)).not.toContain('\u001b');
    }
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects the same canonical clone twice', async () => {
    const fixture = createRepositoryFixture(['clone']);
    const runner = repositoryRunner(
      new Map([[fixture.clones[0]!, 'https://github.com/example/widget.git']]),
    );

    await expect(
      deriveRepositoryMappings([fixture.clones[0]!, fixture.clones[0]!], { gitRunner: runner }),
    ).rejects.toThrow('Clone was provided more than once');
  });
});

describe('review-safe setup publication', () => {
  it('assesses missing targets without creating filesystem state, then publishes owner-only', () => {
    const fixture = createSetupFixture();

    const candidate = assessSetupConfiguration(fixture.configPath, fixture.raw);

    expect(existsSync(path.dirname(fixture.configPath))).toBe(false);
    expect(existsSync(fixture.state)).toBe(false);

    const written = publishSetupConfiguration(candidate);

    expect(written).toBe(fixture.configPath);
    expect(lstatSync(path.dirname(fixture.configPath)).mode & 0o777).toBe(0o700);
    expect(lstatSync(fixture.state).mode & 0o777).toBe(0o700);
    expect(lstatSync(fixture.configPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(fixture.configPath, 'utf8')).toContain('codex');
  });

  it('rolls back only directories created by a failed publication', () => {
    const fixture = createSetupFixture();
    const candidate = assessSetupConfiguration(fixture.configPath, fixture.raw);

    expect(() =>
      publishSetupConfiguration(candidate, {
        createDocument: () => {
          throw new Error('injected publication failure');
        },
      }),
    ).toThrow('injected publication failure');

    expect(existsSync(path.dirname(fixture.configPath))).toBe(false);
    expect(existsSync(fixture.state)).toBe(false);
  });

  it('preserves pre-existing empty directories after a failed publication', () => {
    const fixture = createSetupFixture();
    mkdirSync(path.dirname(fixture.configPath), { recursive: true, mode: 0o700 });
    mkdirSync(fixture.state, { recursive: true, mode: 0o700 });
    const candidate = assessSetupConfiguration(fixture.configPath, fixture.raw);

    expect(() =>
      publishSetupConfiguration(candidate, {
        createDocument: () => {
          throw new Error('injected publication failure');
        },
      }),
    ).toThrow('injected publication failure');

    expect(existsSync(path.dirname(fixture.configPath))).toBe(true);
    expect(existsSync(fixture.state)).toBe(true);
  });

  it.runIf(process.platform !== 'win32')(
    'tightens a pre-existing state directory to owner-only on success',
    () => {
      const fixture = createSetupFixture();
      mkdirSync(path.dirname(fixture.configPath), { recursive: true, mode: 0o700 });
      mkdirSync(fixture.state, { recursive: true, mode: 0o755 });
      chmodSync(fixture.state, 0o755);
      const candidate = assessSetupConfiguration(fixture.configPath, fixture.raw);

      publishSetupConfiguration(candidate);

      expect(lstatSync(fixture.state).mode & 0o777).toBe(0o700);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'restores a pre-existing state directory mode after publication fails',
    () => {
      const fixture = createSetupFixture();
      mkdirSync(path.dirname(fixture.configPath), { recursive: true, mode: 0o700 });
      mkdirSync(fixture.state, { recursive: true, mode: 0o755 });
      chmodSync(fixture.state, 0o755);
      const candidate = assessSetupConfiguration(fixture.configPath, fixture.raw);

      expect(() =>
        publishSetupConfiguration(candidate, {
          createDocument: () => {
            throw new Error('injected publication failure');
          },
        }),
      ).toThrow('injected publication failure');

      expect(lstatSync(fixture.state).mode & 0o777).toBe(0o755);
    },
  );
});

function readyStatus(definition: ProviderSetupDefinition): ProviderSetupStatus {
  return {
    definition,
    installed: true,
    authenticated: true,
    parserSupported: true,
    ready: true,
    installedVersion: versionFor(definition.name),
    reason: 'ready',
    warnings: [],
  };
}

function unavailableStatus(
  definition: ProviderSetupDefinition,
  reason: string,
  overrides: Partial<ProviderSetupStatus> = {},
): ProviderSetupStatus {
  return {
    definition,
    installed: true,
    authenticated: false,
    parserSupported: true,
    installedVersion: null,
    reason,
    warnings: [],
    ...overrides,
    ready: false,
  };
}

function versionFor(provider: BuiltinProviderName): string {
  if (provider === 'claude') return '2.1.212';
  if (provider === 'codex') return '0.144.5';
  if (provider === 'pi') return '0.74.2';
  return '2026.01.28-fd13201';
}

function createExecutableFixture(): { bin: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'mdspool-config-setup-'));
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  for (const executable of ['claude', 'codex', 'cursor-agent', 'pi']) {
    writeFileSync(path.join(bin, executable), '#!/bin/sh\n', { mode: 0o755 });
  }
  return { bin };
}

function providerRunner() {
  const runner: ProviderProbeRunner = (executable, args) => {
    const provider = path.basename(executable);
    if (args[0] === '--version') {
      return Promise.resolve({
        ok: true,
        stdout: versionFor(providerName(provider)),
        stderr: '',
      });
    }
    if (args[0] === 'auth') {
      return Promise.resolve({ ok: true, stdout: '{"loggedIn":true}', stderr: '' });
    }
    if (args[0] === 'login') {
      return Promise.resolve({ ok: true, stdout: 'Logged in using ChatGPT', stderr: '' });
    }
    if (args[0] === 'about') {
      return Promise.resolve({ ok: true, stdout: 'User Email Not logged in', stderr: '' });
    }
    if (provider === 'pi' && args.includes('--list-models')) {
      return Promise.resolve({
        ok: true,
        stdout: '',
        stderr:
          'provider model context max-out thinking images\nanthropic claude-sonnet-4 200K 64K yes yes\n',
      });
    }
    const stdout =
      provider === 'claude'
        ? '--print --output-format stream-json --resume'
        : provider === 'codex'
          ? 'resume --json'
          : provider === 'pi'
            ? '--mode json --session --session-dir --tools --offline --no-extensions --no-context-files --no-skills --no-prompt-templates --list-models'
            : '--print stream-json --workspace --resume';
    return Promise.resolve({ ok: true, stdout, stderr: '' });
  };
  return vi.fn(runner);
}

function providerName(executable: string): BuiltinProviderName {
  if (executable === 'cursor-agent') return 'cursor';
  return executable as BuiltinProviderName;
}

function createSetupFixture(): {
  configPath: string;
  state: string;
  raw: RawConfig;
} {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'mdspool-setup-publish-')));
  const vault = path.join(root, 'vault');
  const clone = path.join(root, 'clone');
  const state = path.join(root, 'setup-state', 'state');
  const configPath = path.join(root, 'setup-config', 'nested', 'config.yaml');
  mkdirSync(vault);
  mkdirSync(clone);
  return {
    configPath,
    state,
    raw: {
      vaults: [vault],
      stateDirectory: state,
      timeZone: 'UTC',
      pollIntervalSeconds: 30,
      dayAliases: {},
      providers: {
        codex: {
          enabled: false,
          executable: 'codex',
          directive: '@codex',
          defaultArgs: ['--sandbox', 'read-only'],
        },
      },
      repositories: [{ repository: 'example/widget', clones: [clone] }],
    },
  };
}

function createRepositoryFixture(names: readonly string[]): { root: string; clones: string[] } {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'mdspool-repository-setup-')));
  const clones = names.map((name) => path.join(root, name));
  for (const clone of clones) mkdirSync(clone);
  return { root, clones };
}

function repositoryRunner(origins: ReadonlyMap<string, string>) {
  return {
    run: vi.fn<GitRunner['run']>((cwd, args) => {
      if (args.join(' ') === 'rev-parse --show-toplevel') {
        return Promise.resolve({
          stdout: Buffer.from(`${cwd}\n`),
          stderr: Buffer.alloc(0),
          exitCode: 0,
        });
      }
      const origin = origins.get(cwd);
      if (args.join(' ') === 'remote get-url origin' && origin !== undefined) {
        return Promise.resolve({
          stdout: Buffer.from(`${origin}\n`),
          stderr: Buffer.alloc(0),
          exitCode: 0,
        });
      }
      return Promise.reject(new Error('unexpected Git invocation'));
    }),
  };
}
