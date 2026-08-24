import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

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
  readonly artifactFilename: (input: {
    readonly version: string;
    readonly platform: string;
    readonly architecture: string;
    readonly nodeMajor: number;
    readonly nodeAbi: number;
  }) => string;
  readonly createReleaseArchive: (input: {
    readonly runtimeRoot: string;
    readonly outputDirectory: string;
    readonly version: string;
    readonly platform: string;
    readonly architecture: string;
    readonly nodeMajor: number;
    readonly nodeAbi: number;
  }) => ArtifactDescriptor;
  readonly createReleaseManifest: (input: {
    readonly outputDirectory: string;
    readonly version: string;
    readonly sourceRevision: string;
  }) => string;
  readonly renderLauncher: () => string;
}

interface TestReleaseModule {
  readonly smokeTestReleaseArtifact: (archivePath: string, runtimePath?: string) => unknown;
  readonly verifyLegacyReleaseManifest: (manifestPath: string) => unknown;
  readonly verifyReleaseManifest: (manifestPath: string) => unknown;
}

const buildReleaseModule = (await import(
  // @ts-expect-error The release build executable is intentionally plain JavaScript.
  '../../scripts/build-release.mjs'
)) as BuildReleaseModule;
const testReleaseModule = (await import(
  // @ts-expect-error The release verifier executable is intentionally plain JavaScript.
  '../../scripts/test-release.mjs'
)) as TestReleaseModule;
const {
  DECLARED_RELEASE_RUNTIMES,
  DECLARED_RELEASE_TUPLES,
  artifactFilename,
  createReleaseArchive,
  createReleaseManifest,
  renderLauncher,
} = buildReleaseModule;
const { smokeTestReleaseArtifact, verifyLegacyReleaseManifest, verifyReleaseManifest } =
  testReleaseModule;

const version = '1.2.3';
const sourceRevision = '0123456789abcdef0123456789abcdef01234567';

