import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runConfigAgentAdd } from '../../src/cli/commands/config-agent.js';
import {
  ClackSetupPrompter,
  PlainSetupPrompter,
  PromptCancelledError,
  type ClackBindings,
  type PromptOption,
  type PromptProgress,
  type SetupPrompter,
} from '../../src/cli/prompts.js';
import { createConfigDocument, readRawConfigDocument } from '../../src/config/document.js';
import { loadConfig } from '../../src/config/load.js';
import type { RawConfig } from '../../src/config/schema.js';
import type { ProviderProbeRunner } from '../../src/config/setup.js';
import { currentProcessStartIdentity } from '../../src/process-identity.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('post-init agent enrollment', () => {
  it('replaces one disabled provider with the reviewed profile and leaves everything else intact', async () => {
    const fixture = createFixture();
    fixture.raw.providers.codex!.defaultArgs = ['--api-key', 'old-secret'];
    writeFileSync(fixture.configPath, yaml(fixture.raw), { mode: 0o600 });
    const before = readRawConfigDocument(fixture.configPath).raw;
    const prompter = new ScriptedPrompter({
      selections: ['codex', 'unrestricted', 'add'],
      texts: ['--model', 'gpt-5.6', ''],
      confirmations: [true, true],
    });

    const result = await runConfigAgentAdd({
      configPath: fixture.configPath,
      prompter,
      commandRunner: providerRunner(),
      pathValue: fixture.bin,
    });

    expect(result).toMatchObject({ kind: 'added', provider: 'codex' });
    const after = readRawConfigDocument(fixture.configPath).raw;
    expect(after).toEqual({
      ...before,
      providers: {
        ...before.providers,
        codex: {
          enabled: true,
          executable: 'codex',
          directive: '@codex',
          defaultArgs: ['--dangerously-bypass-approvals-and-sandbox', '--model', 'gpt-5.6'],
        },
      },
    });
    const review = prompter.notes.find(({ title }) => title === 'Review')?.message;
    expect(review).toContain('Replace disabled Codex configuration');
    expect(review).toContain(fixture.configPath);
    expect(review).toContain('[REDACTED]');
    expect(review).not.toContain('old-secret');
    expect(prompter.outros.at(-1)).toContain('Restart a running daemon');
    expect(prompter.closed).toBe(true);
  });

  it('adds a missing provider through an explicit configuration path', async () => {
    const fixture = createFixture();
    delete fixture.raw.providers.cursor;
    writeFileSync(fixture.configPath, yaml(fixture.raw), { mode: 0o600 });
    const prompter = new ScriptedPrompter({
      selections: ['cursor', 'recommended', 'none'],
      confirmations: [true],
    });

    const result = await runConfigAgentAdd({
      configPath: fixture.configPath,
      prompter,
      commandRunner: providerRunner(),
      pathValue: fixture.bin,
    });

    expect(result).toMatchObject({ kind: 'added', provider: 'cursor' });
    expect(loadConfig(fixture.configPath, { pathValue: fixture.bin }).providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'cursor',
          enabled: true,
          directive: '@cursor',
          defaultArgs: ['--mode', 'plan'],
        }),
      ]),
    );
    expect(prompter.notes.find(({ title }) => title === 'Review')?.message).toContain('Add Cursor');
  });

  it('exits without prompting or writing when every built-in is enabled', async () => {
    const fixture = createFixture();
    for (const provider of Object.values(fixture.raw.providers)) provider.enabled = true;
    writeFileSync(fixture.configPath, yaml(fixture.raw), { mode: 0o600 });
    const original = readFileSync(fixture.configPath, 'utf8');
    const prompter = new ScriptedPrompter();
    const commandRunner = providerRunner();

    const result = await runConfigAgentAdd({
      configPath: fixture.configPath,
      prompter,
      commandRunner,
      pathValue: fixture.bin,
    });

    expect(result).toEqual({ kind: 'not-added', reason: 'no-addable-agents' });
    expect(commandRunner).not.toHaveBeenCalled();
    expect(prompter.selectMessages).toHaveLength(0);
    expect(readFileSync(fixture.configPath, 'utf8')).toBe(original);
    expect(existsSync(`${fixture.configPath}.backup`)).toBe(false);
    expect(prompter.closed).toBe(true);
  });

  it('does not offer a missing built-in whose directive belongs to a custom provider', async () => {
    const fixture = createFixture();
    for (const [name, provider] of Object.entries(fixture.raw.providers)) {
      provider.enabled = name !== 'cursor';
    }
    delete fixture.raw.providers.cursor;
    fixture.raw.providers.custom = {
      enabled: true,
      executable: 'custom-agent',
      directive: '@CURSOR',
      defaultArgs: [],
    };
    writeFileSync(fixture.configPath, yaml(fixture.raw), { mode: 0o600 });
    const original = readFileSync(fixture.configPath, 'utf8');
    const prompter = new ScriptedPrompter();

    const result = await runConfigAgentAdd({
      configPath: fixture.configPath,
      prompter,
      commandRunner: providerRunner(),
      pathValue: fixture.bin,
    });

    expect(result).toEqual({ kind: 'not-added', reason: 'no-addable-agents' });
    expect(prompter.notes.find(({ title }) => title === 'Directive conflict')?.message).toContain(
      '@cursor',
    );
    expect(readFileSync(fixture.configPath, 'utf8')).toBe(original);
  });

  it('refreshes selection when the chosen provider loses readiness', async () => {
    const fixture = createFixture();
    const base = providerRunner();
    let codexLogins = 0;
    const commandRunner = vi.fn<ProviderProbeRunner>((executable, args, options) => {
      if (path.basename(executable) === 'codex' && args[0] === 'login') {
        codexLogins += 1;
        if (codexLogins >= 2) {
          return Promise.resolve({ ok: true, stdout: 'Not logged in', stderr: '' });
        }
      }
      return base(executable, args, options);
    });
    const prompter = new ScriptedPrompter({
      selections: ['codex', 'recommended', 'none', 'claude', 'recommended', 'none'],
      confirmations: [true],
    });

    const result = await runConfigAgentAdd({
      configPath: fixture.configPath,
      prompter,
      commandRunner,
      pathValue: fixture.bin,
    });

    expect(result).toMatchObject({ kind: 'added', provider: 'claude' });
    expect(
      prompter.selectMessages.filter((message) => message === 'Which agent should spool add?'),
    ).toHaveLength(2);
    expect(prompter.notes.some(({ title }) => title === 'Agent status changed')).toBe(true);
    expect(readRawConfigDocument(fixture.configPath).raw.providers.codex?.enabled).toBe(false);
    expect(readRawConfigDocument(fixture.configPath).raw.providers.claude?.enabled).toBe(true);
  });

  it.each(['cancel', 'decline'] as const)('writes nothing on final %s', async (stage) => {
    const fixture = createFixture();
    const original = readFileSync(fixture.configPath, 'utf8');
    const prompter = new ScriptedPrompter({
      selections: [
        'codex',
        stage === 'cancel' ? new PromptCancelledError() : 'recommended',
        'none',
      ],
      confirmations: stage === 'decline' ? [false] : [],
    });

    const result = await runConfigAgentAdd({
      configPath: fixture.configPath,
      prompter,
      commandRunner: providerRunner(),
      pathValue: fixture.bin,
    });

    expect(result).toEqual({
      kind: 'not-added',
      reason: stage === 'cancel' ? 'cancelled' : 'final-review-declined',
    });
    expect(readFileSync(fixture.configPath, 'utf8')).toBe(original);
    expect(existsSync(`${fixture.configPath}.backup`)).toBe(false);
    expect(prompter.closed).toBe(true);
  });

  it('exits unchanged when no eligible provider is ready', async () => {
    const fixture = createFixture();
    const original = readFileSync(fixture.configPath, 'utf8');
    const prompter = new ScriptedPrompter();

    const result = await runConfigAgentAdd({
      configPath: fixture.configPath,
      prompter,
      commandRunner: providerRunner({ loggedOut: true }),
      pathValue: fixture.bin,
    });

    expect(result).toEqual({ kind: 'not-added', reason: 'no-ready-agents' });
    expect(prompter.notes.find(({ title }) => title === 'Agents found')?.message).toContain(
      'not logged in',
    );
    expect(readFileSync(fixture.configPath, 'utf8')).toBe(original);
    expect(existsSync(`${fixture.configPath}.backup`)).toBe(false);
  });

  it('shows Pi trust limits and preserves the config when review is declined', async () => {
    const fixture = createFixture();
    enableAllExcept(fixture, 'pi');
    const original = readFileSync(fixture.configPath, 'utf8');
    const prompter = new ScriptedPrompter({
      selections: ['pi', 'recommended', 'none'],
      confirmations: [false],
    });

    const result = await runConfigAgentAdd({
      configPath: fixture.configPath,
      prompter,
      commandRunner: providerRunner({ piVersion: 'pi 0.75.0' }),
      pathValue: fixture.bin,
      environment: { PATH: fixture.bin },
    });

    expect(result).toEqual({ kind: 'not-added', reason: 'final-review-declined' });
    expect(prompter.notes.find(({ title }) => title === 'Pi access limits')?.message).toMatch(
      /host-readable/i,
    );
    expect(prompter.events.indexOf('note:Pi access limits')).toBeLessThan(
      prompter.events.indexOf('select:Pi access profile'),
    );
    expect(prompter.notes.find(({ title }) => title === 'Review')?.message).toContain(
      '0.75.0 differs from validated baseline 0.74.2',
    );
    expect(readFileSync(fixture.configPath, 'utf8')).toBe(original);
  });

  it('surfaces target drift guidance and keeps the concurrent provider edit', async () => {
    const fixture = createFixture();
    const prompter = new ScriptedPrompter({
      selections: ['codex', 'recommended', 'none'],
      confirmations: [true],
      onConfirm: () => {
        fixture.raw.providers.codex!.defaultArgs = ['--external-change'];
        writeFileSync(fixture.configPath, yaml(fixture.raw), { mode: 0o600 });
      },
    });

    await expect(
      runConfigAgentAdd({
        configPath: fixture.configPath,
        prompter,
        commandRunner: providerRunner(),
        pathValue: fixture.bin,
      }),
    ).rejects.toThrow(/changed since it was reviewed/i);

    expect(readRawConfigDocument(fixture.configPath).raw.providers.codex?.defaultArgs).toEqual([
      '--external-change',
    ]);
    expect(prompter.outros.at(-1)).toContain('Review the current configuration and retry');
    expect(prompter.closed).toBe(true);
  });

  it('surfaces lock guidance without removing the other writer lock', async () => {
    const fixture = createFixture();
    const lockPath = `${fixture.configPath}.lock`;
    const lock = {
      pid: process.pid,
      processStartIdentity: currentProcessStartIdentity(),
      nonce: 'other-writer',
    };
    const prompter = new ScriptedPrompter({
      selections: ['codex', 'recommended', 'none'],
      confirmations: [true],
      onConfirm: () => writeFileSync(lockPath, `${JSON.stringify(lock)}\n`, { mode: 0o600 }),
    });

    await expect(
      runConfigAgentAdd({
        configPath: fixture.configPath,
        prompter,
        commandRunner: providerRunner(),
        pathValue: fixture.bin,
      }),
    ).rejects.toThrow(/another spool configuration update/i);

    expect(readFileSync(lockPath, 'utf8')).toBe(`${JSON.stringify(lock)}\n`);
    expect(existsSync(`${fixture.configPath}.backup`)).toBe(false);
    expect(prompter.outros.at(-1)).toContain('no partial provider update');
    expect(prompter.closed).toBe(true);
  });

  it('runs end to end with line-oriented prompts and closes the prompt resource', async () => {
    const fixture = createFixture();
    enableAllExcept(fixture, 'codex');
    const output = new PassThrough();
    const input = Readable.from(['\n\n\n\n']);
    const prompter = new PlainSetupPrompter({ input, output });

    const result = await runConfigAgentAdd({
      configPath: fixture.configPath,
      prompter,
      commandRunner: providerRunner(),
      pathValue: fixture.bin,
    });

    expect(result).toMatchObject({ kind: 'added', provider: 'codex' });
    const rendered = String(output.read() ?? '');
    expect(rendered).toContain('Review: Change: Replace disabled Codex configuration');
    expect(rendered).toContain('Restart a running daemon');
    expect(rendered).not.toContain('\u001b[');
    expect(() => prompter.intro('again')).toThrow(/closed/i);
  });

  it('runs end to end with rich prompts and closes the prompt resource', async () => {
    const fixture = createFixture();
    enableAllExcept(fixture, 'codex');
    const bindings: ClackBindings = {
      intro: vi.fn(),
      outro: vi.fn(),
      note: vi.fn(),
      text: vi.fn().mockResolvedValue(''),
      select: vi.fn(({ message }: { message: string }) => {
        if (message === 'Which agent should spool add?') return Promise.resolve('codex');
        if (message === 'Codex access profile') return Promise.resolve('recommended');
        return Promise.resolve('none');
      }),
      multiselect: vi.fn().mockResolvedValue([]),
      confirm: vi.fn().mockResolvedValue(true),
      isCancel: () => false,
      spinner: () => ({ start: vi.fn(), message: vi.fn(), stop: vi.fn() }),
    };
    const prompter = new ClackSetupPrompter({ bindings });

    const result = await runConfigAgentAdd({
      configPath: fixture.configPath,
      prompter,
      commandRunner: providerRunner(),
      pathValue: fixture.bin,
    });

    expect(result).toMatchObject({ kind: 'added', provider: 'codex' });
    expect(bindings.note).toHaveBeenCalledWith(
      expect.stringContaining('Replace disabled Codex configuration'),
      'Review',
      expect.anything(),
    );
    expect(bindings.outro).toHaveBeenCalledWith(
      expect.stringContaining('Restart a running daemon'),
      expect.anything(),
    );
    expect(() => prompter.intro('again')).toThrow(/closed/i);
  });

  it('rejects non-interactive use before prompting or writing', async () => {
    const fixture = createFixture();
    const original = readFileSync(fixture.configPath, 'utf8');

    await expect(
      runConfigAgentAdd({ configPath: fixture.configPath, isInteractive: false }),
    ).rejects.toThrow(/requires an interactive terminal/i);

    expect(readFileSync(fixture.configPath, 'utf8')).toBe(original);
    expect(existsSync(`${fixture.configPath}.backup`)).toBe(false);
  });
});

