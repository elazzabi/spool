import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createProgram } from '../../src/cli/index.js';
import {
  DaemonActiveInstallError,
  installManagedRelease,
  type ManagedInstallDependencies,
} from '../../src/distribution/managed-install.js';
import {
  presentUpdateResult,
  runManagedUpdate,
  type UpdateDependencies,
} from '../../src/cli/commands/update.js';
import { acquireRelease, ReleaseUnavailableError } from '../../src/distribution/release-client.js';

interface ReleaseBuildModule {
  DECLARED_RELEASE_TUPLES: ReadonlyArray<{ platform: string; architecture: string }>;
  createReleaseArchive(input: Record<string, unknown>): unknown;
  createReleaseManifest(input: Record<string, unknown>): string;
}
const releaseBuild = (await import(
  // @ts-expect-error Release tooling is intentionally plain JavaScript.
  '../../scripts/build-release.mjs'
)) as ReleaseBuildModule;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.exitCode = undefined;
});

describe('managed update command', () => {
  it('updates a previous managed release through acquisition and activation', async () => {
    const fixture = await managedFixture('1.0.0');
    const candidate = createCandidate(fixture.root, '1.1.0');
    const before = fixture.userData();
    const linkedPrefix = path.join(fixture.root, 'linked-prefix');
    symlinkSync(fixture.prefix, linkedPrefix);

    const result = await runManagedUpdate(
      {},
      {
        ...updateDependencies(candidate, '1.1.0'),
        entrypointPath: path.join(linkedPrefix, 'bin/spool'),
      },
    );

    expect(result).toMatchObject({ status: 'updated', exitCode: 0, version: '1.1.0' });
    expect(readlinkSync(path.join(fixture.prefix, 'lib/spool/current'))).toBe('versions/1.1.0');
    expect(fixture.userData()).toEqual(before);
  });

  it('runs the verified manifest-download-extract-activate chain', async () => {
    const fixture = await managedFixture('1.0.0');
    const assets = createReleaseAssets(fixture.root, '1.1.0');
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request) => {
        const inputUrl = input instanceof Request ? input.url : input.toString();
        const filename = new URL(inputUrl).pathname.split('/').pop()!;
        try {
          return Promise.resolve(
            new Response(readFileSync(path.join(assets, filename)), { status: 200 }),
          );
        } catch {
          return Promise.resolve(new Response('missing', { status: 404 }));
        }
      }),
    );
    const result = await runManagedUpdate(
      { prefix: fixture.prefix },
      {
        releaseBaseUrl: 'https://example.test/releases',
        acquire: (request) =>
          acquireRelease({
            ...request,
            runtimeIdentity: {
              platform: process.platform,
              architecture: process.arch,
              nodeMajor: 24,
              nodeAbi: 137,
            },
          }),
        installDependencies: engineDependencies(),
      },
    );
    expect(result).toMatchObject({ status: 'updated', version: '1.1.0' });
    expect(readlinkSync(path.join(fixture.prefix, 'lib/spool/current'))).toBe('versions/1.1.0');
  });

  it('reports the installed exact version as current without acquisition', async () => {
    const fixture = await managedFixture('1.0.0');
    const acquire = vi.fn();
    const result = await runManagedUpdate(
      { prefix: fixture.prefix, version: '1.0.0' },
      { acquire },
    );

    expect(result).toMatchObject({ status: 'current', exitCode: 0 });
    expect(acquire).not.toHaveBeenCalled();
  });

  it.each(['1.2', '1.2.0.1', 'not-a-version'])(
    'rejects malformed exact version %s without acquisition',
    async (version) => {
      const fixture = await managedFixture('1.2.0');
      const acquire = vi.fn();
      const result = await runManagedUpdate({ prefix: fixture.prefix, version }, { acquire });
      const writes: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      });

      presentUpdateResult(result, true);

      expect(JSON.parse(writes.join(''))).toEqual(result);
      expect(result).toMatchObject({ status: 'unavailable', exitCode: 1, version: '1.2.0' });
      expect(result.message).toContain(`Expected an exact stable version: ${version}`);
      expect(result.message).toContain('spool 1.2.0 remains active');
      expect(acquire).not.toHaveBeenCalled();
      expect(readlinkSync(path.join(fixture.prefix, 'lib/spool/current'))).toBe('versions/1.2.0');
    },
  );

  it('rejects downgrade and unavailable selections while preserving the active version', async () => {
    const fixture = await managedFixture('1.0.0');
    const downgrade = await runManagedUpdate(
      { prefix: fixture.prefix, version: '0.9.0' },
      { acquire: vi.fn() },
    );
    expect(downgrade.status).toBe('downgrade-refused');

    const unavailable = await runManagedUpdate(
      { prefix: fixture.prefix, version: '9.9.9' },
      {
        acquire: () => Promise.reject(new Error('release unavailable')),
      },
    );
    expect(unavailable.status).toBe('unavailable');
    expect(readlinkSync(path.join(fixture.prefix, 'lib/spool/current'))).toBe('versions/1.0.0');
  });

  it('explains unmanaged and daemon-active refusal', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'spool-update-unmanaged-'));
    expect((await runManagedUpdate({ prefix: path.join(root, 'prefix') })).status).toBe(
      'unmanaged',
    );

    const fixture = await managedFixture('1.0.0');
    const candidate = createCandidate(fixture.root, '1.1.0');
    const result = await runManagedUpdate(
      { prefix: fixture.prefix },
      {
        ...updateDependencies(candidate, '1.1.0'),
        install: () => Promise.reject(new DaemonActiveInstallError(4242)),
      },
    );
    expect(result).toMatchObject({ status: 'daemon-active', exitCode: 1 });
    expect(result.message).toContain('kill 4242');
  });

  it('distinguishes failed-preserved from rolled-back updates', async () => {
    const fixture = await managedFixture('1.0.0');
    const candidate = createCandidate(fixture.root, '1.1.0');
    const failed = await runManagedUpdate(
      { prefix: fixture.prefix },
      {
        ...updateDependencies(candidate, '1.1.0'),
        installDependencies: {
          ...engineDependencies(),
          smokeCandidate: () => {
            throw new Error('candidate smoke failed');
          },
        },
      },
    );
    expect(failed.status).toBe('failed-preserved');

    const rolledBack = await runManagedUpdate(
      { prefix: fixture.prefix },
      {
        ...updateDependencies(candidate, '1.1.0'),
        installDependencies: {
          ...engineDependencies(),
          verifyActivated: () => {
            throw new Error('post activation failed');
          },
        },
      },
    );
    expect(rolledBack.status).toBe('rolled-back');
    expect(readlinkSync(path.join(fixture.prefix, 'lib/spool/current'))).toBe('versions/1.0.0');
  });

  it('reports an inconsistent install when restoring the current pointer fails', async () => {
    const fixture = await managedFixture('1.0.0');
    const candidate = createCandidate(fixture.root, '1.1.0');
    const rename: typeof renameSync = (source, destination) => {
      if (String(source).includes('.restore-')) {
        throw new Error('fixture restore failure');
      }
      renameSync(source, destination);
    };

    const result = await runManagedUpdate(
      { prefix: fixture.prefix },
      {
        ...updateDependencies(candidate, '1.1.0'),
        installDependencies: {
          ...engineDependencies(),
          rename,
          verifyActivated: () => {
            throw new Error('fixture activation failure');
          },
        },
      },
    );

    expect(result).toMatchObject({ status: 'rollback-failed', exitCode: 1 });
    expect(result.version).toBeUndefined();
    expect(result.message).toContain('fixture activation failure');
    expect(result.message).toContain('fixture restore failure');
    expect(result.message).not.toContain('remains active');
    expect(result.message).not.toContain('was restored');
  });

  it('reports PATH shadowing as attention after a valid update', async () => {
    const fixture = await managedFixture('1.0.0');
    const candidate = createCandidate(fixture.root, '1.1.0');
    const shadow = path.join(fixture.root, 'shadow-bin');
    mkdirSync(shadow);
    for (const alias of ['spool']) {
      const executable = path.join(shadow, alias);
      writeFileSync(executable, '#!/bin/sh\nexit 0\n');
      chmodSync(executable, 0o755);
    }
    const result = await runManagedUpdate(
      { prefix: fixture.prefix },
      {
        ...updateDependencies(candidate, '1.1.0'),
        installDependencies: engineDependencies(
          `${shadow}${path.delimiter}${path.join(fixture.prefix, 'bin')}`,
        ),
      },
    );
    expect(result).toMatchObject({ status: 'attention', exitCode: 1, version: '1.1.0' });
    expect(result.message).toContain('export PATH=');
  });

  it('emits clean JSON for an unmanaged source installation', async () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    await createProgram().parseAsync(['node', 'spool', 'update', '--json']);

    expect(JSON.parse(writes.join(''))).toMatchObject({ status: 'unmanaged', exitCode: 1 });
  });
});

