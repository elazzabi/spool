import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { openLedgerDatabase } from '../../src/ledger/database.js';
import { currentProcessStartIdentity, DaemonLock } from '../../src/ledger/daemon-lock.js';
import {
  DaemonActiveInstallError,
  discoverManagedPrefix,
  MANAGED_INSTALL_FILENAME,
  ManagedInstallError,
  installManagedRelease,
  readManagedInstallOwnership,
  uninstallManagedRelease,
  type ManagedInstallDependencies,
} from '../../src/distribution/managed-install.js';

describe('managed release installation', () => {
  it('installs a versioned candidate through one current pointer without touching user data', async () => {
    const fixture = installFixture('1.2.3');
    const before = userDataSnapshot(fixture.userData);
    const smokeDirectories: string[] = [];

    const result = await installManagedRelease(fixture.request, {
      withDaemonLock: (_configPath, operation) => Promise.resolve(operation()),
      smokeCandidate: (_candidate, temporaryHome) => {
        smokeDirectories.push(temporaryHome);
      },
      verifyActivated: () => undefined,
      pathValue: path.join(fixture.prefix, 'bin'),
      runtimeIdentity: releaseRuntimeIdentity(),
    });

    expect(result).toMatchObject({ status: 'installed', exitCode: 0, version: '1.2.3' });
    expect(readlinkSync(path.join(fixture.prefix, 'lib/spool/current'))).toBe('versions/1.2.3');
    expect(readlinkSync(path.join(fixture.prefix, 'bin/spool'))).toBe(
      '../lib/spool/current/bin/spool',
    );
    expect(
      JSON.parse(
        readFileSync(path.join(fixture.prefix, 'lib/spool', MANAGED_INSTALL_FILENAME), 'utf8'),
      ),
    ).toEqual({
      schemaVersion: 1,
      version: '1.2.3',
      channel: 'stable',
      releaseSource: 'https://example.test/releases/download/v1.2.3',
      artifactDigest: 'a'.repeat(64),
      nodeAbi: 137,
      activePrefix: realpathSync(fixture.prefix),
    });
    expect(smokeDirectories).toHaveLength(1);
    expect(existsSync(smokeDirectories[0]!)).toBe(false);
    expect(userDataSnapshot(fixture.userData)).toEqual(before);
  });

  it.each(['spool'])('refuses an occupied %s target with exit 2 and no changes', async (alias) => {
    const fixture = installFixture('1.2.3');
    const aliasPath = path.join(fixture.prefix, 'bin', alias);
    mkdirSync(path.dirname(aliasPath), { recursive: true });
    writeFileSync(aliasPath, 'unrelated\n');

    await expect(installManagedRelease(fixture.request, testDependencies())).rejects.toMatchObject({
      code: 'occupied-alias',
      exitCode: 2,
    });
    expect(readFileSync(aliasPath, 'utf8')).toBe('unrelated\n');
    expect(existsSync(path.join(fixture.prefix, 'lib/spool/current'))).toBe(false);
  });

  it('returns attention after installing when an earlier executable shadows the command', async () => {
    const fixture = installFixture('1.2.3');
    const shadowBin = path.join(fixture.root, 'shadow-bin');
    mkdirSync(shadowBin);
    for (const alias of ['spool']) {
      const executable = path.join(shadowBin, alias);
      writeFileSync(executable, '#!/bin/sh\nexit 0\n');
      chmodSync(executable, 0o755);
    }

    const result = await installManagedRelease(fixture.request, {
      ...testDependencies(),
      pathValue: `${shadowBin}${path.delimiter}${path.join(fixture.prefix, 'bin')}`,
    });

    expect(result.status).toBe('attention');
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain(
      `export PATH="${path.join(realpathSync(fixture.prefix), 'bin')}:$PATH"`,
    );
    expect(readlinkSync(path.join(fixture.prefix, 'lib/spool/current'))).toBe('versions/1.2.3');
  });

  it('treats an intact reinstall as a no-op', async () => {
    const fixture = installFixture('1.2.3');
    const dependencies = testDependencies();
    await installManagedRelease(fixture.request, dependencies);
    const ownershipPath = path.join(fixture.prefix, 'lib/spool', MANAGED_INSTALL_FILENAME);
    const before = readFileSync(ownershipPath);
    const smoke = vi.fn();

    const result = await installManagedRelease(fixture.request, {
      ...dependencies,
      smokeCandidate: smoke,
    });

    expect(result).toMatchObject({ status: 'current', exitCode: 0 });
    expect(readFileSync(ownershipPath)).toEqual(before);
    expect(smoke).not.toHaveBeenCalled();
  });

  it('reports a dangling active version as damaged instead of current', async () => {
    const fixture = installFixture('1.2.3');
    const dependencies = testDependencies();
    await installManagedRelease(fixture.request, dependencies);
    rmSync(path.join(fixture.prefix, 'lib/spool/versions/1.2.3'), {
      recursive: true,
      force: true,
    });

    await expect(installManagedRelease(fixture.request, dependencies)).rejects.toMatchObject({
      code: 'damaged-install',
    });
  });

  it('reports a non-executable active launcher as damaged', async () => {
    const fixture = installFixture('1.2.3');
    const dependencies = testDependencies();
    await installManagedRelease(fixture.request, dependencies);
    chmodSync(path.join(fixture.prefix, 'lib/spool/versions/1.2.3/bin/spool'), 0o644);

    await expect(installManagedRelease(fixture.request, dependencies)).rejects.toMatchObject({
      code: 'damaged-install',
    });
  });

  it('uses one canonical identity throughout a symlinked-prefix lifecycle', async () => {
    const fixture = installFixture('1.2.3');
    const canonicalPrefix = path.join(fixture.root, 'canonical-prefix');
    mkdirSync(canonicalPrefix);
    symlinkSync(canonicalPrefix, fixture.prefix);
    const request = { ...fixture.request, prefix: fixture.prefix };

    await installManagedRelease(request, testDependencies());

    expect(readManagedInstallOwnership(fixture.prefix)?.activePrefix).toBe(
      realpathSync(canonicalPrefix),
    );
    expect(discoverManagedPrefix(path.join(fixture.prefix, 'bin/spool'))).toBe(
      realpathSync(canonicalPrefix),
    );
    await expect(installManagedRelease(request, testDependencies())).resolves.toMatchObject({
      status: 'current',
    });
    await expect(
      uninstallManagedRelease({ prefix: fixture.prefix }, testDependencies()),
    ).resolves.toMatchObject({ status: 'uninstalled' });
  });

  it('canonicalizes a missing prefix beneath a symlinked ancestor', async () => {
    const fixture = installFixture('1.2.3');
    const canonicalParent = path.join(fixture.root, 'canonical-parent');
    const linkedParent = path.join(fixture.root, 'linked-parent');
    mkdirSync(canonicalParent);
    symlinkSync(canonicalParent, linkedParent);
    const suppliedPrefix = path.join(linkedParent, 'prefix');

    await installManagedRelease({ ...fixture.request, prefix: suppliedPrefix }, testDependencies());

    expect(readManagedInstallOwnership(suppliedPrefix)?.activePrefix).toBe(
      path.join(realpathSync(canonicalParent), 'prefix'),
    );
  });

  it('cleans a failed clean install before publishing the executable', async () => {
    const fixture = installFixture('1.2.3');

    await expect(
      installManagedRelease(fixture.request, {
        ...testDependencies(),
        smokeCandidate: () => {
          throw new Error('fixture smoke failure');
        },
      }),
    ).rejects.toThrow(/smoke failure/i);
    expect(existsSync(path.join(fixture.prefix, 'bin/spool'))).toBe(false);
    expect(existsSync(path.join(fixture.prefix, 'lib/spool/current'))).toBe(false);
    expect(existsSync(path.join(fixture.prefix, 'lib/spool/versions/1.2.3'))).toBe(false);
  });

  it('rejects a candidate whose CLI reports the wrong version before staging', async () => {
    const fixture = installFixture('1.2.3');
    for (const alias of ['spool']) {
      const launcher = path.join(fixture.candidate, 'bin', alias);
      writeFileSync(launcher, "#!/bin/sh\nprintf '%s\\n' '9.9.9'\n");
      chmodSync(launcher, 0o755);
    }
    const rename = vi.fn(renameSync);

    await expect(
      installManagedRelease(fixture.request, {
        withDaemonLock: (_configPath, operation) => Promise.resolve(operation()),
        pathValue: '',
        rename,
        runtimeIdentity: releaseRuntimeIdentity(),
      }),
    ).rejects.toThrow(/did not report spool 1\.2\.3/i);
    expect(rename).not.toHaveBeenCalled();
    expect(existsSync(path.join(fixture.prefix, 'lib/spool'))).toBe(false);
  });

  it('restores the previous version when post-activation verification fails', async () => {
    const first = installFixture('1.2.3');
    await installManagedRelease(first.request, testDependencies());
    const secondCandidate = createCandidate(first.root, '1.3.0');
    const secondRequest = {
      ...first.request,
      candidateDirectory: secondCandidate,
      version: '1.3.0',
      releaseSource: 'https://example.test/releases/download/v1.3.0',
      artifactDigest: 'b'.repeat(64),
    };

    await expect(
      installManagedRelease(secondRequest, {
        ...testDependencies(),
        verifyActivated: () => {
          throw new Error('fixture post-activation failure');
        },
      }),
    ).rejects.toThrow(/post-activation failure/i);

    expect(readlinkSync(path.join(first.prefix, 'lib/spool/current'))).toBe('versions/1.2.3');
    const ownership = JSON.parse(
      readFileSync(path.join(first.prefix, 'lib/spool', MANAGED_INSTALL_FILENAME), 'utf8'),
    ) as { version: string };
    expect(ownership.version).toBe('1.2.3');
    expect(existsSync(path.join(first.prefix, 'lib/spool/versions/1.3.0'))).toBe(false);
  });

  it('continues rollback cleanup after one cleanup operation fails', async () => {
    const first = installFixture('1.2.3');
    await installManagedRelease(first.request, testDependencies());
    const secondCandidate = createCandidate(first.root, '1.3.0');
    const currentPath = path.join(first.prefix, 'lib/spool/current');
    let injected = false;
    const remove: typeof rmSync = (target, options) => {
      if (!injected && String(target) === currentPath) {
        injected = true;
        throw new Error('fixture cleanup failure');
      }
      rmSync(target, options);
    };

    const installation = installManagedRelease(
      {
        ...first.request,
        candidateDirectory: secondCandidate,
        version: '1.3.0',
      },
      {
        ...testDependencies(),
        remove,
        verifyActivated: () => {
          throw new Error('fixture activation failure');
        },
      },
    );
    await expect(installation).rejects.toMatchObject({ code: 'rolled-back' });
    await expect(installation).rejects.toThrow('fixture activation failure');
    expect(readlinkSync(currentPath)).toBe('versions/1.2.3');
    expect(existsSync(path.join(first.prefix, 'lib/spool/versions/1.3.0'))).toBe(false);
  });

  it('rejects downgrades and an active daemon before activation', async () => {
    const fixture = installFixture('1.2.3');
    await installManagedRelease(fixture.request, testDependencies());
    const olderCandidate = createCandidate(fixture.root, '1.1.0');

    await expect(
      installManagedRelease(
        { ...fixture.request, candidateDirectory: olderCandidate, version: '1.1.0' },
        testDependencies(),
      ),
    ).rejects.toMatchObject({ code: 'downgrade' });

    const fresh = installFixture('2.0.0');
    await expect(
      installManagedRelease(fresh.request, {
        ...testDependencies(),
        withDaemonLock: () => {
          throw new DaemonActiveInstallError(4242);
        },
      }),
    ).rejects.toThrow(/kill 4242/i);
    expect(existsSync(path.join(fresh.prefix, 'lib/spool/current'))).toBe(false);
  });

  it('detects the effective configured daemon lock with a copyable recovery command', async () => {
    const fixture = installFixture('2.0.0');
    const state = path.join(fixture.root, 'state');
    const database = openLedgerDatabase(state);
    const lock = new DaemonLock(database);
    const owner = lock.acquire(
      {
        nonce: 'managed-install-test',
        pid: process.pid,
        processStartIdentity: currentProcessStartIdentity(),
      },
      60_000,
    );
    writeFileSync(fixture.request.configPath, `stateDirectory: ${JSON.stringify(state)}\n`);

    await expect(
      installManagedRelease(fixture.request, {
        smokeCandidate: () => undefined,
        verifyActivated: () => undefined,
        pathValue: '',
        runtimeIdentity: releaseRuntimeIdentity(),
      }),
    ).rejects.toThrow(new RegExp(`kill ${String(process.pid)}`));
    expect(existsSync(path.join(fixture.prefix, 'lib/spool/current'))).toBe(false);
    lock.release(owner);
    database.close();
  });

  it('resolves a relative state directory from a symlinked config target', async () => {
    const fixture = installFixture('2.0.0');
    const configDirectory = path.join(fixture.root, 'config-target');
    const state = path.join(configDirectory, 'state');
    mkdirSync(configDirectory);
    const database = openLedgerDatabase(state);
    const lock = new DaemonLock(database);
    const owner = lock.acquire(
      {
        nonce: 'managed-install-symlink-config-test',
        pid: process.pid,
        processStartIdentity: currentProcessStartIdentity(),
      },
      60_000,
    );
    const canonicalConfig = path.join(configDirectory, 'config.yaml');
    writeFileSync(canonicalConfig, 'stateDirectory: ./state\n');
    rmSync(fixture.request.configPath, { force: true });
    symlinkSync(canonicalConfig, fixture.request.configPath);

    await expect(
      installManagedRelease(fixture.request, {
        smokeCandidate: () => undefined,
        verifyActivated: () => undefined,
        pathValue: '',
        runtimeIdentity: releaseRuntimeIdentity(),
      }),
    ).rejects.toBeInstanceOf(DaemonActiveInstallError);
    expect(existsSync(path.join(fixture.prefix, 'lib/spool/current'))).toBe(false);
    lock.release(owner);
    database.close();
  });

  it('holds an idle configured ledger transaction without changing ledger bytes', async () => {
    const fixture = installFixture('2.0.0');
    const state = path.join(fixture.root, 'state');
    const database = openLedgerDatabase(state);
    database.close();
    const ledgerPath = path.join(state, 'spool.sqlite');
    const before = readFileSync(ledgerPath);
    writeFileSync(fixture.request.configPath, `stateDirectory: ${JSON.stringify(state)}\n`);

    await installManagedRelease(fixture.request, {
      smokeCandidate: () => undefined,
      verifyActivated: () => undefined,
      pathValue: '',
      runtimeIdentity: releaseRuntimeIdentity(),
    });

    expect(readFileSync(ledgerPath)).toEqual(before);
  });

  it('uninstalls only owned program files and the managed executable', async () => {
    const fixture = installFixture('1.2.3');
    const dependencies = testDependencies();
    await installManagedRelease(fixture.request, dependencies);
    const unrelated = path.join(fixture.prefix, 'bin/unrelated');
    writeFileSync(unrelated, 'preserve\n');
    const before = userDataSnapshot(fixture.userData);

    const result = await uninstallManagedRelease(
      { prefix: fixture.prefix, configPath: fixture.request.configPath },
      dependencies,
    );

    expect(result).toMatchObject({ status: 'uninstalled', exitCode: 0 });
    expect(existsSync(path.join(fixture.prefix, 'bin/spool'))).toBe(false);
    expect(existsSync(path.join(fixture.prefix, 'lib/spool'))).toBe(false);
    expect(readFileSync(unrelated, 'utf8')).toBe('preserve\n');
    expect(userDataSnapshot(fixture.userData)).toEqual(before);
  });

  it('rejects invalid candidate metadata without invoking the lock boundary', async () => {
    const fixture = installFixture('1.2.3');
    writeFileSync(path.join(fixture.candidate, 'package.json'), '{ malformed');
    const withDaemonLock = vi.fn();

    await expect(
      installManagedRelease(fixture.request, { ...testDependencies(), withDaemonLock }),
    ).rejects.toBeInstanceOf(ManagedInstallError);
    expect(withDaemonLock).not.toHaveBeenCalled();
  });

  it.each([
    ['platform', { platform: process.platform === 'darwin' ? 'linux' : 'darwin' }],
    ['architecture', { architecture: process.arch === 'arm64' ? 'x64' : 'arm64' }],
    ['Node major', { nodeMajor: 22 }],
  ])(
    'rejects a candidate with the wrong %s before locking or staging',
    async (_label, mutation) => {
      const fixture = installFixture('1.2.3');
      const runtimePath = path.join(fixture.candidate, 'release-runtime.json');
      const runtime = JSON.parse(readFileSync(runtimePath, 'utf8')) as Record<string, unknown>;
      writeFileSync(runtimePath, `${JSON.stringify({ ...runtime, ...mutation })}\n`);
      const withDaemonLock = vi.fn();

      await expect(
        installManagedRelease(fixture.request, {
          ...testDependencies(),
          withDaemonLock,
        }),
      ).rejects.toMatchObject({ code: 'invalid-candidate' });
      expect(withDaemonLock).not.toHaveBeenCalled();
      expect(existsSync(path.join(fixture.prefix, 'lib/spool'))).toBe(false);
    },
  );
});