class ScriptedPrompter implements SetupPrompter {
  readonly #selections: Array<string | Error>;
  readonly #texts: Array<string | Error>;
  readonly #confirmations: Array<boolean | Error>;
  readonly notes: Array<{ message: string; title?: string }> = [];
  readonly outros: string[] = [];
  readonly selectMessages: string[] = [];
  readonly events: string[] = [];
  readonly #onConfirm: (() => void) | undefined;
  closed = false;

  constructor(
    responses: {
      selections?: Array<string | Error>;
      texts?: Array<string | Error>;
      confirmations?: Array<boolean | Error>;
      onConfirm?: () => void;
    } = {},
  ) {
    this.#selections = [...(responses.selections ?? [])];
    this.#texts = [...(responses.texts ?? [])];
    this.#confirmations = [...(responses.confirmations ?? [])];
    this.#onConfirm = responses.onConfirm;
  }

  intro(message: string): void {
    void message;
  }

  outro(message: string): void {
    this.outros.push(message);
  }

  note(message: string, title?: string): void {
    this.notes.push({ message, ...(title === undefined ? {} : { title }) });
    this.events.push(`note:${title ?? ''}`);
  }

  text(_message: string, defaultValue?: string): Promise<string> {
    const value = this.#texts.shift() ?? defaultValue ?? '';
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  }