describe('managed release response bounds', () => {
  it.each(['manifest', 'artifact'] as const)(
    'times out a stalled %s response',
    async (stalledResponse) => {
      vi.useFakeTimers();
      vi.stubGlobal(
        'fetch',
        vi.fn((input: string | URL | Request, init?: RequestInit) => {
          const inputUrl = input instanceof Request ? input.url : String(input);
          const isManifest = inputUrl.endsWith('/release-manifest.json');
          if ((stalledResponse === 'manifest') === isManifest) {
            return new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener(
                'abort',
                () => reject(new DOMException('Request aborted', 'AbortError')),
                { once: true },
              );
            });
          }
          return Promise.resolve(new Response(JSON.stringify(releaseManifest(4))));
        }),
      );

      const rejection = expect(acquireRelease(releaseAcquisitionRequest())).rejects.toThrow(
        ReleaseUnavailableError,
      );
      await vi.runAllTimersAsync();
      await rejection;
    },
  );

  it('rejects an oversized Content-Length before reading the artifact body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request) => {
        const inputUrl = input instanceof Request ? input.url : String(input);
        if (inputUrl.endsWith('/release-manifest.json')) {
          return Promise.resolve(new Response(JSON.stringify(releaseManifest(4))));
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-length': '5' }),
          get body() {
            throw new Error('artifact body should not be read');
          },
        } as unknown as Response);
      }),
    );

    await expect(acquireRelease(releaseAcquisitionRequest())).rejects.toThrow(
      ReleaseUnavailableError,
    );
  });

  it('stops buffering when an artifact without Content-Length exceeds its declared size', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request) => {
        const inputUrl = input instanceof Request ? input.url : String(input);
        if (inputUrl.endsWith('/release-manifest.json')) {
          return Promise.resolve(new Response(JSON.stringify(releaseManifest(4))));
        }
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(5));
                controller.close();
              },
            }),
          ),
        );
      }),
    );

    await expect(acquireRelease(releaseAcquisitionRequest())).rejects.toThrow(
      ReleaseUnavailableError,
    );
  });
});

