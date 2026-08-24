import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { installManagedRelease } from '../../src/distribution/managed-install.js';

interface ReleaseTuple {
  readonly platform: string;
  readonly architecture: string;
}

interface ReleaseRuntime {
  readonly nodeMajor: number;
  readonly nodeAbi: number;
}

interface ArtifactDescriptor extends ReleaseTuple {
  readonly filename: string;
  readonly nodeMajor: number;
  readonly nodeAbi: number;
  readonly sha256: string;
  readonly size: number;
}

interface BuildReleaseModule {
  readonly DECLARED_RELEASE_TUPLES: readonly ReleaseTuple[];
  readonly DECLARED_RELEASE_RUNTIMES: readonly ReleaseRuntime[];
  readonly createReleaseArchive: (input: {
    runtimeRoot: string;
    outputDirectory: string;
    version: string;
    platform: string;
    architecture: string;
    nodeMajor: number;
    nodeAbi: number;
  }) => ArtifactDescriptor;
  readonly createReleaseManifest: (input: {
    outputDirectory: string;
    version: string;
    sourceRevision: string;
  }) => string;
}

const releaseModule = (await import(
  // @ts-expect-error The release build executable is intentionally plain JavaScript.
  '../../scripts/build-release.mjs'
)) as BuildReleaseModule;
const {
  DECLARED_RELEASE_RUNTIMES,
  DECLARED_RELEASE_TUPLES,
  createReleaseArchive,
  createReleaseManifest,
} = releaseModule;
const node24Runtime = DECLARED_RELEASE_RUNTIMES[0]!;
const node26Runtime = DECLARED_RELEASE_RUNTIMES[1]!;
const installerPath = fileURLToPath(new URL('../../install.sh', import.meta.url));
const installerSource = readFileSync(installerPath, 'utf8');
const version = '1.2.3';

