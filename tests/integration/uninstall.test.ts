import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DaemonActiveInstallError,
  installManagedRelease,
} from '../../src/distribution/managed-install.js';
import { runManagedUninstall } from '../../src/cli/commands/uninstall.js';

describe('managed uninstall command', () => {
  it('removes only installer-owned programs', async () => {
    const fixture = await fixtureInstall();
    const result = await runManagedUninstall(
      {},
      {
        entrypointPath: path.join(fixture.prefix, 'lib/spool/current/dist/cli/index.js'),
        uninstallDependencies: fixture.dependencies,
      },
    );
    expect(result.status).toBe('uninstalled');
    expect(existsSync(path.join(fixture.prefix, 'lib/spool'))).toBe(false);
    expect(existsSync(fixture.userData)).toBe(true);
  });

  it('explains unmanaged and daemon-active refusal', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'spool-uninstall-unmanaged-'));
    expect((await runManagedUninstall({ prefix: path.join(root, 'prefix') })).status).toBe(
      'unmanaged',
    );

    const fixture = await fixtureInstall();
    const result = await runManagedUninstall(
      { prefix: fixture.prefix },
      {
        uninstall: () => Promise.reject(new DaemonActiveInstallError(4242)),
      },
    );
    expect(result.status).toBe('daemon-active');
    expect(result.message).toContain('kill 4242');
  });
});

async function fixtureInstall() {
  const root = mkdtempSync(path.join(tmpdir(), 'spool-uninstall-'));
  const prefix = path.join(root, 'prefix');
  const userData = path.join(root, 'state');
  mkdirSync(userData);
  writeFileSync(path.join(userData, 'ledger'), 'preserve\n');
  const candidate = path.join(root, 'candidate');
  mkdirSync(path.join(candidate, 'bin'), { recursive: true });
  mkdirSync(path.join(candidate, 'dist/cli'), { recursive: true });
  writeFileSync(
    path.join(candidate, 'package.json'),
    JSON.stringify({ name: 'spool', version: '1.0.0' }),
  );
  writeFileSync(
    path.join(candidate, 'release-runtime.json'),
    JSON.stringify({
      platform: process.platform,
      architecture: process.arch,
      nodeMajor: 24,
      nodeAbi: 137,
    }),
  );
  writeFileSync(path.join(candidate, 'dist/cli/index.js'), '#!/usr/bin/env node\n');
  chmodSync(path.join(candidate, 'dist/cli/index.js'), 0o755);
  for (const alias of ['spool']) {
    writeFileSync(path.join(candidate, 'bin', alias), "#!/bin/sh\nprintf '%s\\n' '1.0.0'\n");
    chmodSync(path.join(candidate, 'bin', alias), 0o755);
  }
  const dependencies = {
    withDaemonLock: <T>(_config: string | undefined, operation: () => T | Promise<T>) =>
      Promise.resolve(operation()),
    smokeCandidate: () => undefined,
    verifyActivated: () => undefined,
    pathValue: '',
    runtimeIdentity: {
      platform: process.platform,
      architecture: process.arch,
      nodeMajor: 24,
      nodeAbi: 137,
    },
  };
  await installManagedRelease(
    {
      candidateDirectory: candidate,
      prefix,
      version: '1.0.0',
      channel: 'stable',
      releaseSource: 'https://example.test/releases/download/v1.0.0',
      artifactDigest: 'a'.repeat(64),
      nodeAbi: 137,
    },
    dependencies,
  );
  return { root, prefix, userData, dependencies };
}
