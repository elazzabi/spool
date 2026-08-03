import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  collectDoctorReport,
  formatDoctorReport,
  presentDoctorReport,
  type DoctorCommandRunner,
  type DoctorReport,
} from '../../src/cli/commands/doctor.js';
import type { StaticCliPresenter } from '../../src/cli/output.js';
import { loadConfig } from '../../src/config/load.js';

function configWithProviders(defaultArgs: string[] = []): ReturnType<typeof loadConfig> {
  const root = mkdtempSync(path.join(tmpdir(), 'mdspool-doctor-'));
  const vault = path.join(root, 'vault');
  const state = path.join(root, 'state');
  const clone = path.join(root, 'clone');
  const bin = path.join(root, 'bin');
  for (const directory of [vault, state, clone, bin]) mkdirSync(directory);
  for (const executable of ['claude', 'codex']) {
    writeFileSync(path.join(bin, executable), '#!/bin/sh\n', { mode: 0o755 });
  }
  const configPath = path.join(root, 'config.yaml');
  writeFileSync(
    configPath,
    `
vaults: [${JSON.stringify(vault)}]
stateDirectory: ${JSON.stringify(state)}
timeZone: UTC
pollIntervalSeconds: 15
providers:
  claude:
    executable: claude
    defaultArgs: ${JSON.stringify(defaultArgs)}
  codex:
    executable: codex
    defaultArgs: []
  cursor:
    executable: missing-cursor-agent
    defaultArgs: []
repositories:
  - repository: owner/repo
    clones: [${JSON.stringify(clone)}]
`,
  );
  return loadConfig(configPath, { pathValue: bin });
}