describe('GitHub release artifact contract', () => {
  it('builds the complete deterministic Node 24 and Node 26 platform matrix', () => {
    const first = createFixtureRelease();
    const second = createFixtureRelease();

    expect(first.manifest.artifacts).toHaveLength(8);
    expect(
      first.manifest.artifacts.map(({ platform, architecture, nodeAbi }) => ({
        platform,
        architecture,
        nodeAbi,
      })),
    ).toEqual(
      DECLARED_RELEASE_RUNTIMES.flatMap(({ nodeAbi }) =>
        DECLARED_RELEASE_TUPLES.map(({ platform, architecture }) => ({
          platform,
          architecture,
          nodeAbi,
        })),
      ),
    );
    expect(first.manifest.artifacts.map((artifact) => artifact.sha256)).toEqual(
      second.manifest.artifacts.map((artifact) => artifact.sha256),
    );
    expect(() => verifyReleaseManifest(first.manifestPath)).not.toThrow();
    expect(() => verifyLegacyReleaseManifest(first.legacyManifestPath)).not.toThrow();
    expect(first.legacyManifest.artifacts).toHaveLength(4);
    expect(first.legacyManifest.artifacts.every(({ nodeMajor }) => nodeMajor === 24)).toBe(true);
  });

  it.each([
    ['missing runtime file', (root: string) => writeFileSync(path.join(root, 'LICENSE.md'), '')],
    ['development-only file', (root: string) => writeRuntimeFile(root, 'src/index.ts', 'source')],
    [
      'version mismatch',
      (root: string) =>
        writeRuntimeFile(
          root,
          'package.json',
          `${JSON.stringify(runtimePackage('9.9.9'), null, 2)}\n`,
        ),
    ],
  ])('rejects a %s', (_name, mutate) => {
    const fixture = createFixtureRelease({ mutate });

    expect(() => verifyReleaseManifest(fixture.manifestPath)).toThrow();
  });

  it('rejects a manifest/archive digest mismatch', () => {
    const fixture = createFixtureRelease();
    const manifest = JSON.parse(readFileSync(fixture.manifestPath, 'utf8')) as {
      artifacts: Array<{ sha256: string }>;
    };
    manifest.artifacts[0]!.sha256 = '0'.repeat(64);
    writeFileSync(fixture.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(() => verifyReleaseManifest(fixture.manifestPath)).toThrow(/digest/i);
  });

  it('rejects missing assembled checksums', () => {
    const fixture = createFixtureRelease();
    writeFileSync(path.join(path.dirname(fixture.manifestPath), 'SHA256SUMS'), '');

    expect(() => verifyReleaseManifest(fixture.manifestPath)).toThrow(/SHA256SUMS/i);
  });

  it('rejects a missing native module', () => {
    const fixture = createFixtureRelease({
      mutate: (root) =>
        writeRuntimeFile(
          root,
          'release-runtime.json',
          `${JSON.stringify(
            {
              platform: 'darwin',
              architecture: 'x64',
              ...DECLARED_RELEASE_RUNTIMES[0]!,
              nativeModule: 'node_modules/better-sqlite3/build/Release/missing.node',
            },
            null,
            2,
          )}\n`,
        ),
    });

    expect(() => verifyReleaseManifest(fixture.manifestPath)).toThrow(/native module/i);
  });

  it('rejects an undeclared tuple', () => {
    const fixture = createFixtureRelease();
    const manifest = JSON.parse(readFileSync(fixture.manifestPath, 'utf8')) as {
      artifacts: ArtifactDescriptor[];
    };
    const extraBase = { ...manifest.artifacts[0]!, platform: 'win32' };
    const extra = { ...extraBase, filename: artifactFilename({ version, ...extraBase }) };
    manifest.artifacts.push(extra);
    writeFileSync(fixture.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(() => verifyReleaseManifest(fixture.manifestPath)).toThrow(/undeclared tuple/i);
  });

  it('refuses to create an incomplete manifest', () => {
    const outputDirectory = mkdtempSync(path.join(tmpdir(), 'spool-release-incomplete-'));
    const tuple = DECLARED_RELEASE_TUPLES[0]!;
    const runtime = DECLARED_RELEASE_RUNTIMES[0]!;
    createReleaseArchive({
      runtimeRoot: createRuntimeRoot({
        ...tuple,
        ...runtime,
      }),
      outputDirectory,
      version,
      ...tuple,
      ...runtime,
    });

    expect(() => createReleaseManifest({ outputDirectory, version, sourceRevision })).toThrow(
      /missing declared target/i,
    );
  });

  it('runs the extracted executable outside the repository', () => {
    const outputDirectory = mkdtempSync(path.join(tmpdir(), 'spool-release-smoke-'));
    const runtimeRoot = createRuntimeRoot({
      nodeAbi: Number(process.versions.modules),
      nodeMajor: Number(process.versions.node.split('.')[0]),
      platform: process.platform,
      architecture: process.arch,
    });
    const artifact = createReleaseArchive({
      runtimeRoot,
      outputDirectory,
      version,
      platform: process.platform,
      architecture: process.arch,
      nodeMajor: Number(process.versions.node.split('.')[0]),
      nodeAbi: Number(process.versions.modules),
    });

    expect(() =>
      smokeTestReleaseArtifact(path.join(outputDirectory, artifact.filename)),
    ).not.toThrow();
  });

  it('rejects a launcher runtime change before loading the CLI', () => {
    const currentMajor = Number(process.versions.node.split('.')[0]);
    const mismatchedRuntime = DECLARED_RELEASE_RUNTIMES.find(
      (runtime) => runtime.nodeMajor !== currentMajor,
    )!;
    const root = createRuntimeRoot({
      platform: process.platform,
      architecture: process.arch,
      ...mismatchedRuntime,
    });
    const launcher = path.join(root, 'bin/spool');
    writeFileSync(launcher, renderLauncher());
    chmodSync(launcher, 0o755);

    const result = spawnSync(launcher, ['--version'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`built for Node ${String(mismatchedRuntime.nodeMajor)}`);
    expect(result.stderr).toContain('Reinstall spool');
  });
});

function createFixtureRelease(
  options: {
    readonly mutate?: (root: string) => void;
  } = {},
) {
  const outputDirectory = mkdtempSync(path.join(tmpdir(), 'spool-release-contract-'));
  for (const runtime of DECLARED_RELEASE_RUNTIMES) {
    for (const tuple of DECLARED_RELEASE_TUPLES) {
      const runtimeRoot = createRuntimeRoot({ ...tuple, ...runtime });
      options.mutate?.(runtimeRoot);
      createReleaseArchive({
        runtimeRoot,
        outputDirectory,
        version,
        ...tuple,
        ...runtime,
      });
    }
  }
  const manifestPath = createReleaseManifest({ outputDirectory, version, sourceRevision });
  const legacyManifestPath = path.join(outputDirectory, 'release-manifest.json');
  return {
    manifestPath,
    legacyManifestPath,
    legacyManifest: JSON.parse(readFileSync(legacyManifestPath, 'utf8')) as {
      artifacts: Array<{ nodeMajor: number }>;
    },
    manifest: JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      artifacts: Array<{
        platform: string;
        architecture: string;
        nodeAbi: number;
        sha256: string;
      }>;
    },
  };
}

function createRuntimeRoot(tuple: {
  readonly platform: string;
  readonly architecture: string;
  readonly nodeMajor: number;
  readonly nodeAbi: number;
}): string {
  const root = mkdtempSync(path.join(tmpdir(), 'spool-runtime-root-'));
  writeRuntimeFile(root, 'LICENSE.md', 'fixture license\n');
  writeRuntimeFile(root, 'README.md', '# Fixture\n');
  writeRuntimeFile(root, 'package.json', `${JSON.stringify(runtimePackage(version), null, 2)}\n`);
  writeRuntimeFile(root, 'dist/cli/index.js', '#!/usr/bin/env node\n');
  chmodSync(path.join(root, 'dist/cli/index.js'), 0o755);
  writeRuntimeFile(root, 'dist/distribution/managed-install.js', 'export {};\n');
  writeRuntimeFile(
    root,
    'node_modules/better-sqlite3/package.json',
    `${JSON.stringify({ name: 'better-sqlite3', version: '12.11.1', main: 'index.js' })}\n`,
  );
  writeRuntimeFile(
    root,
    'node_modules/better-sqlite3/index.js',
    'module.exports = class Database { close() {} };\n',
  );
  const nativeModule = 'node_modules/better-sqlite3/build/Release/better_sqlite3.node';
  writeRuntimeFile(root, nativeModule, 'fixture native module\n');
  writeRuntimeFile(
    root,
    'release-runtime.json',
    `${JSON.stringify({ ...tuple, nativeModule }, null, 2)}\n`,
  );
  for (const alias of ['spool']) {
    const launcher = path.join(root, 'bin', alias);
    writeRuntimeFile(root, `bin/${alias}`, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`);
    chmodSync(launcher, 0o755);
  }
  return root;
}

function runtimePackage(packageVersion: string) {
  return {
    name: 'spool',
    version: packageVersion,
    type: 'module',
    dependencies: { 'better-sqlite3': '12.11.1' },
  };
}

function writeRuntimeFile(root: string, relativePath: string, contents: string): void {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}
