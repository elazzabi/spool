import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';

import { describe, expect, it, vi, type Mock } from 'vitest';

import type { DoctorCommandRunner } from '../../src/cli/commands/doctor.js';
import { runInit } from '../../src/cli/commands/init.js';
import {
  ClackSetupPrompter,
  PlainSetupPrompter,
  PromptCancelledError,
  type ClackBindings,
  type PromptOption,
  type PromptProgress,
  type SetupPrompter,
} from '../../src/cli/prompts.js';
import { loadConfig } from '../../src/config/load.js';
import type { SetupConfigurationCandidate } from '../../src/config/setup.js';
import type { GitRunner } from '../../src/workspaces/git.js';

describe('friendly onboarding wizard', () => {
  it('explains how to inspect and update an existing default configuration', async () => {
    const root = createTemporaryRoot();
    const configPath = path.join(root, 'spool', 'config.yaml');
    const prompter = new ScriptedPrompter();
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, 'existing configuration');

    vi.stubEnv('XDG_CONFIG_HOME', root);
    const error = await runInit({ prompter }).catch((caught: unknown) => caught);
    vi.unstubAllEnvs();

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain(`Configuration already exists at ${configPath}.`);
    expect(message).toContain(
      'spool init only creates the first configuration; it cannot continue or update an existing setup.',
    );
    expect(message).toContain('Inspect it with:\n  spool config show');
    expect(message).toContain(
      'Change watched folders or repositories with:\n  spool config watch --help\n  spool config repository --help',
    );
    expect(message).toContain('Add another supported coding agent with:\n  spool config agent add');
    expect(message).toContain(
      'For polling, time zone, or state storage, edit this YAML file directly.',
    );
    expect(message).toContain(
      'To start over or recover an unusable configuration, move this file aside and run spool init again.',
    );
    expect(message).toContain('If the daemon is running, restart it after changes.');
    expect(message).not.toContain('--config');
    expect(prompter.selectMessages).toHaveLength(0);
    expect(prompter.closed).toBe(false);
  });

  it('keeps explicit configuration guidance copy-safe and on the same file', async () => {
    const root = createTemporaryRoot();
    const configPath = path.join(root, 'setup folder', 'config.yaml');
    const original = 'existing configuration';
    const prompter = new ScriptedPrompter();
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, original);

    const error = await runInit({ configPath, prompter }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain(`spool --config '${configPath}' config show`);
    expect(message).toContain(`spool --config '${configPath}' config watch --help`);
    expect(message).toContain(`spool --config '${configPath}' config repository --help`);
    expect(message).toContain(`spool --config '${configPath}' config agent add`);
    expect(readFileSync(configPath, 'utf8')).toBe(original);
    expect(prompter.selectMessages).toHaveLength(0);
    expect(prompter.closed).toBe(false);
  });

  it('uses QuickStart defaults and persists exactly the selected ready agents', async () => {
    const fixture = createFixture();
    const prompter = new ScriptedPrompter({
      selections: ['quickstart'],
      multiselections: [['codex']],
      texts: [fixture.vault, fixture.clone],
      confirmations: [false, false, true],
    });

    vi.stubEnv('XDG_CONFIG_HOME', fixture.root);
    const result = await runInit({
      prompter,
      commandRunner: providerRunner(),
      gitRunner: fixture.gitRunner,
      pathValue: fixture.bin,
      defaultStatePath: fixture.state,
    }).finally(() => vi.unstubAllEnvs());

    expect(result.kind).toBe('created');
    if (result.kind !== 'created') throw new Error('expected setup to create configuration');
    const config = loadConfig(result.configPath, { pathValue: fixture.bin });
    expect(config.pollIntervalSeconds).toBe(30);
    expect(config.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
    expect(config.providers.map(({ name, enabled }) => [name, enabled])).toEqual([
      ['claude', false],
      ['codex', true],
      ['cursor', false],
      ['pi', false],
    ]);
    expect(config.providers.find(({ name }) => name === 'codex')?.defaultArgs).toEqual([
      '--sandbox',
      'read-only',
    ]);
    expect(prompter.textMessages).not.toContain('IANA time zone');
    expect(prompter.textMessages.every((message) => !message.includes('JSON'))).toBe(true);
    expect(prompter.notes.find(({ title }) => title === 'Review')?.message).toContain(
      'Enabled: Codex',
    );
    expect(prompter.outros.at(-1)).toContain('Enabled: Codex');
    expect(prompter.outros.at(-1)).toContain('Intentionally disabled: Claude');
    expect(prompter.outros.at(-1)).toContain('Unavailable: Cursor (not logged in)');
    expect(prompter.outros.at(-1)).toContain('Start spool with:');
    expect(prompter.outros.at(-1)).toContain('  spool daemon');
    expect(prompter.outros.at(-1)).not.toContain('spool --config');
    expect(prompter.closed).toBe(true);
    expect(fixture.gitRunner.run).toHaveBeenCalledWith(fixture.clone, [
      'rev-parse',
      '--show-toplevel',
    ]);
  });

  it('completes the line-oriented QuickStart wizard end to end', async () => {
    const fixture = createFixture();
    const output = new PassThrough();
    const input = Readable.from([
      ['', '2', '', '', fixture.vault, '', fixture.clone, '', 'y'].join('\n'),
    ]);
    const prompter = new PlainSetupPrompter({ input, output });

    const result = await runInit({
      configPath: fixture.configPath,
      prompter,
      commandRunner: providerRunner(),
      gitRunner: fixture.gitRunner,
      pathValue: fixture.bin,
      defaultStatePath: fixture.state,
    });

    expect(result.kind).toBe('created');
    const config = loadConfig(fixture.configPath, { pathValue: fixture.bin });
    expect(config.providers.map(({ name, enabled }) => [name, enabled])).toEqual([
      ['claude', false],
      ['codex', true],
      ['cursor', false],
      ['pi', false],
    ]);
    const rawOutput: unknown = output.read();
    const rendered = Buffer.isBuffer(rawOutput) ? rawOutput.toString() : '';
    expect(rendered).toContain(
      'Agent workspace: Choose an existing project folder on this computer.',
    );
    expect(rendered).toContain('Review: Mode: QuickStart\nEnabled: Codex\n');
    expect(rendered).toContain('Setup complete.\nConfiguration:');
    expect(rendered).not.toContain('\u001b[');
  });

  it('completes the rich QuickStart wizard with unrestricted and custom arguments', async () => {
    const fixture = createFixture();
    const argumentEntries = ['--model', 'gpt-5.6', ''];
    const bindings: ClackBindings = {
      intro: vi.fn(),
      outro: vi.fn(),
      note: vi.fn(),
      text: vi.fn((options: Parameters<ClackBindings['text']>[0]) => {
        const { message } = options;
        if (message.startsWith('Next literal argument')) {
          return Promise.resolve(argumentEntries.shift() ?? '');
        }
        if (message === 'Obsidian or Markdown folder to watch') {
          return Promise.resolve(fixture.vault);
        }
        if (message === 'Project folder agents may work in') {
          return Promise.resolve(fixture.clone);
        }
        return Promise.resolve('');
      }),
      select: vi.fn((options: Parameters<ClackBindings['select']>[0]) => {
        const { message } = options;
        return Promise.resolve(
          message === 'How would you like to set up spool?'
            ? 'quickstart'
            : message === 'Codex access profile'
              ? 'unrestricted'
              : 'add',
        );
      }),
      multiselect: vi.fn(() => Promise.resolve(['codex'])),
      confirm: vi.fn((options: Parameters<ClackBindings['confirm']>[0]) => {
        const { message, initialValue } = options;
        return Promise.resolve(message.includes('bypass approval prompts') || initialValue);
      }),
      isCancel: () => false,
      spinner: vi.fn(() => ({
        start: vi.fn(),
        message: vi.fn(),
        stop: vi.fn(),
      })),
    };
    const prompter = new ClackSetupPrompter({ bindings });

    const result = await runInit({
      configPath: fixture.configPath,
      prompter,
      commandRunner: providerRunner(),
      gitRunner: fixture.gitRunner,
      pathValue: fixture.bin,
      defaultStatePath: fixture.state,
    });

    expect(result.kind).toBe('created');
    expect(
      loadConfig(fixture.configPath, { pathValue: fixture.bin }).providers.find(
        ({ name }) => name === 'codex',
      )?.defaultArgs,
    ).toEqual(['--dangerously-bypass-approvals-and-sandbox', '--model', 'gpt-5.6']);
    expect(bindings.note).toHaveBeenCalledWith(
      expect.stringContaining('Codex [UNRESTRICTED]'),
      'Review',
      expect.anything(),
    );
  });

  it('keeps secondary settings in Advanced setup while using recommended provider profiles', async () => {
    const fixture = createFixture();
    const customState = path.join(fixture.root, 'custom-state');
    const prompter = new ScriptedPrompter({
      selections: ['advanced'],
      multiselections: [['claude', 'codex']],
      texts: [fixture.vault, fixture.clone, 'UTC', '25', customState],
      confirmations: [false, false, true],
    });

    const result = await runInit({
      configPath: fixture.configPath,
      prompter,
      commandRunner: providerRunner(),
      gitRunner: fixture.gitRunner,
      pathValue: fixture.bin,
    });

    expect(result.kind).toBe('created');
    if (result.kind !== 'created') throw new Error('expected setup to create configuration');
    const config = loadConfig(result.configPath, { pathValue: fixture.bin });
    expect(config.timeZone).toBe('UTC');
    expect(config.pollIntervalSeconds).toBe(25);
    expect(config.stateDirectory).toBe(customState);
    expect(result.daemonCommand).toBe(`spool --config ${fixture.configPath} daemon`);
    expect(prompter.textMessages.every((message) => !message.includes('flags'))).toBe(true);
    expect(prompter.selectMessages).toEqual([
      'How would you like to set up spool?',
      'Claude access profile',
      'Additional arguments for Claude?',
      'Codex access profile',
      'Additional arguments for Codex?',
    ]);
  });

  it('persists and reviews a warned Codex unrestricted profile with literal extra arguments', async () => {
    const fixture = createFixture();
    const prompter = new ScriptedPrompter({
      selections: ['quickstart', 'unrestricted', 'add'],
      multiselections: [['codex']],
      texts: ['--model', 'gpt-5.6', '', fixture.vault, fixture.clone],
      confirmations: [true, false, false, true],
    });

    const result = await runInit({
      configPath: fixture.configPath,
      prompter,
      commandRunner: providerRunner(),
      gitRunner: fixture.gitRunner,
      pathValue: fixture.bin,
      defaultStatePath: fixture.state,
    });

    expect(result.kind).toBe('created');
    const codex = loadConfig(fixture.configPath, { pathValue: fixture.bin }).providers.find(
      ({ name }) => name === 'codex',
    );
    expect(codex?.defaultArgs).toEqual([
      '--dangerously-bypass-approvals-and-sandbox',
      '--model',
      'gpt-5.6',
    ]);
    expect(prompter.confirmMessages[0]).toMatch(/bypass approval prompts and sandboxing/i);
    const review = prompter.notes.find(({ title }) => title === 'Review')?.message ?? '';
    expect(review).toContain('Codex [UNRESTRICTED]');
    expect(review).toContain(
      'Configured defaultArgs: --dangerously-bypass-approvals-and-sandbox --model gpt-5.6',
    );
    expect(review).toContain(
      'Adapter-enforced: exec, --json, - (stdin prompt), resume <session-id>',
    );
  });

  it('returns to profile selection when Claude elevation is declined', async () => {
    const fixture = createFixture();
    const prompter = new ScriptedPrompter({
      selections: ['quickstart', 'unrestricted', 'recommended', 'none'],
      multiselections: [['claude']],
      texts: [fixture.vault, fixture.clone],
      confirmations: [false, false, false, true],
    });

    const result = await runInit({
      configPath: fixture.configPath,
      prompter,
      commandRunner: providerRunner(),
      gitRunner: fixture.gitRunner,
      pathValue: fixture.bin,
      defaultStatePath: fixture.state,
    });

    expect(result.kind).toBe('created');
    expect(
      loadConfig(fixture.configPath, { pathValue: fixture.bin }).providers.find(
        ({ name }) => name === 'claude',
      )?.defaultArgs,
    ).toEqual(['--permission-mode', 'plan']);
    expect(
      prompter.selectMessages.filter((message) => message === 'Claude access profile'),
    ).toHaveLength(2);
  });

  it('offers Cursor direct changes but no unrestricted Pi profile', async () => {
    const cursorFixture = createFixture();
    const cursorPrompter = new ScriptedPrompter({
      selections: ['quickstart', 'unrestricted', 'none'],
      multiselections: [['cursor']],
      texts: [cursorFixture.vault, cursorFixture.clone],
      confirmations: [true, false, false, true],
    });

    await runInit({
      configPath: cursorFixture.configPath,
      prompter: cursorPrompter,
      commandRunner: providerRunnerWithCursorReady(),
      gitRunner: cursorFixture.gitRunner,
      pathValue: cursorFixture.bin,
      defaultStatePath: cursorFixture.state,
    });
    expect(
      loadConfig(cursorFixture.configPath, { pathValue: cursorFixture.bin }).providers.find(
        ({ name }) => name === 'cursor',
      )?.defaultArgs,
    ).toEqual(['--force']);

    const piFixture = createFixture();
    const piPrompter = new ScriptedPrompter({
      selections: ['quickstart', 'custom-only', 'add'],
      multiselections: [['pi']],
      texts: [
        '--tools=all',
        '--extension',
        '--no-session',
        '--model',
        'local/model',
        '',
        piFixture.vault,
        piFixture.clone,
      ],
      confirmations: [false, false, true],
    });
    await runInit({
      configPath: piFixture.configPath,
      prompter: piPrompter,
      commandRunner: providerRunner(),
      gitRunner: piFixture.gitRunner,
      pathValue: piFixture.bin,
      defaultStatePath: piFixture.state,
      environment: { PATH: piFixture.bin },
    });

    const piProfile = piPrompter.selectOptions.find(
      ({ message }) => message === 'Pi access profile',
    );
    expect(piProfile?.values).toEqual(['recommended', 'custom-only']);
    expect(piPrompter.notes.filter(({ message }) => /spool-managed/.test(message))).toHaveLength(3);
    expect(
      loadConfig(piFixture.configPath, { pathValue: piFixture.bin }).providers.find(
        ({ name }) => name === 'pi',
      )?.defaultArgs,
    ).toEqual(['--model', 'local/model']);
  });

  it('retries credential-shaped custom arguments without leaking their value', async () => {
    const fixture = createFixture();
    const canary = '--api-key=private-canary-value';
    const hostile = 'model with spaces; printf unsafe\u001b[31m';
    const prompter = new ScriptedPrompter({
      selections: ['quickstart', 'custom-only', 'add'],
      multiselections: [['codex']],
      texts: [canary, '--model', hostile, '', fixture.vault, fixture.clone],
      confirmations: [false, false, true],
    });

    const result = await runInit({
      configPath: fixture.configPath,
      prompter,
      commandRunner: providerRunner(),
      gitRunner: fixture.gitRunner,
      pathValue: fixture.bin,
      defaultStatePath: fixture.state,
    });

    expect(result.kind).toBe('created');
    const rendered = [...prompter.notes.map(({ message }) => message), ...prompter.outros].join(
      '\n',
    );
    expect(rendered).not.toContain('private-canary-value');
    expect(rendered).not.toContain('\u001b');
    expect(rendered).toContain("'model with spaces; printf unsafe[31m'");
    expect(
      loadConfig(fixture.configPath, { pathValue: fixture.bin }).providers.find(
        ({ name }) => name === 'codex',
      )?.defaultArgs,
    ).toEqual(['--model', hostile]);
  });

  it.each(['profile', 'warning', 'extra'] as const)(
    'writes nothing when setup is cancelled at the provider %s prompt',
    async (stage) => {
      const fixture = createFixture();
      const prompter = new ScriptedPrompter({
        selections:
          stage === 'profile'
            ? ['quickstart', new PromptCancelledError()]
            : stage === 'warning'
              ? ['quickstart', 'unrestricted']
              : ['quickstart', 'recommended', 'add'],
        multiselections: [['codex']],
        texts: stage === 'extra' ? [new PromptCancelledError()] : [],
        confirmations: stage === 'warning' ? [new PromptCancelledError()] : [],
      });

      const result = await runInit({
        configPath: fixture.configPath,
        prompter,
        commandRunner: providerRunner(),
        pathValue: fixture.bin,
      });

      expect(result).toMatchObject({ kind: 'not-created', reason: 'cancelled' });
      expect(existsSync(fixture.configPath)).toBe(false);
      expect(prompter.closed).toBe(true);
    },
  );

  it('returns to agent selection when empty exit is declined', async () => {
    const fixture = createFixture();
    const prompter = new ScriptedPrompter({
      selections: ['quickstart'],
      multiselections: [[], ['codex']],
      texts: [fixture.vault, fixture.clone],
      confirmations: [false, false, false, true],
    });

    const result = await runInit({
      configPath: fixture.configPath,
      prompter,
      commandRunner: providerRunner(),
      gitRunner: fixture.gitRunner,
      pathValue: fixture.bin,
      defaultStatePath: fixture.state,
    });

    expect(result.kind).toBe('created');
    expect(prompter.multiselectMessages).toHaveLength(2);
  });

  it('rechecks selected agents and returns to the updated list without recollecting paths', async () => {
    const fixture = createFixture();
    const baseRunner = providerRunner();
    let codexLoginChecks = 0;
    const commandRunner = vi.fn<DoctorCommandRunner>((executable, args, runOptions) => {
      if (path.basename(executable) === 'codex' && args[0] === 'login') {
        codexLoginChecks += 1;
        if (codexLoginChecks >= 2) {
          return Promise.resolve({ ok: true, stdout: 'Not logged in', stderr: '' });
        }
      }
      return baseRunner(executable, args, runOptions);
    });
    const prompter = new ScriptedPrompter({
      selections: ['quickstart'],
      multiselections: [['codex'], ['claude']],
      texts: [fixture.vault, fixture.clone],
      confirmations: [false, false, true],
    });

    const result = await runInit({
      configPath: fixture.configPath,
      prompter,
      commandRunner,
      gitRunner: fixture.gitRunner,
      pathValue: fixture.bin,
      defaultStatePath: fixture.state,
    });

    expect(result.kind).toBe('created');
    const config = loadConfig(fixture.configPath, { pathValue: fixture.bin });
    expect(config.providers.map(({ name, enabled }) => [name, enabled])).toEqual([
      ['claude', true],
      ['codex', false],
      ['cursor', false],
      ['pi', false],
    ]);
    expect(prompter.multiselectMessages).toHaveLength(2);
    expect(prompter.textMessages).toEqual([
      'Obsidian or Markdown folder to watch',
      'Project folder agents may work in',
    ]);
    expect(prompter.notes.find(({ title }) => title === 'Agent workspace')?.message).toBe(
      'Choose an existing project folder on this computer. It must be a Git checkout with a GitHub origin. spool makes the folder available to selected agents; it does not clone repositories or clean local changes.',
    );
    expect(prompter.notes.some(({ title }) => title === 'Agent status changed')).toBe(true);
  });

  it('preserves retained choices, drops stale elevation, and configures newly selected agents', async () => {
    const fixture = createFixture();
    const baseRunner = providerRunnerWithCursorReady();
    let codexLoginChecks = 0;
    const commandRunner = vi.fn<DoctorCommandRunner>((executable, args, options) => {
      if (path.basename(executable) === 'codex' && args[0] === 'login') {
        codexLoginChecks += 1;
        if (codexLoginChecks >= 2) {
          return Promise.resolve({ ok: true, stdout: 'Not logged in', stderr: '' });
        }
      }
      return baseRunner(executable, args, options);
    });
    const prompter = new ScriptedPrompter({
      selections: [
        'quickstart',
        'unrestricted',
        'none',
        'unrestricted',
        'none',
        'unrestricted',
        'none',
      ],
      multiselections: [
        ['claude', 'codex'],
        ['claude', 'cursor'],
      ],
      texts: [fixture.vault, fixture.clone],
      confirmations: [true, true, false, false, true, true],
    });

    const result = await runInit({
      configPath: fixture.configPath,
      prompter,
      commandRunner,
      gitRunner: fixture.gitRunner,
      pathValue: fixture.bin,
      defaultStatePath: fixture.state,
    });

    expect(result.kind).toBe('created');
    const providers = loadConfig(fixture.configPath, { pathValue: fixture.bin }).providers;
    expect(providers.find(({ name }) => name === 'claude')?.defaultArgs).toEqual([
      '--dangerously-skip-permissions',
    ]);
    expect(providers.find(({ name }) => name === 'codex')).toMatchObject({
      enabled: false,
      defaultArgs: ['--sandbox', 'read-only'],
    });
    expect(providers.find(({ name }) => name === 'cursor')?.defaultArgs).toEqual(['--force']);
    expect(prompter.selectMessages.filter((message) => /access profile$/.test(message))).toEqual([
      'Claude access profile',
      'Codex access profile',
      'Cursor access profile',
    ]);
  });

  it('persists Pi safe defaults and shows drift plus trust limits before publication', async () => {
    const fixture = createFixture();
    const baseRunner = providerRunner();
    const commandRunner = vi.fn<DoctorCommandRunner>((executable, args, options) => {
      if (path.basename(executable) === 'pi' && args.includes('--version')) {
        return Promise.resolve({ ok: true, stdout: 'pi 0.75.0', stderr: '' });
      }
      return baseRunner(executable, args, options);
    });
    const prompter = new ScriptedPrompter({
      selections: ['quickstart'],
      multiselections: [['pi']],
      texts: [fixture.vault, fixture.clone],
      confirmations: [false, false, true],
    });

    const result = await runInit({
      configPath: fixture.configPath,
      prompter,
      commandRunner,
      gitRunner: fixture.gitRunner,
      pathValue: fixture.bin,
      defaultStatePath: fixture.state,
      environment: {
        PATH: fixture.bin,
        PI_CODING_AGENT_DIR: path.join(fixture.root, 'pi-config'),
      },
    });

    expect(result.kind).toBe('created');
    const config = loadConfig(fixture.configPath, { pathValue: fixture.bin });
    const pi = config.providers.find(({ name }) => name === 'pi');
    expect(pi).toMatchObject({
      enabled: true,
      directive: '@pi',
      defaultArgs: [
        '--offline',
        '--tools',
        'read,grep,find,ls',
        '--no-extensions',
        '--no-context-files',
        '--no-skills',
        '--no-prompt-templates',
      ],
    });
    expect(pi?.executable).toBe(path.join(fixture.bin, 'pi'));
    const limits = prompter.notes.find(({ title }) => title === 'Pi access limits')?.message ?? '';
    expect(limits).toMatch(/file review/i);
    expect(limits).toMatch(/host-readable/i);
    expect(limits).toMatch(/Git diff/i);
    const review = prompter.notes.find(({ title }) => title === 'Review')?.message ?? '';
    expect(review).toContain('Enabled: Pi');
    expect(review).toContain('0.75.0 differs from validated baseline 0.74.2');
    expect(prompter.notes.find(({ title }) => title === 'Agent workspace')?.message).toBe(
      'Choose an existing project folder on this computer. It must be a Git checkout with a GitHub origin. spool makes the folder available to selected agents; it does not clone repositories or clean local changes.',
    );
  });

  it('rechecks Pi model readiness under the sanitized environment before publication', async () => {
    const fixture = createFixture();
    const baseRunner = providerRunner();
    let modelChecks = 0;
    const commandRunner = vi.fn<DoctorCommandRunner>((executable, args, options) => {
      if (path.basename(executable) === 'pi' && args.includes('--list-models')) {
        modelChecks += 1;
        if (modelChecks >= 2) {
          return Promise.resolve({
            ok: true,
            stdout: '',
            stderr: 'provider model context max-out thinking images\n',
          });
        }
      }
      return baseRunner(executable, args, options);
    });
    const prompter = new ScriptedPrompter({
      selections: ['quickstart'],
      multiselections: [['pi'], ['codex']],
      texts: [fixture.vault, fixture.clone],
      confirmations: [false, false, true],
    });

    const result = await runInit({
      configPath: fixture.configPath,
      prompter,
      commandRunner,
      gitRunner: fixture.gitRunner,
      pathValue: fixture.bin,
      defaultStatePath: fixture.state,
      environment: { PATH: fixture.bin },
    });

    expect(result.kind).toBe('created');
    expect(modelChecks).toBe(2);
    expect(prompter.notes.some(({ title }) => title === 'Agent status changed')).toBe(true);
    expect(loadConfig(fixture.configPath, { pathValue: fixture.bin }).providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'pi', enabled: false }),
        expect.objectContaining({ name: 'codex', enabled: true }),
      ]),
    );
  });

  it('retries only invalid Advanced values and preserves prior answers', async () => {
    const fixture = createFixture();
    const prompter = new ScriptedPrompter({
      selections: ['advanced'],
      multiselections: [['codex']],
      texts: [fixture.vault, fixture.clone, 'Invalid/Zone', 'UTC', '99', '20', fixture.state],
      confirmations: [false, false, true],
    });

    const result = await runInit({
      configPath: fixture.configPath,
      prompter,
      commandRunner: providerRunner(),
      gitRunner: fixture.gitRunner,
      pathValue: fixture.bin,
    });

    expect(result.kind).toBe('created');
    expect(prompter.textMessages.filter((message) => message === 'IANA time zone')).toHaveLength(2);
    expect(
      prompter.textMessages.filter((message) => message === 'Polling interval in seconds (1-45)'),
    ).toHaveLength(2);
    expect(prompter.notes.filter(({ title }) => title === 'Check this value')).toHaveLength(2);
  });

  it('writes nothing when no agent is ready or the operator exits with none selected', async () => {
    const unavailableFixture = createFixture();
    const unavailablePrompter = new ScriptedPrompter({ selections: ['quickstart'] });

    const unavailable = await runInit({
      configPath: unavailableFixture.configPath,
      prompter: unavailablePrompter,
      commandRunner: providerRunner({ allLoggedOut: true }),
      pathValue: unavailableFixture.bin,
    });

    expect(unavailable).toMatchObject({ kind: 'not-created', reason: 'no-ready-agents' });
    expect(unavailablePrompter.multiselectMessages).toHaveLength(0);
    expect(unavailablePrompter.outros.at(-1)).toContain('spool init');
    expect(existsSync(path.dirname(unavailableFixture.configPath))).toBe(false);

    const emptyFixture = createFixture();
    const emptyPrompter = new ScriptedPrompter({
      selections: ['quickstart'],
      multiselections: [[]],
      confirmations: [true],
    });
    const empty = await runInit({
      configPath: emptyFixture.configPath,
      prompter: emptyPrompter,
      commandRunner: providerRunner(),
      pathValue: emptyFixture.bin,
    });

    expect(empty).toMatchObject({ kind: 'not-created', reason: 'no-agents-selected' });
    expect(existsSync(path.dirname(emptyFixture.configPath))).toBe(false);
  });

  it('turns prompt cancellation into one calm no-write outcome', async () => {
    const fixture = createFixture();
    const prompter = new ScriptedPrompter({ selections: [new PromptCancelledError()] });

    const result = await runInit({
      configPath: fixture.configPath,
      prompter,
      pathValue: fixture.bin,
    });

    expect(result).toMatchObject({ kind: 'not-created', reason: 'cancelled' });
    expect(prompter.outros).toEqual(['Setup cancelled. Nothing was written.']);
    expect(prompter.closed).toBe(true);
    expect(existsSync(path.dirname(fixture.configPath))).toBe(false);
  });

  it('leaves no setup paths when the final review is declined', async () => {
    const fixture = createFixture();
    const prompter = new ScriptedPrompter({
      selections: ['quickstart'],
      multiselections: [['codex']],
      texts: [fixture.vault, fixture.clone],
      confirmations: [false, false, false],
    });

    const result = await runInit({
      configPath: fixture.configPath,
      prompter,
      commandRunner: providerRunner(),
      gitRunner: fixture.gitRunner,
      pathValue: fixture.bin,
      defaultStatePath: fixture.state,
    });

    expect(result).toMatchObject({ kind: 'not-created', reason: 'final-review-declined' });
    expect(existsSync(path.dirname(fixture.configPath))).toBe(false);
    expect(existsSync(fixture.state)).toBe(false);
  });

  it('sanitizes a publication failure, rolls back setup directories, and remains retryable', async () => {
    const fixture = createFixture();
    const prompter = new ScriptedPrompter({
      selections: ['quickstart'],
      multiselections: [['codex']],
      texts: [fixture.vault, fixture.clone],
      confirmations: [false, false, true],
    });
    const publishConfiguration = vi.fn((candidate: SetupConfigurationCandidate) => {
      void candidate;
      throw new Error('failed\u001b with private-detail');
    });

    await expect(
      runInit({
        configPath: fixture.configPath,
        prompter,
        commandRunner: providerRunner(),
        gitRunner: fixture.gitRunner,
        pathValue: fixture.bin,
        defaultStatePath: fixture.state,
        publishConfiguration,
      }),
    ).rejects.toThrow('private-detail');

    expect(prompter.outros.at(-1)).toBe(
      'Setup could not publish the configuration. Nothing partial was kept; fix the issue and rerun spool init.',
    );
    expect(prompter.outros.at(-1)).not.toContain('\u001b');
    expect(existsSync(fixture.state)).toBe(false);
    expect(existsSync(fixture.configPath)).toBe(false);
  });
});