  select<Value extends string>(
    message: string,
    _options: readonly PromptOption<Value>[],
    initialValue?: Value,
  ): Promise<Value> {
    this.selectMessages.push(message);
    this.events.push(`select:${message}`);
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
    void message;
    return Promise.resolve([...initialValues]);
  }

  confirm(message: string, initialValue: boolean): Promise<boolean> {
    void message;
    const value = this.#confirmations.shift() ?? initialValue;
    if (!(value instanceof Error) && value) this.#onConfirm?.();
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

function providerRunner(
  options: { loggedOut?: boolean; piVersion?: string } = {},
): ReturnType<typeof vi.fn<ProviderProbeRunner>> {
  return vi.fn<ProviderProbeRunner>((executable, args) => {
    const provider = path.basename(executable);
    if (args[0] === '--version') {
      const version =
        provider === 'claude'
          ? '2.1.212 (Claude Code)'
          : provider === 'codex'
            ? 'codex-cli 0.144.5'
            : provider === 'pi'
              ? (options.piVersion ?? 'pi 0.74.2')
              : 'cursor-agent 2026.01.28-fd13201';
      return Promise.resolve({ ok: true, stdout: version, stderr: '' });
    }
    if (args[0] === 'auth') {
      return Promise.resolve({
        ok: true,
        stdout: options.loggedOut ? '{"loggedIn":false}' : '{"loggedIn":true}',
        stderr: '',
      });
    }
    if (args[0] === 'login') {
      return Promise.resolve({
        ok: true,
        stdout: options.loggedOut ? 'Not logged in' : 'Logged in using ChatGPT',
        stderr: '',
      });
    }
    if (args[0] === 'about') {
      return Promise.resolve({
        ok: true,
        stdout: options.loggedOut
          ? 'User Email Not logged in'
          : 'User Email developer@example.test',
        stderr: '',
      });
    }
    if (provider === 'pi' && args.includes('--list-models')) {
      return Promise.resolve({
        ok: true,
        stdout: '',
        stderr: options.loggedOut
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
  });
}

function createFixture(): {
  root: string;
  bin: string;
  configPath: string;
  raw: RawConfig;
} {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'spool-config-agent-')));
  roots.push(root);
  const bin = path.join(root, 'bin');
  const vault = path.join(root, 'vault');
  const state = path.join(root, 'state');
  const clone = path.join(root, 'clone');
  for (const directory of [bin, vault, state, clone]) mkdirSync(directory);
  for (const executable of ['claude', 'codex', 'cursor-agent', 'pi']) {
    writeFileSync(path.join(bin, executable), '#!/bin/sh\n', { mode: 0o755 });
  }
  const raw: RawConfig = {
    vaults: [vault],
    stateDirectory: state,
    timeZone: 'UTC',
    pollIntervalSeconds: 30,
    dayAliases: {},
    providers: {
      claude: disabledProvider('claude', '@claude'),
      codex: disabledProvider('codex', '@codex'),
      cursor: disabledProvider('cursor-agent', '@cursor'),
      pi: disabledProvider('pi', '@pi'),
    },
    repositories: [{ repository: 'example/widget', clones: [clone] }],
  };
  const configPath = path.join(root, 'config.yaml');
  createConfigDocument(configPath, raw);
  return { root, bin, configPath, raw };
}

function disabledProvider(executable: string, directive: string): RawConfig['providers'][string] {
  return { enabled: false, executable, directive, defaultArgs: [] };
}

function enableAllExcept(
  fixture: ReturnType<typeof createFixture>,
  selected: keyof typeof fixture.raw.providers,
): void {
  for (const [name, provider] of Object.entries(fixture.raw.providers)) {
    provider.enabled = name !== selected;
  }
  writeFileSync(fixture.configPath, yaml(fixture.raw), { mode: 0o600 });
}

function yaml(raw: RawConfig): string {
  return JSON.stringify(raw, null, 2);
}