async function managedFixture(version: string) {
  const root = mkdtempSync(path.join(tmpdir(), 'spool-update-'));
  const prefix = path.join(root, 'prefix');
  const data = path.join(root, 'user-data');
  mkdirSync(data);
  writeFileSync(path.join(data, 'state'), 'preserve\n');
  const candidate = createCandidate(root, version);
  await installManagedRelease(
    request(candidate, prefix, version),
    engineDependencies(path.join(prefix, 'bin')),
  );
  return {
    root,
    prefix,
    userData: () => readFile(path.join(data, 'state')),
  };
}

function updateDependencies(candidate: string, version: string): UpdateDependencies {
  return {
    acquire: () =>
      Promise.resolve({
        candidateDirectory: candidate,
        version,
        releaseSource: `https://example.test/releases/download/v${version}`,
        artifactDigest: 'b'.repeat(64),
        nodeAbi: 137,
        cleanup: () => undefined,
      }),
    installDependencies: engineDependencies(),
  };
}

function engineDependencies(pathValue = ''): ManagedInstallDependencies {
  return {
    withDaemonLock: (_config, operation) => Promise.resolve(operation()),
    smokeCandidate: () => undefined,
    verifyActivated: () => undefined,
    pathValue,
    runtimeIdentity: {
      platform: process.platform,
      architecture: process.arch,
      nodeMajor: 24,
      nodeAbi: 137,
    },
  };
}

