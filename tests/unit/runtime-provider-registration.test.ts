import { closeSync, mkdtempSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { MDSpoolConfig } from '../../src/config/schema.js';
import { PiProvider } from '../../src/providers/pi.js';
import { piSessionDirectory } from '../../src/providers/pi-session.js';
import { createInstalledProviderRegistry } from '../../src/scheduler/service.js';

function executable(root: string, provider: 'claude' | 'pi'): string {
  const target = path.join(root, provider);
  const help =
    provider === 'pi'
      ? '--mode json --session <id> --session-dir <path> --tools <tools> --offline --no-extensions --no-context-files --no-skills --no-prompt-templates --list-models'
      : '--print --output-format stream-json --resume';
  const version = provider === 'pi' ? 'pi 0.74.2' : '2.1.212 (Claude Code)';
  writeFileSync(
    target,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then printf '%s\\n' '${version}'; else printf '%s\\n' '${help}'; fi\n`,
    { mode: 0o755 },
  );
  return target;
}

function configFixture(): MDSpoolConfig {
  const root = mkdtempSync(path.join(tmpdir(), 'mdspool-runtime-providers-'));
  const stateDirectory = path.join(root, 'state');
  const workspace = path.join(root, 'workspace');
  mkdirSync(stateDirectory, { mode: 0o700 });
  mkdirSync(workspace);
  return {
    configPath: path.join(root, 'config.yaml'),
    vaults: [],
    stateDirectory,
    timeZone: 'UTC',
    pollIntervalSeconds: 15,
    dayAliases: {},
    providers: [
      {
        name: 'claude',
        enabled: true,
        executable: executable(root, 'claude'),
        executableResolved: true,
        directive: '@claude',
        defaultArgs: ['--permission-mode', 'plan'],
      },
      {
        name: 'pi',
        enabled: true,
        executable: executable(root, 'pi'),
        executableResolved: true,
        directive: '@pi',
        defaultArgs: [],
      },
    ],
    repositories: [{ repository: 'owner/repo', clones: [workspace] }],
  };
}

describe('runtime provider registration', () => {
  it('registers Pi with managed sessions while preserving existing providers', async () => {
    const config = configFixture();

    const { registry, warnings } = await createInstalledProviderRegistry(config);
    const pi = registry.require('pi');

    expect(pi).toBeInstanceOf(PiProvider);
    expect(registry.require('claude').name).toBe('claude');
    expect(pi.capabilities).toMatchObject({
      launch: true,
      inspect: true,
      resume: true,
      observe: false,
      cancel: false,
      needsInput: false,
    });
    expect(warnings).toEqual([
      'Claude foreground print events lack distinct replayable needs-input episodes; Needs input is disabled',
    ]);

    const cwd = config.repositories[0]!.clones[0]!;
    const logPath = path.join(config.stateDirectory, 'logs', 'attempt.log');
    mkdirSync(path.dirname(logPath), { mode: 0o700 });
    closeSync(openSync(logPath, 'wx', 0o600));
    expect(pi.createLaunch({ cwd, logPath, prompt: 'review' }).args).toContain(
      piSessionDirectory(config.stateDirectory),
    );
  });

  it('fails closed before registration when managed sessions overlap a workspace', async () => {
    const config = configFixture();
    config.repositories = [{ repository: 'owner/repo', clones: [config.stateDirectory] }];

    await expect(createInstalledProviderRegistry(config)).rejects.toThrow(/workspace/i);
  });
});
