import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

interface ReleaseTuple {
  readonly platform: string;
  readonly architecture: string;
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
  readonly RELEASE_NODE_ABI: number;
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
}

interface TestReleaseModule {
  readonly smokeTestReleaseArtifact: (archivePath: string, runtimePath?: string) => unknown;
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
  DECLARED_RELEASE_TUPLES,
  RELEASE_NODE_ABI,
  artifactFilename,
  createReleaseArchive,
  createReleaseManifest,
} = buildReleaseModule;
const { smokeTestReleaseArtifact, verifyReleaseManifest } = testReleaseModule;

const version = '1.2.3';
const sourceRevision = '0123456789abcdef0123456789abcdef01234567';

describe('GitHub release artifact contract', () => {
  it('builds the complete deterministic macOS and Linux matrix', () => {
    const first = createFixtureRelease();
    const second = createFixtureRelease();

    expect(first.manifest.artifacts).toHaveLength(4);
    expect(
      first.manifest.artifacts.map(({ platform, architecture, nodeAbi }) => ({
        platform,
        architecture,
        nodeAbi,
      })),
    ).toEqual(
      DECLARED_RELEASE_TUPLES.map(({ platform, architecture }) => ({
        platform,
        architecture,
        nodeAbi: RELEASE_NODE_ABI,
      })),
    );
    expect(first.manifest.artifacts.map((artifact) => artifact.sha256)).toEqual(
      second.manifest.artifacts.map((artifact) => artifact.sha256),
    );
    expect(() => verifyReleaseManifest(first.manifestPath)).not.toThrow();
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
              nodeMajor: 24,
              nodeAbi: RELEASE_NODE_ABI,
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
    const outputDirectory = mkdtempSync(path.join(tmpdir(), 'mdspool-release-incomplete-'));
    const tuple = DECLARED_RELEASE_TUPLES[0]!;
    createReleaseArchive({
      runtimeRoot: createRuntimeRoot({
        ...tuple,
        nodeMajor: 24,
        nodeAbi: RELEASE_NODE_ABI,
      }),
      outputDirectory,
      version,
      ...tuple,
      nodeMajor: 24,
      nodeAbi: RELEASE_NODE_ABI,
    });

    expect(() => createReleaseManifest({ outputDirectory, version, sourceRevision })).toThrow(
      /missing declared tuple/i,
    );
  });

  it('runs both extracted aliases outside the repository', () => {
    const outputDirectory = mkdtempSync(path.join(tmpdir(), 'mdspool-release-smoke-'));
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
});

function createFixtureRelease(
  options: {
    readonly mutate?: (root: string) => void;
  } = {},
) {
  const outputDirectory = mkdtempSync(path.join(tmpdir(), 'mdspool-release-contract-'));
  for (const tuple of DECLARED_RELEASE_TUPLES) {
    const runtimeRoot = createRuntimeRoot({
      ...tuple,
      nodeMajor: 24,
      nodeAbi: RELEASE_NODE_ABI,
    });
    options.mutate?.(runtimeRoot);
    createReleaseArchive({
      runtimeRoot,
      outputDirectory,
      version,
      ...tuple,
      nodeMajor: 24,
      nodeAbi: RELEASE_NODE_ABI,
    });
  }
  const manifestPath = createReleaseManifest({ outputDirectory, version, sourceRevision });
  return {
    manifestPath,
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
  const root = mkdtempSync(path.join(tmpdir(), 'mdspool-runtime-root-'));
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
  for (const alias of ['spool', 'mdspool']) {
    const launcher = path.join(root, 'bin', alias);
    writeRuntimeFile(root, `bin/${alias}`, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`);
    chmodSync(launcher, 0o755);
  }
  return root;
}

function runtimePackage(packageVersion: string) {
  return {
    name: 'mdspool',
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