function request(candidateDirectory: string, prefix: string, version: string) {
  return {
    candidateDirectory,
    prefix,
    version,
    channel: 'stable' as const,
    releaseSource: `https://example.test/releases/download/v${version}`,
    artifactDigest: 'a'.repeat(64),
    nodeAbi: 137,
  };
}

function releaseAcquisitionRequest() {
  return {
    releaseBaseUrl: 'https://example.test/releases',
    runtimeIdentity: {
      platform: 'linux' as const,
      architecture: 'x64',
      nodeMajor: 24,
      nodeAbi: 137,
    },
  };
}

function releaseManifest(artifactSize: number) {
  const version = '1.1.0';
  return {
    schemaVersion: 1,
    version,
    sourceRevision: '0123456789abcdef0123456789abcdef01234567',
    artifacts: releaseBuild.DECLARED_RELEASE_TUPLES.map(({ platform, architecture }) => ({
      platform,
      architecture,
      nodeMajor: 24,
      nodeAbi: 137,
      filename: `spool-v${version}-node24-abi137-${platform}-${architecture}.tar.gz`,
      sha256: 'a'.repeat(64),
      size: artifactSize,
    })),
  };
}

function createCandidate(
  root: string,
  version: string,
  tuple: { platform: string; architecture: string } = {
    platform: process.platform,
    architecture: process.arch,
  },
) {
  const candidate = path.join(root, `candidate-${version}-${tuple.platform}-${tuple.architecture}`);
  mkdirSync(path.join(candidate, 'bin'), { recursive: true });
  mkdirSync(path.join(candidate, 'dist/cli'), { recursive: true });
  writeFileSync(
    path.join(candidate, 'package.json'),
    `${JSON.stringify({ name: 'spool', version })}\n`,
  );
  writeFileSync(
    path.join(candidate, 'release-runtime.json'),
    `${JSON.stringify({ ...tuple, nodeMajor: 24, nodeAbi: 137 })}\n`,
  );
  const cli = path.join(candidate, 'dist/cli/index.js');
  writeFileSync(cli, '#!/usr/bin/env node\n');
  chmodSync(cli, 0o755);
  for (const alias of ['spool']) {
    const launcher = path.join(candidate, 'bin', alias);
    writeFileSync(launcher, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`);
    chmodSync(launcher, 0o755);
  }
  return candidate;
}

function createReleaseAssets(root: string, releaseVersion: string) {
  const outputDirectory = path.join(root, `assets-${releaseVersion}`);
  mkdirSync(outputDirectory);
  for (const tuple of releaseBuild.DECLARED_RELEASE_TUPLES) {
    releaseBuild.createReleaseArchive({
      runtimeRoot: createCandidate(root, releaseVersion, tuple),
      outputDirectory,
      version: releaseVersion,
      ...tuple,
      nodeMajor: 24,
      nodeAbi: 137,
    });
  }
  releaseBuild.createReleaseManifest({
    outputDirectory,
    version: releaseVersion,
    sourceRevision: '0123456789abcdef0123456789abcdef01234567',
  });
  return outputDirectory;
}

function readFile(file: string) {
  return readFileSync(file).toString('hex');
}
