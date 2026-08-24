import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

import {
  DECLARED_RELEASE_RUNTIMES,
  DECLARED_RELEASE_TUPLES,
  LEGACY_RELEASE_MANIFEST_FILENAME,
  RELEASE_CHECKSUMS_FILENAME,
  artifactFilename,
  extractReleaseArchive,
  isDeclaredReleaseRuntime,
  isDeclaredReleaseTuple,
  readReleaseArchive,
  releaseTargetKey,
  sha256,
} from './build-release.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const developmentDependencies = new Set(
  Object.keys(
    JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')).devDependencies,
  ),
);
const requiredFiles = [
  'LICENSE.md',
  'README.md',
  'package.json',
  'release-runtime.json',
  'dist/cli/index.js',
  'dist/distribution/managed-install.js',
  'bin/spool',
];
const allowedRootEntries = new Set([
  'LICENSE.md',
  'README.md',
  'package.json',
  'release-runtime.json',
  'bin',
  'dist',
  'examples',
  'node_modules',
]);

export function verifyReleaseManifest(manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 2) throw new Error('Unsupported release manifest schema');
  if (typeof manifest.version !== 'string' || !manifest.version) {
    throw new Error('Release manifest is missing a version');
  }
  if (!/^[0-9a-f]{40}$/i.test(manifest.sourceRevision)) {
    throw new Error('Release manifest source revision must be a full Git commit hash');
  }
  if (!Array.isArray(manifest.artifacts)) throw new Error('Release manifest has no artifacts');

  const manifestDirectory = path.dirname(manifestPath);
  const seen = new Set();
  for (const artifact of manifest.artifacts) {
    validateArtifactDescriptor(artifact, manifest.version);
    const targetKey = releaseTargetKey(artifact);
    if (seen.has(targetKey)) throw new Error(`Duplicate release target: ${targetKey}`);
    seen.add(targetKey);
    if (!isDeclaredReleaseTuple(artifact.platform, artifact.architecture)) {
      throw new Error(
        `Release manifest contains undeclared tuple: ${artifact.platform}-${artifact.architecture}`,
      );
    }
  }
  for (const runtime of DECLARED_RELEASE_RUNTIMES) {
    for (const tuple of DECLARED_RELEASE_TUPLES) {
      const targetKey = releaseTargetKey({ ...runtime, ...tuple });
      if (!seen.has(targetKey)) {
        throw new Error(`Release manifest is missing declared target: ${targetKey}`);
      }
    }
  }
  if (seen.size !== DECLARED_RELEASE_TUPLES.length * DECLARED_RELEASE_RUNTIMES.length) {
    throw new Error('Release manifest contains the wrong number of targets');
  }

  const checksumPath = path.join(manifestDirectory, RELEASE_CHECKSUMS_FILENAME);
  if (!existsSync(checksumPath)) throw new Error('Release candidate is missing SHA256SUMS');
  const expectedChecksums = manifest.artifacts
    .map((artifact) => `${artifact.sha256}  ${artifact.filename}`)
    .join('\n');
  if (readFileSync(checksumPath, 'utf8').trimEnd() !== expectedChecksums) {
    throw new Error('Release candidate SHA256SUMS digest list does not match the manifest');
  }

  for (const artifact of manifest.artifacts) {
    const archivePath = path.join(manifestDirectory, artifact.filename);
    const archive = readFileSync(archivePath);
    if (archive.length !== artifact.size) {
      throw new Error(`Release artifact size mismatch: ${artifact.filename}`);
    }
    if (sha256(archive) !== artifact.sha256) {
      throw new Error(`Release artifact digest mismatch: ${artifact.filename}`);
    }
    verifyArchiveContents(archivePath, artifact, manifest.version);
  }
  verifyLegacyReleaseManifest(
    path.join(manifestDirectory, LEGACY_RELEASE_MANIFEST_FILENAME),
    manifest,
  );
  return manifest;
}

