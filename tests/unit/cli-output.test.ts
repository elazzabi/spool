import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultConfigPath } from '../../src/config/paths.js';
import {
  ClackStaticCliPresenter,
  renderShellCommand,
  spoolArgv,
  type StaticCliBindings,
} from '../../src/cli/output.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

function outputText(stream: PassThrough): string {
  const value: unknown = stream.read();
  if (Buffer.isBuffer(value)) return value.toString();
  return typeof value === 'string' ? value : '';
}

describe('CLI handoff commands', () => {
  it('omits the redundant config flag for the platform-default configuration', () => {
    expect(spoolArgv({ configPath: defaultConfigPath() }, 'cancel', 'task-123')).toEqual([
      'spool',
      'cancel',
      'task-123',
    ]);
  });

  it('recognizes a canonical config path loaded through a symlinked default directory', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mdspool-cli-output-'));
    const canonicalConfigRoot = path.join(root, 'canonical');
    const defaultConfigRoot = path.join(root, 'default');
    const canonicalConfig = path.join(canonicalConfigRoot, 'mdspool', 'config.yaml');

    try {
      mkdirSync(path.dirname(canonicalConfig), { recursive: true });
      writeFileSync(canonicalConfig, 'test: true\n');
      symlinkSync(canonicalConfigRoot, defaultConfigRoot, 'dir');
      vi.stubEnv('XDG_CONFIG_HOME', defaultConfigRoot);

      expect(
        spoolArgv({ configPath: realpathSync(canonicalConfig) }, 'cancel', 'task-123'),
      ).toEqual(['spool', 'cancel', 'task-123']);
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves the config flag for a custom configuration', () => {
    expect(spoolArgv({ configPath: '/tmp/custom-config.yaml' }, 'cancel', 'task-123')).toEqual([
      'spool',
      '--config',
      '/tmp/custom-config.yaml',
      'cancel',
      'task-123',
    ]);
  });

  it.runIf(process.platform !== 'win32')(
    'round-trips every argument through a POSIX shell without evaluating input',
    () => {
      const argv = ['spool', '--config', "/tmp/My Notes/O'Brien $(touch never);", 'daemon'];
      const rendered = renderShellCommand(argv, 'darwin');
      const output = execFileSync('/bin/sh', ['-c', `set -- ${rendered}; printf '%s\\n' "$@"`], {
        encoding: 'utf8',
      });

      expect(output.trimEnd().split('\n')).toEqual(argv);
    },
  );

  it('renders Windows handoff arguments as PowerShell-safe literals', () => {
    expect(
      renderShellCommand(['spool', '--config', "C:\\My Notes\\O'Brien", 'daemon'], 'win32'),
    ).toBe("spool --config 'C:\\My Notes\\O''Brien' daemon");
  });
});

describe('ClackStaticCliPresenter', () => {
  it('routes ordered report content through semantic bindings', () => {
    const calls: string[] = [];
    const intro = vi.fn((message: string) => calls.push(`intro:${message}`));
    const outro = vi.fn((message: string) => calls.push(`outro:${message}`));
    const section = vi.fn((title: string, lines: readonly string[]) =>
      calls.push(`section:${title}:${lines.join('|')}`),
    );
    const bindings: StaticCliBindings = {
      intro,
      outro,
      section,
      info: vi.fn((message: string) => calls.push(`info:${message}`)),
      success: vi.fn((message: string) => calls.push(`success:${message}`)),
      warn: vi.fn((message: string) => calls.push(`warn:${message}`)),
      error: vi.fn((message: string) => calls.push(`error:${message}`)),
    };
    const output = new PassThrough();
    const presenter = new ClackStaticCliPresenter({ output, bindings });

    presenter.intro('MDSpool configuration');
    presenter.section('General', ['Config: /tmp/config.yaml', 'State: /tmp/state']);
    presenter.info('Codex: disabled');
    presenter.success('Claude: available');
    presenter.warn('Cursor: warning');
    presenter.error('Pi: unavailable');
    presenter.outro('Configuration inspection complete');

    expect(calls).toEqual([
      'intro:MDSpool configuration',
      'section:General:Config: /tmp/config.yaml|State: /tmp/state',
      'info:Codex: disabled',
      'success:Claude: available',
      'warn:Cursor: warning',
      'error:Pi: unavailable',
      'outro:Configuration inspection complete',
    ]);
    expect(intro).toHaveBeenCalledWith('MDSpool configuration', output);
    expect(section).toHaveBeenCalledWith(
      'General',
      ['Config: /tmp/config.yaml', 'State: /tmp/state'],
      output,
    );
    expect(outro).toHaveBeenCalledWith('Configuration inspection complete', output);
  });

  it('keeps status and section meaning when color is disabled', () => {
    vi.stubEnv('FORCE_COLOR', '0');
    const output = new PassThrough();
    const presenter = new ClackStaticCliPresenter({ output });

    presenter.intro('MDSpool doctor');
    presenter.section('Paths', ['Config: /tmp/config.yaml', 'State: /tmp/state']);
    presenter.success('Claude: available');
    presenter.info('Codex: disabled');
    presenter.warn('Cursor: warning');
    presenter.error('Pi: unavailable');

    const rendered = outputText(output);
    expect(rendered).not.toContain('\u001b[');
    expect(rendered).toContain('MDSpool doctor');
    expect(rendered).toContain('Paths');
    expect(rendered).toContain('Config: /tmp/config.yaml');
    expect(rendered).toContain('State: /tmp/state');
    expect(rendered).toContain('Claude: available');
    expect(rendered).toContain('Codex: disabled');
    expect(rendered).toContain('Cursor: warning');
    expect(rendered).toContain('Pi: unavailable');
  });

  it('preserves report meaning through an ASCII-only binding fallback', () => {
    const output = new PassThrough();
    const presenter = new ClackStaticCliPresenter({ output, unicode: false });

    presenter.intro('MDSpool doctor');
    presenter.section('Paths', ['Config: /tmp/config.yaml', 'State: /tmp/state']);
    presenter.success('Claude: available');
    presenter.info('Codex: disabled');
    presenter.warn('Cursor: warning');
    presenter.error('Pi: unavailable');
    presenter.outro('Doctor inspection complete');

    const rendered = outputText(output);
    expect([...rendered].every((character) => character.charCodeAt(0) <= 0x7f)).toBe(true);
    expect(rendered).toBe(
      [
        'MDSpool doctor',
        'Paths',
        'Config: /tmp/config.yaml',
        'State: /tmp/state',
        '[ok] Claude: available',
        '[i] Codex: disabled',
        '[!] Cursor: warning',
        '[x] Pi: unavailable',
        'Doctor inspection complete',
        '',
      ].join('\n'),
    );
  });
});