function installFixture(version: string) {
  const root = mkdtempSync(path.join(tmpdir(), 'spool-managed-install-'));
  const prefix = path.join(root, 'prefix');
  const userData = path.join(root, 'user-data');
  mkdirSync(userData);
  writeFileSync(path.join(userData, 'config.yaml'), 'preserve config\n');
  writeFileSync(path.join(userData, 'spool.sqlite'), 'preserve ledger\n');
  writeFileSync(path.join(userData, 'log.jsonl'), 'preserve logs\n');
  writeFileSync(path.join(userData, 'Week.md'), '# Preserve note\n');
  const candidate = createCandidate(root, version);
  return {
    root,
    prefix,
    userData,
    candidate,
    request: {
      candidateDirectory: candidate,
      prefix,
      version,
      channel: 'stable' as const,
      releaseSource: `https://example.test/releases/download/v${version}`,
      artifactDigest: 'a'.repeat(64),
      nodeAbi: 137,
      configPath: path.join(userData, 'config.yaml'),
    },
  };
}

function createCandidate(root: string, version: string): string {
  const candidate = path.join(root, `candidate-${version}`);
  mkdirSync(path.join(candidate, 'bin'), { recursive: true });
  mkdirSync(path.join(candidate, 'dist/cli'), { recursive: true });
  writeFileSync(
    path.join(candidate, 'package.json'),
    `${JSON.stringify({ name: 'spool', version, type: 'module' })}\n`,
  );
  writeFileSync(
    path.join(candidate, 'release-runtime.json'),
    `${JSON.stringify({
      platform: process.platform,
      architecture: process.arch,
      nodeMajor: 24,
      nodeAbi: 137,
      nativeModule: 'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
    })}\n`,
  );
  writeFileSync(path.join(candidate, 'dist/cli/index.js'), '#!/usr/bin/env node\n');
  chmodSync(path.join(candidate, 'dist/cli/index.js'), 0o755);
  for (const alias of ['spool']) {
    const launcher = path.join(candidate, 'bin', alias);
    writeFileSync(launcher, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`);
    chmodSync(launcher, 0o755);
  }
  return candidate;
}

function testDependencies(): ManagedInstallDependencies {
  return {
    withDaemonLock: (_configPath, operation) => Promise.resolve(operation()),
    smokeCandidate: () => undefined,
    verifyActivated: () => undefined,
    pathValue: '',
    runtimeIdentity: releaseRuntimeIdentity(),
  };
}

function releaseRuntimeIdentity() {
  return {
    platform: process.platform,
    architecture: process.arch,
    nodeMajor: 24,
    nodeAbi: 137,
  };
}

function userDataSnapshot(directory: string): Record<string, string> {
  return Object.fromEntries(
    ['config.yaml', 'spool.sqlite', 'log.jsonl', 'Week.md'].map((filename) => [
      filename,
      readFileSync(path.join(directory, filename), 'utf8'),
    ]),
  );
}