export function verifyLegacyReleaseManifest(manifestPath, fullManifest) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (
    manifest.schemaVersion !== 1 ||
    typeof manifest.version !== 'string' ||
    !/^[0-9a-f]{40}$/i.test(manifest.sourceRevision) ||
    !Array.isArray(manifest.artifacts) ||
    manifest.artifacts.length !== DECLARED_RELEASE_TUPLES.length
  ) {
    throw new Error('Legacy release manifest is invalid');
  }
  if (
    fullManifest &&
    (manifest.version !== fullManifest.version ||
      manifest.sourceRevision !== fullManifest.sourceRevision)
  ) {
    throw new Error('Legacy release manifest metadata does not match the full manifest');
  }
  const seen = new Set();
  for (const artifact of manifest.artifacts) {
    validateArtifactDescriptor(artifact, manifest.version);
    const tuple = `${artifact.platform}-${artifact.architecture}`;
    if (
      artifact.nodeMajor !== 24 ||
      artifact.nodeAbi !== 137 ||
      !isDeclaredReleaseTuple(artifact.platform, artifact.architecture) ||
      seen.has(tuple)
    ) {
      throw new Error(`Legacy release manifest has an invalid target: ${tuple}`);
    }
    seen.add(tuple);
    if (fullManifest) {
      const matchingArtifact = fullManifest.artifacts.find(
        (candidate) => releaseTargetKey(candidate) === releaseTargetKey(artifact),
      );
      if (JSON.stringify(matchingArtifact) !== JSON.stringify(artifact)) {
        throw new Error(`Legacy release artifact does not match the full manifest: ${tuple}`);
      }
    }
  }
  if (seen.size !== DECLARED_RELEASE_TUPLES.length) {
    throw new Error('Legacy release manifest matrix is incomplete');
  }
  return manifest;
}