describe('doctor', () => {
  it('presents overall and provider diagnostics through semantic statuses', () => {
    const calls: string[] = [];
    const presenter: StaticCliPresenter = {
      intro: vi.fn((message) => calls.push(`intro:${message}`)),
      outro: vi.fn((message) => calls.push(`outro:${message}`)),
      section: vi.fn((title: string, lines: readonly string[]) =>
        calls.push(`section:${title}:${lines.join('|')}`),
      ),
      info: vi.fn((message) => calls.push(`info:${message}`)),
      success: vi.fn((message) => calls.push(`success:${message}`)),
      warn: vi.fn((message) => calls.push(`warn:${message}`)),
      error: vi.fn((message) => calls.push(`error:${message}`)),
    };
    const report: DoctorReport = {
      ok: false,
      configPath: '/tmp/config.yaml',
      stateDirectory: '/tmp/state',
      providers: [
        {
          name: 'claude',
          enabled: true,
          available: true,
          executable: 'claude',
          version: '2.1.215',
          effectiveArgv: ['claude', '--print'],
          capabilities: ['launch', 'resume'],
          capabilityProbe: {
            ok: true,
            argv: ['claude', '--help'],
            detail: 'machine contract available',
          },
          warnings: ['version differs from baseline'],
          error: null,
        },
        {
          name: 'codex',
          enabled: false,
          available: false,
          executable: 'codex',
          version: null,
          effectiveArgv: ['codex'],
          capabilities: [],
          capabilityProbe: null,
          warnings: [],
          error: 'disabled by configuration',
        },
        {
          name: 'cursor\u001b[31m',
          enabled: true,
          available: false,
          executable: 'cursor',
          version: '1.0',
          effectiveArgv: ['cursor'],
          capabilities: [],
          capabilityProbe: {
            ok: false,
            argv: ['cursor', '--help'],
            detail: 'probe failed\nspoofed',
          },
          warnings: [],
          error: 'not ready\u001b[2J',
        },
      ],
    };

    presentDoctorReport(report, presenter);

    expect(calls).toEqual([
      'intro:MDSpool doctor',
      'section:Paths:Config: /tmp/config.yaml|State: /tmp/state',
      'error:Overall: attention needed',
      'success:claude: available',
      'section:claude details:Version: 2.1.215|Argv: "claude" "--print"|Capabilities: launch, resume|Probe: ok (machine contract available): "claude" "--help"',
      'warn:claude warning: version differs from baseline',
      'info:codex: disabled',
      'section:codex details:Version: unknown|Argv: "codex"|Capabilities: none confirmed',
      'info:codex error: disabled by configuration',
      'error:cursor[31m: unavailable',
      'section:cursor[31m details:Version: 1.0|Argv: "cursor"|Capabilities: none confirmed|Probe: failed (probe failedspoofed): "cursor" "--help"',
      'error:cursor[31m error: not ready[2J',
      'outro:Doctor inspection complete',
    ]);
    expect(calls.join('\n')).not.toContain('\u001b');
    expect(calls.join('\n')).not.toContain('\nspoofed');
    expect(formatDoctorReport(report)).toBe(
      [
        'Config: /tmp/config.yaml',
        'State: /tmp/state',
        'Overall: attention needed',
        '',
        'claude: available',
        '  version: 2.1.215',
        '  argv: "claude" "--print"',
        '  capabilities: launch, resume',
        '  probe: ok (machine contract available): "claude" "--help"',
        '  warning: version differs from baseline',
        'codex: disabled',
        '  version: unknown',
        '  argv: "codex"',
        '  capabilities: none confirmed',
        '  error: disabled by configuration',
        'cursor[31m: unavailable',
        '  version: 1.0',
        '  argv: "cursor"',
        '  capabilities: none confirmed',
        '  probe: failed (probe failedspoofed): "cursor" "--help"',
        '  error: not ready[2J',
      ].join('\n'),
    );

    calls.length = 0;
    presentDoctorReport({ ...report, ok: true, providers: [report.providers[0]!] }, presenter);
    expect(calls).toContain('success:Overall: ready');
    expect(calls).not.toContain('error:Overall: attention needed');
  });

  it('probes providers independently and does not invoke a shell', async () => {
    const config = configWithProviders(['--api-key', 'super-secret', '--label=a;b']);
    const runner = vi.fn<DoctorCommandRunner>((executable, args, options) => {
      expect(options.shell).toBe(false);
      expect(args).not.toContain('super-secret');
      if (args.includes('--version')) {
        const name = path.basename(executable);
        return Promise.resolve({
          ok: true,
          stdout: name === 'claude' ? '2.1.215 (Claude Code)' : 'codex-cli 0.144.5',
          stderr: '',
        });
      }
      if (path.basename(executable) === 'claude') {
        return Promise.resolve({
          ok: true,
          stdout: '--print --output-format stream-json --resume',
          stderr: '',
        });
      }
      return Promise.resolve({ ok: true, stdout: 'resume --json', stderr: '' });
    });

    const report = await collectDoctorReport(config, { commandRunner: runner });

    expect(report.providers.map(({ name, available }) => [name, available])).toEqual([
      ['claude', true],
      ['codex', true],
      ['cursor', false],
    ]);
    expect(report.providers[0]?.effectiveArgv).toEqual([
      config.providers[0]?.executable,
      '--api-key',
      '[REDACTED]',
      '--label=a;b',
    ]);
    expect(formatDoctorReport(report)).not.toContain('super-secret');
    expect(report.providers[0]?.capabilities).not.toContain('needs-input');
    expect(report.providers[0]?.capabilities).not.toContain('status-observation');
    expect(report.providers[0]?.capabilities).not.toContain('cancel');
    expect(report.providers[0]?.warnings).toContain(
      'claude 2.1.215 differs from validated baseline 2.1.212; continuing with the detected machine contract',
    );
    expect(runner.mock.calls.some(([, args]) => args.includes('--label=a;b'))).toBe(false);
  });

  it('reports providers without a runtime adapter as unavailable', async () => {
    const config = configWithProviders();
    config.providers.push({
      name: 'future-agent',
      enabled: true,
      executable: process.execPath,
      executableResolved: true,
      directive: '@future-agent',
      defaultArgs: [],
    });
    const runner = vi.fn<DoctorCommandRunner>();

    const report = await collectDoctorReport(config, { commandRunner: runner });
    const custom = report.providers.at(-1);

    expect(custom).toMatchObject({ available: false, capabilityProbe: null });
    expect(custom?.error).toMatch(/no runtime adapter/i);
    expect(runner).not.toHaveBeenCalledWith(process.execPath, expect.anything(), expect.anything());
  });

  it('redacts inline and paired secret flags while preserving harmless argv boundaries', async () => {
    const config = configWithProviders([
      '--token=abc123',
      '--header',
      'Authorization: Bearer private',
      '--prompt',
      'literal $(touch /tmp/nope)',
    ]);
    const report = await collectDoctorReport(config, {
      commandRunner: () => Promise.resolve({ ok: true, stdout: 'v1', stderr: '' }),
    });
    const rendered = JSON.stringify(report);

    expect(rendered).not.toContain('abc123');
    expect(rendered).not.toContain('Bearer private');
    expect(report.providers[0]?.effectiveArgv).toContain('literal $(touch /tmp/nope)');
  });

  it('sanitizes configuration paths and provider details before terminal rendering', async () => {
    const config = configWithProviders();
    const report = await collectDoctorReport(config, {
      commandRunner: () => Promise.resolve({ ok: true, stdout: 'v1', stderr: '' }),
    });
    report.configPath = `${report.configPath}\u001b[31m\ninjected-path`;
    report.stateDirectory = `${report.stateDirectory}\ninjected-state`;
    const first = report.providers[0];
    if (first) first.warnings.push('\u001b[2J\ninjected-warning');

    const rendered = formatDoctorReport(report);

    expect(rendered).not.toContain('\u001b');
    expect(rendered).not.toContain('\ninjected-path');
    expect(rendered).not.toContain('\ninjected-state');
    expect(rendered).not.toContain('\ninjected-warning');
  });

  it('reports Pi launch argv, probe argv, drift, and its limited capabilities', async () => {
    const config = configWithProviders();
    config.providers = [
      {
        name: 'pi',
        enabled: true,
        executable: process.execPath,
        executableResolved: true,
        directive: '@pi',
        defaultArgs: ['--model', 'configured/model', '--api-key', 'do-not-render'],
      },
    ];
    const runner = vi.fn<DoctorCommandRunner>((_executable, args, options) => {
      expect(options.shell).toBe(false);
      expect(options.environment).not.toHaveProperty('OPENAI_API_KEY');
      if (args.includes('--version')) {
        return Promise.resolve({ ok: true, stdout: 'pi 0.75.0', stderr: '' });
      }
      if (args.includes('--list-models')) {
        return Promise.resolve({
          ok: true,
          stdout: '',
          stderr:
            'provider model context max-out thinking images\nanthropic claude-sonnet-4 200K 64K yes yes\n',
        });
      }
      expect(args).toEqual(['--offline', '--no-extensions', '--help']);
      return Promise.resolve({
        ok: true,
        stdout:
          '--mode json --session <id> --session-dir <path> --tools <tools> --offline --no-extensions --no-context-files --no-skills --no-prompt-templates --list-models',
        stderr: '',
      });
    });

    const report = await collectDoctorReport(config, { commandRunner: runner });
    const pi = report.providers[0]!;
    const rendered = formatDoctorReport(report);

    expect(pi.available).toBe(true);
    expect(pi.version).toBe('0.75.0');
    expect(pi.effectiveArgv).toEqual(
      expect.arrayContaining([
        '--offline',
        '--tools',
        'read,grep,find,ls',
        '--session-dir',
        path.join(config.stateDirectory, 'pi', 'sessions'),
        '--mode',
        'json',
      ]),
    );
    expect(pi.effectiveArgv).not.toContain('do-not-render');
    expect(pi.capabilities).toEqual(['launch', 'inspect', 'resume']);
    expect(pi.capabilityProbe?.argv).toEqual([
      process.execPath,
      '--offline',
      '--no-extensions',
      '--help',
    ]);
    expect(pi.warnings).toContain(
      'pi 0.75.0 differs from validated baseline 0.74.2; continuing with the detected machine contract',
    );
    expect(rendered).toContain('"--offline" "--no-extensions" "--help"');
    expect(rendered).not.toContain('do-not-render');
  });

  it('keeps Pi unavailable without stored model auth and gives sanitized remediation', async () => {
    const config = configWithProviders();
    config.providers = [
      {
        name: 'pi',
        enabled: true,
        executable: process.execPath,
        executableResolved: true,
        directive: '@pi',
        defaultArgs: [],
      },
    ];
    const runner = vi.fn<DoctorCommandRunner>((_executable, args, options) => {
      expect(options.environment).not.toHaveProperty('OPENAI_API_KEY');
      if (args.includes('--version')) {
        return Promise.resolve({ ok: true, stdout: 'pi 0.74.2', stderr: '' });
      }
      if (args.includes('--list-models')) {
        return Promise.resolve({
          ok: true,
          stdout: '',
          stderr: 'provider model context max-out thinking images\n',
        });
      }
      return Promise.resolve({
        ok: true,
        stdout:
          '--mode json --session --session-dir --tools --offline --no-extensions --no-context-files --no-skills --no-prompt-templates --list-models',
        stderr: '',
      });
    });

    const report = await collectDoctorReport(config, {
      commandRunner: runner,
      environment: { PATH: process.env.PATH ?? '', OPENAI_API_KEY: 'ambient-only-secret' },
    });
    const rendered = formatDoctorReport(report);

    expect(report.providers[0]).toMatchObject({ available: false });
    expect(report.providers[0]?.error).toMatch(/stored Pi auth/i);
    expect(rendered).not.toMatch(/OPENAI|ambient-only-secret/);
  });

  it('reports an existing unsafe Pi session directory as unavailable', async () => {
    const config = configWithProviders();
    config.providers = [
      {
        name: 'pi',
        enabled: true,
        executable: process.execPath,
        executableResolved: true,
        directive: '@pi',
        defaultArgs: [],
      },
    ];
    const sessions = path.join(config.stateDirectory, 'pi', 'sessions');
    mkdirSync(sessions, { recursive: true, mode: 0o755 });
    const runner = vi.fn<DoctorCommandRunner>((_executable, args) =>
      Promise.resolve(
        args.includes('--version')
          ? { ok: true, stdout: 'pi 0.74.2', stderr: '' }
          : {
              ok: true,
              stdout:
                '--mode json --session --session-dir --tools --offline --no-extensions --no-context-files --no-skills --no-prompt-templates --list-models',
              stderr: '',
            },
      ),
    );

    const report = await collectDoctorReport(config, { commandRunner: runner });

    expect(report.providers[0]?.available).toBe(false);
    expect(report.providers[0]?.error).toMatch(/owner-private/i);
  });
});