class ScriptedPrompter implements SetupPrompter {
  readonly #selections: Array<string | Error>;
  readonly #multiselections: string[][];
  readonly #texts: Array<string | Error>;
  readonly #confirmations: Array<boolean | Error>;
  readonly notes: Array<{ message: string; title?: string }> = [];
  readonly outros: string[] = [];
  readonly textMessages: string[] = [];
  readonly selectMessages: string[] = [];
  readonly selectOptions: Array<{ message: string; values: string[] }> = [];
  readonly confirmMessages: string[] = [];
  readonly multiselectMessages: string[] = [];
  closed = false;

  constructor(
    responses: {
      selections?: Array<string | Error>;
      multiselections?: string[][];
      texts?: Array<string | Error>;
      confirmations?: Array<boolean | Error>;
    } = {},
  ) {
    this.#selections = [...(responses.selections ?? [])];
    this.#multiselections = [...(responses.multiselections ?? [])];
    this.#texts = [...(responses.texts ?? [])];
    this.#confirmations = [...(responses.confirmations ?? [])];
  }

  intro(message: string): void {
    void message;
  }

  outro(message: string): void {
    this.outros.push(message);
  }

  note(message: string, title?: string): void {
    this.notes.push({ message, ...(title === undefined ? {} : { title }) });
  }