export function smokeTestReleaseArtifact(archivePath, runtimePath = process.execPath) {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'spool-release-test-'));
  const extracted = path.join(temporaryRoot, 'extracted');
  const outside = path.join(temporaryRoot, 'outside');
  mkdirSync(outside);
  try {
    extractReleaseArchive(archivePath, extracted);
    const runtimeMetadata = JSON.parse(
      readFileSync(path.join(extracted, 'release-runtime.json'), 'utf8'),
    );
    const packageManifest = JSON.parse(readFileSync(path.join(extracted, 'package.json'), 'utf8'));
    const runtime = inspectRuntime(runtimePath);
    if (
      runtime.platform !== runtimeMetadata.platform ||
      runtime.architecture !== runtimeMetadata.architecture ||
      runtime.nodeMajor !== runtimeMetadata.nodeMajor ||
      runtime.nodeAbi !== runtimeMetadata.nodeAbi
    ) {
      throw new Error(
        `Runtime ${runtime.platform}-${runtime.architecture} Node ${runtime.nodeMajor} ABI ${runtime.nodeAbi} does not match archive ${runtimeMetadata.platform}-${runtimeMetadata.architecture} Node ${runtimeMetadata.nodeMajor} ABI ${runtimeMetadata.nodeAbi}`,
      );
    }

    const environment = {
      ...process.env,
      PATH: `${path.dirname(runtimePath)}${path.delimiter}${process.env.PATH ?? ''}`,
    };
    for (const alias of ['spool']) {
      const result = spawnSync(path.join(extracted, 'bin', alias), ['--version'], {
        cwd: outside,
        encoding: 'utf8',
        env: environment,
      });
      if (result.status !== 0) {
        throw new Error(`${alias} failed outside the repository:\n${result.stderr}`);
      }
      if (result.stdout.trim() !== packageManifest.version) {
        throw new Error(
          `${alias} version ${result.stdout.trim()} does not match package version ${packageManifest.version}`,
        );
      }
    }

    const nativeSmoke = spawnSync(
      runtimePath,
      [
        '-e',
        "const{createRequire}=require('node:module');const path=require('node:path');const r=createRequire(path.join(process.cwd(),'package.json'));const D=r('better-sqlite3');const db=new D(':memory:');db.close();",
      ],
      { cwd: extracted, encoding: 'utf8', env: environment },
    );
    if (nativeSmoke.status !== 0) {
      throw new Error(
        `Native module failed to load from extracted archive:\n${nativeSmoke.stderr}`,
      );
    }
    return { version: packageManifest.version, runtime };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export function smokeTestDaemonLockRefusal(archivePath, runtimePath = process.execPath) {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'spool-release-lock-test-'));
  const extracted = path.join(temporaryRoot, 'extracted');
  const helperPath = path.join(temporaryRoot, 'daemon-lock-smoke.mjs');
  try {
    extractReleaseArchive(archivePath, extracted);
    writeFileSync(
      helperPath,
      `import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const extracted = process.env.SPOOL_SMOKE_EXTRACTED;
const root = process.env.SPOOL_SMOKE_ROOT;
if (!extracted || !root) throw new Error('Missing release smoke environment');
const load = (entry) => import(pathToFileURL(path.join(extracted, entry)).href);
const { openLedgerDatabase } = await load('dist/ledger/database.js');
const { DaemonLock } = await load('dist/ledger/daemon-lock.js');
const { currentProcessStartIdentity } = await load('dist/process-identity.js');
const state = path.join(root, 'state');
const prefix = path.join(root, 'prefix');
const configPath = path.join(root, 'config.yaml');
mkdirSync(state, { recursive: true });
writeFileSync(configPath, \`stateDirectory: \${JSON.stringify(state)}\\n\`);
const database = openLedgerDatabase(state);
const lock = new DaemonLock(database);
const owner = lock.acquire({ nonce: 'release-smoke', pid: process.pid, processStartIdentity: currentProcessStartIdentity() }, 60_000);
try {
  const packageManifest = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(extracted, 'package.json'), 'utf8'));
  const runtime = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(extracted, 'release-runtime.json'), 'utf8'));
  const result = spawnSync(process.execPath, [path.join(extracted, 'dist/distribution/managed-install.js'), 'install', '--candidate', extracted, '--prefix', prefix, '--version', packageManifest.version, '--release-source', 'https://example.invalid/releases/latest/download', '--artifact-digest', '${sha256(readFileSync(archivePath))}', '--node-abi', String(runtime.nodeAbi), '--config', configPath], { encoding: 'utf8' });
  if (result.status !== 1 || !result.stderr.includes(\`kill \${process.pid}\`)) {
    throw new Error(\`Managed installer did not refuse the active daemon lock:\\n\${result.stdout}\\n\${result.stderr}\`);
  }
  if (existsSync(path.join(prefix, 'lib/spool/current'))) throw new Error('Daemon-lock refusal changed the active installation');
} finally {
  lock.release(owner);
  database.close();
}
`,
    );
    const result = spawnSync(runtimePath, [helperPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        SPOOL_SMOKE_EXTRACTED: extracted,
        SPOOL_SMOKE_ROOT: temporaryRoot,
      },
    });
    if (result.status !== 0) {
      throw new Error(`Release daemon-lock smoke failed:\n${result.stdout}\n${result.stderr}`);
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function validateArtifactDescriptor(artifact, version) {
  if (!isDeclaredReleaseRuntime(artifact.nodeMajor, artifact.nodeAbi)) {
    throw new Error(
      `Release artifact ${artifact.filename ?? '<unknown>'} declares an unsupported Node runtime`,
    );
  }
  const expectedFilename = artifactFilename({ version, ...artifact });
  if (artifact.filename !== expectedFilename) {
    throw new Error(`Release artifact filename mismatch: expected ${expectedFilename}`);
  }
  if (!/^[0-9a-f]{64}$/.test(artifact.sha256) || !Number.isSafeInteger(artifact.size)) {
    throw new Error(`Release artifact has invalid digest or size: ${artifact.filename}`);
  }
}

function verifyArchiveContents(archivePath, artifact, version) {
  const entries = readReleaseArchive(archivePath);
  for (const required of requiredFiles) {
    const entry = entries.get(required);
    if (!entry || (entry.type === '0' && entry.contents.length === 0)) {
      throw new Error(`Release archive is missing required runtime file: ${required}`);
    }
  }
  for (const entry of entries.values()) {
    const rootEntry = entry.path.split('/')[0];
    if (!allowedRootEntries.has(rootEntry)) {
      throw new Error(`Release archive contains development-only file: ${entry.path}`);
    }
  }
  for (const executable of ['dist/cli/index.js', 'bin/spool']) {
    if ((entries.get(executable).mode & 0o111) === 0) {
      throw new Error(`Release runtime file is not executable: ${executable}`);
    }
  }

  const packageManifest = parseArchiveJson(entries, 'package.json');
  if (packageManifest.version !== version) {
    throw new Error(
      `Release package version ${packageManifest.version} does not match manifest version ${version}`,
    );
  }
  if (packageManifest.devDependencies || packageManifest.publishConfig) {
    throw new Error('Release package contains development-only package metadata');
  }
  for (const dependency of Object.keys(packageManifest.dependencies ?? {})) {
    if (!entries.has(`node_modules/${dependency}/package.json`)) {
      throw new Error(`Release archive is missing production dependency: ${dependency}`);
    }
  }
  for (const dependency of developmentDependencies) {
    if (entries.has(`node_modules/${dependency}/package.json`)) {
      throw new Error(`Release archive contains development-only dependency: ${dependency}`);
    }
  }

  const runtime = parseArchiveJson(entries, 'release-runtime.json');
  if (
    runtime.platform !== artifact.platform ||
    runtime.architecture !== artifact.architecture ||
    runtime.nodeMajor !== artifact.nodeMajor ||
    runtime.nodeAbi !== artifact.nodeAbi
  ) {
    throw new Error(`Release runtime tuple does not match manifest: ${artifact.filename}`);
  }
  if (typeof runtime.nativeModule !== 'string' || !entries.has(runtime.nativeModule)) {
    throw new Error(`Release archive is missing its declared native module: ${artifact.filename}`);
  }
  if (!runtime.nativeModule.endsWith('.node')) {
    throw new Error(`Release archive declares an invalid native module: ${runtime.nativeModule}`);
  }
}

function parseArchiveJson(entries, entryPath) {
  try {
    return JSON.parse(entries.get(entryPath).contents.toString('utf8'));
  } catch (error) {
    throw new Error(`Release archive contains invalid ${entryPath}: ${String(error)}`);
  }
}

function inspectRuntime(runtimePath) {
  if (!existsSync(runtimePath)) throw new Error(`Node runtime does not exist: ${runtimePath}`);
  const expression =
    "JSON.stringify({platform:process.platform,architecture:process.arch,nodeMajor:Number(process.versions.node.split('.')[0]),nodeAbi:Number(process.versions.modules)})";
  const result = spawnSync(runtimePath, ['-p', expression], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Could not inspect Node runtime:\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined)
      throw new Error(`Invalid argument: ${key ?? ''}`);
    options[key.slice(2)] = value;
  }
  return options;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.artifact) {
    const archivePath = path.resolve(options.artifact);
    smokeTestReleaseArtifact(archivePath, options.runtime);
    if (options['daemon-lock'] === 'true') {
      smokeTestDaemonLockRefusal(archivePath, options.runtime);
    }
    process.stdout.write(`Verified release artifact ${options.artifact}\n`);
    return;
  }
  if (!options.manifest)
    throw new Error('Usage: test-release.mjs --manifest <path> [--runtime <node>]');
  const manifestPath = path.resolve(options.manifest);
  const manifest = verifyReleaseManifest(manifestPath);
  const runtime = inspectRuntime(options.runtime ?? process.execPath);
  const artifact = manifest.artifacts.find(
    (candidate) =>
      candidate.platform === runtime.platform &&
      candidate.architecture === runtime.architecture &&
      candidate.nodeMajor === runtime.nodeMajor &&
      candidate.nodeAbi === runtime.nodeAbi,
  );
  if (!artifact) {
    throw new Error(
      `Manifest has no artifact for ${runtime.platform}-${runtime.architecture} Node ${runtime.nodeMajor} ABI ${runtime.nodeAbi}`,
    );
  }
  smokeTestReleaseArtifact(
    path.join(path.dirname(manifestPath), artifact.filename),
    options.runtime,
  );
  if (options['daemon-lock'] === 'true') {
    smokeTestDaemonLockRefusal(
      path.join(path.dirname(manifestPath), artifact.filename),
      options.runtime,
    );
  }
  process.stdout.write(
    `Verified ${artifact.filename} and complete ${manifest.artifacts.length}-tuple manifest\n`,
  );
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