describe('POSIX release installer', () => {
  it.each([
    ['latest stable', []],
    ['an exact version', ['--version', version]],
  ])('downloads and invokes the candidate installer for %s', (_label, versionArguments) => {
    const fixture = bootstrapFixture();
    const configPath = path.join(fixture.root, 'custom config.yaml');
    const result = runBootstrap(fixture, versionArguments, { configPath });

    expect(result.status).toBe(0);
    const invocation = JSON.parse(readFileSync(fixture.recordPath, 'utf8')) as string[];
    expect(invocation).toContain('--candidate');
    expect(invocation).toContain('--prefix');
    expect(invocation).toContain(fixture.prefix);
    expect(invocation).toContain('--version');
    expect(invocation).toContain(version);
    expect(invocation).toContain('--artifact-digest');
    expect(invocation).toContain(node24Runtime.nodeAbi.toString());
    expect(invocation.slice(-2)).toEqual(['--config', configPath]);
  });

  it('selects and installs the Node 26 ABI 147 release target', () => {
    const fixture = bootstrapFixture();
    const result = runBootstrap(fixture, [], {
      nodeMajor: node26Runtime.nodeMajor.toString(),
      nodeAbi: node26Runtime.nodeAbi.toString(),
    });

    expect(result.status).toBe(0);
    const invocation = JSON.parse(readFileSync(fixture.recordPath, 'utf8')) as string[];
    expect(invocation).toContain(node26Runtime.nodeAbi.toString());
    const manifest = JSON.parse(
      readFileSync(path.join(fixture.downloadDirectories[0]!, 'release-manifest-v2.json'), 'utf8'),
    ) as ReleaseManifestFixture;
    const expected = manifest.artifacts.find(
      (artifact) =>
        artifact.platform === process.platform &&
        artifact.architecture === process.arch &&
        artifact.nodeMajor === node26Runtime.nodeMajor &&
        artifact.nodeAbi === node26Runtime.nodeAbi,
    )!;
    expect(invocation[invocation.indexOf('--artifact-digest') + 1]).toBe(expected.sha256);
  });

  it('bounds manifest and artifact download duration', () => {
    expect(
      installerSource.match(
        /curl -fL --retry 2 --connect-timeout 10 --max-time 300[\\\s]+--speed-limit 1024 --speed-time 30/g,
      ),
    ).toHaveLength(2);
  });

  it('requires an explicit prefix when HOME is unset before downloading', () => {
    const fixture = bootstrapFixture();
    const result = runBootstrap(fixture, [], {
      includePrefix: false,
      home: null,
      releasesUrl: `file://${path.join(fixture.root, 'missing-releases')}`,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('HOME is not set; pass --prefix PATH');
    expect(result.stderr).not.toContain('could not download release manifest');
    expect(existsSync(fixture.recordPath)).toBe(false);
  });

  it('defaults the prefix beneath HOME when no prefix is supplied', () => {
    const fixture = bootstrapFixture();
    const home = path.join(fixture.root, 'home');
    const result = runBootstrap(fixture, [], { home, includePrefix: false });

    expect(result.status).toBe(0);
    const invocation = JSON.parse(readFileSync(fixture.recordPath, 'utf8')) as string[];
    expect(invocation).toContain(path.join(home, '.local'));
  });

  it('accepts an explicit prefix when HOME is unset', () => {
    const fixture = bootstrapFixture();
    const result = runBootstrap(fixture, [], { home: null });

    expect(result.status).toBe(0);
    const invocation = JSON.parse(readFileSync(fixture.recordPath, 'utf8')) as string[];
    expect(invocation).toContain(fixture.prefix);
  });

  it('rejects unsupported Node before downloading or changing the prefix', () => {
    const fixture = bootstrapFixture();
    const result = runBootstrap(fixture, [], { nodeAbi: '999' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unsupported Node runtime 24 ABI 999');
    expect(existsSync(fixture.recordPath)).toBe(false);
    expect(existsSync(fixture.prefix)).toBe(false);
  });

  it('rejects a malformed manifest before downloading an artifact', () => {
    const fixture = bootstrapFixture();
    for (const directory of fixture.downloadDirectories) {
      writeFileSync(path.join(directory, 'release-manifest-v2.json'), '{ malformed');
    }

    const result = runBootstrap(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('manifest is malformed');
    expect(existsSync(fixture.recordPath)).toBe(false);
  });

  it.each([
    [
      'missing source revision',
      (manifest: ReleaseManifestFixture) => {
        delete manifest.sourceRevision;
      },
    ],
    [
      'invalid artifact size',
      (manifest: ReleaseManifestFixture) => {
        manifest.artifacts[0]!.size = 0;
      },
    ],
    [
      'duplicate tuple',
      (manifest: ReleaseManifestFixture) => {
        manifest.artifacts[1] = { ...manifest.artifacts[0]! };
      },
    ],
    [
      'incomplete matrix',
      (manifest: ReleaseManifestFixture) => {
        manifest.artifacts.pop();
      },
    ],
    [
      'undeclared tuple',
      (manifest: ReleaseManifestFixture) => {
        manifest.artifacts[0]!.platform = 'win32';
      },
    ],
    [
      'inconsistent filename',
      (manifest: ReleaseManifestFixture) => {
        manifest.artifacts[0]!.filename = 'unexpected.tar.gz';
      },
    ],
  ])('rejects a manifest with %s before downloading an artifact', (_label, mutate) => {
    const fixture = bootstrapFixture();
    for (const directory of fixture.downloadDirectories) {
      const manifestPath = path.join(directory, 'release-manifest-v2.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ReleaseManifestFixture;
      mutate(manifest);
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }

    const result = runBootstrap(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('manifest is malformed');
    expect(existsSync(fixture.recordPath)).toBe(false);
  });

  it('rejects an artifact digest mismatch before invoking candidate code', () => {
    const fixture = bootstrapFixture();
    const latest = fixture.downloadDirectories[0]!;
    const manifest = JSON.parse(
      readFileSync(path.join(latest, 'release-manifest-v2.json'), 'utf8'),
    ) as {
      artifacts: ArtifactDescriptor[];
    };
    const selected = manifest.artifacts.find(
      (artifact) =>
        artifact.platform === process.platform &&
        artifact.architecture === process.arch &&
        artifact.nodeMajor === node24Runtime.nodeMajor &&
        artifact.nodeAbi === node24Runtime.nodeAbi,
    )!;
    const artifactPath = path.join(latest, selected.filename);
    const tampered = readFileSync(artifactPath);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    writeFileSync(artifactPath, tampered);

    const result = runBootstrap(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('SHA-256 mismatch');
    expect(existsSync(fixture.recordPath)).toBe(false);
  });

  it('rejects an artifact size mismatch before invoking candidate code', () => {
    const fixture = bootstrapFixture();
    const latest = fixture.downloadDirectories[0]!;
    const manifest = JSON.parse(
      readFileSync(path.join(latest, 'release-manifest-v2.json'), 'utf8'),
    ) as {
      artifacts: ArtifactDescriptor[];
    };
    const selected = manifest.artifacts.find(
      (artifact) =>
        artifact.platform === process.platform &&
        artifact.architecture === process.arch &&
        artifact.nodeMajor === node24Runtime.nodeMajor &&
        artifact.nodeAbi === node24Runtime.nodeAbi,
    )!;
    const artifactPath = path.join(latest, selected.filename);
    const artifact = readFileSync(artifactPath);
    writeFileSync(artifactPath, artifact.subarray(0, artifact.length - 1));

    const result = runBootstrap(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('artifact size mismatch');
    expect(existsSync(fixture.recordPath)).toBe(false);
  });

  it('reports an interrupted or unavailable release download without changing the prefix', () => {
    const fixture = bootstrapFixture();
    const result = runBootstrap(fixture, [], {
      releasesUrl: `file://${path.join(fixture.root, 'missing-releases')}`,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('could not download release manifest');
    expect(existsSync(fixture.prefix)).toBe(false);
  });

  it('activates the real managed executable and keeps smoke state isolated', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'spool-install-e2e-'));
    const candidate = createCandidate(root, {
      platform: process.platform,
      architecture: process.arch,
      ...node24Runtime,
      realInstaller: false,
    });
    const prefix = path.join(root, 'prefix');
    const smokeRoot = path.join(root, 'smoke-state-must-not-exist');
    const result = await installManagedRelease(
      {
        candidateDirectory: candidate,
        prefix,
        version,
        channel: 'stable',
        releaseSource: 'https://example.test/releases/latest/download',
        artifactDigest: 'c'.repeat(64),
        nodeAbi: node24Runtime.nodeAbi,
      },
      {
        withDaemonLock: (_configPath, operation) => Promise.resolve(operation()),
        pathValue: path.join(prefix, 'bin'),
        runtimeIdentity: {
          platform: process.platform,
          architecture: process.arch,
          ...node24Runtime,
        },
      },
    );

    expect(result).toMatchObject({ status: 'installed', exitCode: 0 });
    expect(readlinkSync(path.join(prefix, 'lib/spool/current'))).toBe(
      `versions/${version}-abi${String(node24Runtime.nodeAbi)}`,
    );
    for (const alias of ['spool']) {
      const executed = spawnSync(path.join(prefix, 'bin', alias), ['--version'], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, XDG_STATE_HOME: smokeRoot, XDG_CONFIG_HOME: smokeRoot },
      });
      expect(executed.status).toBe(0);
      expect(executed.stdout.trim()).toBe(version);
    }
    expect(existsSync(smokeRoot)).toBe(false);
  });
});

function bootstrapFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'spool-bootstrap-e2e-'));
  const releases = path.join(root, 'releases');
  const assets = path.join(root, 'assets');
  mkdirSync(assets);
  for (const runtime of DECLARED_RELEASE_RUNTIMES) {
    for (const tuple of DECLARED_RELEASE_TUPLES) {
      createReleaseArchive({
        runtimeRoot: createCandidate(root, { ...tuple, ...runtime, realInstaller: true }),
        outputDirectory: assets,
        version,
        ...tuple,
        ...runtime,
      });
    }
  }
  createReleaseManifest({
    outputDirectory: assets,
    version,
    sourceRevision: '0123456789abcdef0123456789abcdef01234567',
  });
  const latest = path.join(releases, 'latest/download');
  const exact = path.join(releases, `download/v${version}`);
  for (const directory of [latest, exact]) {
    mkdirSync(directory, { recursive: true });
    cpSync(assets, directory, { recursive: true });
  }
  const fakeBin = path.join(root, 'fake-bin');
  mkdirSync(fakeBin);
  const fakeNode = path.join(fakeBin, 'node');
  writeFileSync(
    fakeNode,
    [
      '#!/bin/sh',
      'if [ "$1" = "-p" ]; then',
      '  case "$2" in',
      '    *process.versions.modules*) printf "%s\\n" "${SPOOL_TEST_NODE_ABI:-137}"; exit 0 ;;',
      '    *process.versions.node*) printf "%s\\n" "${SPOOL_TEST_NODE_MAJOR:-24}"; exit 0 ;;',
      '  esac',
      'fi',
      'exec "$SPOOL_TEST_REAL_NODE" "$@"',
      '',
    ].join('\n'),
  );
  chmodSync(fakeNode, 0o755);
  return {
    root,
    releases,
    fakeBin,
    prefix: path.join(root, 'prefix'),
    recordPath: path.join(root, 'managed-install-invocation.json'),
    downloadDirectories: [latest, exact],
  };
}

interface ReleaseManifestFixture {
  sourceRevision?: string;
  artifacts: Array<{
    filename: string;
    platform: string;
    architecture: string;
    nodeMajor: number;
    nodeAbi: number;
    sha256: string;
    size: number;
  }>;
}

function runBootstrap(
  fixture: ReturnType<typeof bootstrapFixture>,
  versionArguments: string[] = [],
  overrides: {
    nodeMajor?: string;
    nodeAbi?: string;
    releasesUrl?: string;
    configPath?: string;
    home?: string | null;
    includePrefix?: boolean;
  } = {},
) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${fixture.fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
    SPOOL_RELEASE_BASE_URL: overrides.releasesUrl ?? `file://${fixture.releases}`,
    SPOOL_TEST_NODE_MAJOR: overrides.nodeMajor ?? node24Runtime.nodeMajor.toString(),
    SPOOL_TEST_NODE_ABI: overrides.nodeAbi ?? node24Runtime.nodeAbi.toString(),
    SPOOL_TEST_REAL_NODE: process.execPath,
    SPOOL_TEST_RECORD: fixture.recordPath,
  };
  if (overrides.home === null) {
    delete env.HOME;
  } else if (overrides.home !== undefined) {
    env.HOME = overrides.home;
  }
  if (overrides.configPath !== undefined) {
    env.SPOOL_CONFIG_PATH = overrides.configPath;
  } else {
    delete env.SPOOL_CONFIG_PATH;
  }
  const prefixArguments = overrides.includePrefix === false ? [] : ['--prefix', fixture.prefix];
  return spawnSync('/bin/sh', [installerPath, ...versionArguments, ...prefixArguments], {
    cwd: fixture.root,
    encoding: 'utf8',
    env,
  });
}

function createCandidate(
  root: string,
  options: ReleaseTuple & ReleaseRuntime & { readonly realInstaller: boolean },
): string {
  const candidate = mkdtempSync(path.join(root, 'candidate-'));
  mkdirSync(path.join(candidate, 'bin'), { recursive: true });
  mkdirSync(path.join(candidate, 'dist/cli'), { recursive: true });
  mkdirSync(path.join(candidate, 'dist/distribution'), { recursive: true });
  writeFileSync(
    path.join(candidate, 'package.json'),
    `${JSON.stringify({ name: 'spool', version, type: 'module' })}\n`,
  );
  writeFileSync(
    path.join(candidate, 'release-runtime.json'),
    `${JSON.stringify({
      platform: options.platform,
      architecture: options.architecture,
      nodeMajor: options.nodeMajor,
      nodeAbi: options.nodeAbi,
    })}\n`,
  );
  const cli = path.join(candidate, 'dist/cli/index.js');
  writeFileSync(cli, '#!/usr/bin/env node\n');
  chmodSync(cli, 0o755);
  for (const alias of ['spool']) {
    const launcher = path.join(candidate, 'bin', alias);
    writeFileSync(launcher, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`);
    chmodSync(launcher, 0o755);
  }
  const managedInstaller = path.join(candidate, 'dist/distribution/managed-install.js');
  writeFileSync(
    managedInstaller,
    options.realInstaller
      ? [
          "import { writeFileSync } from 'node:fs';",
          'writeFileSync(process.env.SPOOL_TEST_RECORD, JSON.stringify(process.argv.slice(2)));',
          "process.stdout.write('stub managed install complete\\n');",
          '',
        ].join('\n')
      : '#!/usr/bin/env node\n',
  );
  chmodSync(managedInstaller, 0o755);
  return candidate;
}