  text(message: string, defaultValue?: string): Promise<string> {
    this.textMessages.push(message);
    const value = this.#texts.shift() ?? defaultValue ?? '';
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  }

  select<Value extends string>(
    message: string,
    options: readonly PromptOption<Value>[],
    initialValue?: Value,
  ): Promise<Value> {
    this.selectMessages.push(message);
    this.selectOptions.push({ message, values: options.map(({ value }) => value) });
    const value = this.#selections.shift() ?? initialValue;
    if (value instanceof Error) return Promise.reject(value);
    if (value === undefined) return Promise.reject(new Error('missing scripted selection'));
    return Promise.resolve(value as Value);
  }

  multiselect<Value extends string>(
    message: string,
    _options: readonly PromptOption<Value>[],
    initialValues: readonly Value[] = [],
  ): Promise<Value[]> {
    this.multiselectMessages.push(message);
    return Promise.resolve((this.#multiselections.shift() ?? [...initialValues]) as Value[]);
  }

  confirm(message: string, initialValue: boolean): Promise<boolean> {
    this.confirmMessages.push(message);
    const value = this.#confirmations.shift() ?? initialValue;
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  }

  async progress<Result>(
    _message: string,
    task: (progress: PromptProgress) => Promise<Result>,
    successMessage?: string,
  ): Promise<Result> {
    void successMessage;
    return task({ update: () => undefined });
  }

  close(): void {
    this.closed = true;
  }
}

function providerRunner(options: { allLoggedOut?: boolean } = {}): DoctorCommandRunner {
  const runner: DoctorCommandRunner = (executable, args) => {
    const provider = path.basename(executable);
    if (args[0] === '--version') {
      const version =
        provider === 'claude'
          ? '2.1.212 (Claude Code)'
          : provider === 'codex'
            ? 'codex-cli 0.144.5'
            : provider === 'pi'
              ? 'pi 0.74.2'
              : 'cursor-agent 2026.01.28-fd13201';
      return Promise.resolve({ ok: true, stdout: version, stderr: '' });
    }
    if (args[0] === 'auth') {
      return Promise.resolve({
        ok: true,
        stdout: options.allLoggedOut ? '{"loggedIn":false}' : '{"loggedIn":true}',
        stderr: '',
      });
    }
    if (args[0] === 'login') {
      return Promise.resolve({
        ok: true,
        stdout: options.allLoggedOut ? 'Not logged in' : 'Logged in using ChatGPT',
        stderr: '',
      });
    }
    if (args[0] === 'about') {
      return Promise.resolve({ ok: true, stdout: 'User Email Not logged in', stderr: '' });
    }
    if (provider === 'pi' && args.includes('--list-models')) {
      return Promise.resolve({
        ok: true,
        stdout: '',
        stderr: options.allLoggedOut
          ? 'provider model context max-out thinking images\n'
          : 'provider model context max-out thinking images\nanthropic claude-sonnet-4 200K 64K yes yes\n',
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

function providerRunnerWithCursorReady(): DoctorCommandRunner {
  const base = providerRunner();
  return vi.fn<DoctorCommandRunner>((executable, args, options) =>
    path.basename(executable) === 'cursor-agent' && args[0] === 'about'
      ? Promise.resolve({ ok: true, stdout: 'User Email developer@example.test', stderr: '' })
      : base(executable, args, options),
  );
}

function createFixture(): {
  root: string;
  vault: string;
  clone: string;
  state: string;
  bin: string;
  configPath: string;
  gitRunner: { run: Mock<GitRunner['run']> };
} {
  const root = createTemporaryRoot();
  const vault = path.join(root, 'vault');
  const clone = path.join(root, 'clone');
  const state = path.join(root, 'state');
  const bin = path.join(root, 'bin');
  for (const directory of [vault, clone, bin]) mkdirSync(directory);
  for (const executable of ['claude', 'codex', 'cursor-agent', 'pi']) {
    writeFileSync(path.join(bin, executable), '#!/bin/sh\n', { mode: 0o755 });
  }
  return {
    root,
    vault,
    clone,
    state,
    bin,
    configPath: path.join(root, 'setup', 'config.yaml'),
    gitRunner: {
      run: vi.fn<GitRunner['run']>((cwd, args) => {
        const stdout =
          args.join(' ') === 'rev-parse --show-toplevel'
            ? `${cwd}\n`
            : 'https://github.com/example/widget.git\n';
        return Promise.resolve({
          stdout: Buffer.from(stdout),
          stderr: Buffer.alloc(0),
          exitCode: 0,
        });
      }),
    },
  };
}

function createTemporaryRoot(): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), 'spool-init-')));
}
