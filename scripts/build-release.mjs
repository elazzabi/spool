import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';

import { inspectNpmPackage } from './test-package.mjs';

export const RELEASE_NODE_MAJOR = 24;
export const RELEASE_NODE_ABI = 137;
export const RELEASE_MANIFEST_FILENAME = 'release-manifest.json';
export const RELEASE_CHECKSUMS_FILENAME = 'SHA256SUMS';
export const DECLARED_RELEASE_TUPLES = Object.freeze([
  Object.freeze({ platform: 'darwin', architecture: 'x64' }),
  Object.freeze({ platform: 'darwin', architecture: 'arm64' }),
  Object.freeze({ platform: 'linux', architecture: 'x64' }),
  Object.freeze({ platform: 'linux', architecture: 'arm64' }),
]);

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const metadataSuffix = '.metadata.json';

export function artifactFilename({ version, platform, architecture, nodeMajor, nodeAbi }) {
  return `spool-v${version}-node${nodeMajor}-abi${nodeAbi}-${platform}-${architecture}.tar.gz`;
}

export function createReleaseArchive({
  runtimeRoot,
  outputDirectory,
  version,
  platform,
  architecture,
  nodeMajor = RELEASE_NODE_MAJOR,
  nodeAbi = RELEASE_NODE_ABI,
}) {
  const filename = artifactFilename({ version, platform, architecture, nodeMajor, nodeAbi });
  const archivePath = path.join(outputDirectory, filename);
  mkdirSync(outputDirectory, { recursive: true });
  const archive = createDeterministicTarGzip(runtimeRoot);
  writeFileSync(archivePath, archive);
  const descriptor = {
    filename,
    platform,
    architecture,
    nodeMajor,
    nodeAbi,
    sha256: sha256(archive),
    size: archive.length,
  };
  writeFileSync(
    path.join(outputDirectory, `${filename}${metadataSuffix}`),
    `${JSON.stringify(descriptor, null, 2)}\n`,
  );
  return descriptor;
}

export function createReleaseManifest({ outputDirectory, version, sourceRevision }) {
  const artifacts = readdirSync(outputDirectory)
    .filter((entry) => entry.endsWith(metadataSuffix))
    .map((entry) => JSON.parse(readFileSync(path.join(outputDirectory, entry), 'utf8')))
    .sort(compareArtifacts);
  validateReleaseDescriptors(artifacts, outputDirectory, version);
  if (!/^[0-9a-f]{40}$/i.test(sourceRevision)) {
    throw new Error('Release manifest source revision must be a full Git commit hash');
  }
  const manifest = {
    schemaVersion: 1,
    version,
    sourceRevision,
    artifacts,
  };
  const manifestPath = path.join(outputDirectory, RELEASE_MANIFEST_FILENAME);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    path.join(outputDirectory, RELEASE_CHECKSUMS_FILENAME),
    `${artifacts.map((artifact) => `${artifact.sha256}  ${artifact.filename}`).join('\n')}\n`,
  );
  return manifestPath;
}

export function validateReleaseTag(tag, packageVersion) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(packageVersion)) {
    throw new Error(
      `Package version must be an exact stable X.Y.Z version; received ${packageVersion}`,
    );
  }
  const expected = `v${packageVersion}`;
  if (tag !== expected) throw new Error(`Release tag must be ${expected}; received ${tag}`);
  return packageVersion;
}

export function readReleaseArchive(archivePath) {
  const tar = gunzipSync(readFileSync(archivePath));
  const entries = new Map();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const archivePathName = prefix ? `${prefix}/${name}` : name;
    const size = readTarOctal(header, 124, 12);
    const mode = readTarOctal(header, 100, 8);
    const type = String.fromCharCode(header[156] || 48);
    const linkname = readTarString(header, 157, 100);
    offset += 512;
    const contents = Buffer.from(tar.subarray(offset, offset + size));
    entries.set(archivePathName, { path: archivePathName, type, mode, linkname, contents });
    offset += Math.ceil(size / 512) * 512;
  }
  return entries;
}

export function extractReleaseArchive(archivePath, destination) {
  const entries = readReleaseArchive(archivePath);
  mkdirSync(destination, { recursive: true });
  for (const entry of entries.values()) {
    assertSafeArchivePath(entry.path);
    const target = path.join(destination, entry.path);
    if (entry.type === '5') {
      mkdirSync(target, { recursive: true, mode: entry.mode });
      continue;
    }
    mkdirSync(path.dirname(target), { recursive: true });
    if (entry.type === '2') {
      const resolvedLink = path.posix.normalize(
        path.posix.join(path.posix.dirname(entry.path), entry.linkname),
      );
      if (
        path.posix.isAbsolute(entry.linkname) ||
        resolvedLink === '..' ||
        resolvedLink.startsWith('../')
      ) {
        throw new Error(`Release archive contains unsafe symlink: ${entry.path}`);
      }
      symlinkSync(entry.linkname, target);
      continue;
    }
    writeFileSync(target, entry.contents, { mode: entry.mode });
    chmodSync(target, entry.mode);
  }
  return entries;
}

export function createDeterministicTarGzip(root) {
  const chunks = [];
  for (const entry of collectEntries(root)) {
    const absolutePath = path.join(root, entry.path);
    const stat = lstatSync(absolutePath);
    const type = stat.isDirectory() ? '5' : stat.isSymbolicLink() ? '2' : '0';
    const contents = type === '0' ? readFileSync(absolutePath) : Buffer.alloc(0);
    const mode = type === '5' ? 0o755 : type === '2' ? 0o777 : stat.mode & 0o111 ? 0o755 : 0o644;
    chunks.push(
      createTarHeader({
        path: entry.path,
        type,
        mode,
        size: contents.length,
        linkname: type === '2' ? readlinkSync(absolutePath) : '',
      }),
    );
    if (contents.length > 0) {
      chunks.push(contents);
      const padding = (512 - (contents.length % 512)) % 512;
      if (padding) chunks.push(Buffer.alloc(padding));
    }
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 });
}

export function buildRuntimeArtifact({ outputDirectory, platform, architecture }) {
  assertDeclaredTuple(platform, architecture);
  assertBuildRuntime(platform, architecture);
  const packageManifest = JSON.parse(
    readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'),
  );
  const packageResult = inspectNpmPackage(repositoryRoot);
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'spool-release-build-'));
  const runtimeRoot = path.join(temporaryRoot, 'runtime');
  mkdirSync(runtimeRoot);
  try {
    copyRuntimePackageFiles(packageResult, runtimeRoot);
    copyFileSync(path.join(repositoryRoot, 'package.json'), path.join(runtimeRoot, 'package.json'));
    copyFileSync(
      path.join(repositoryRoot, 'package-lock.json'),
      path.join(runtimeRoot, 'package-lock.json'),
    );
    installProductionDependencies(runtimeRoot);
    writeRuntimePackage(runtimeRoot, packageManifest);
    rmSync(path.join(runtimeRoot, 'package-lock.json'));
    rmSync(path.join(runtimeRoot, 'node_modules', '.package-lock.json'), { force: true });
    writeLaunchers(runtimeRoot);
    const nativeModule = findNativeModule(runtimeRoot);
    writeFileSync(
      path.join(runtimeRoot, 'release-runtime.json'),
      `${JSON.stringify(
        {
          platform,
          architecture,
          nodeMajor: RELEASE_NODE_MAJOR,
          nodeAbi: RELEASE_NODE_ABI,
          nativeModule,
        },
        null,
        2,
      )}\n`,
    );
    smokeNativeModule(runtimeRoot);
    return createReleaseArchive({
      runtimeRoot,
      outputDirectory,
      version: packageManifest.version,
      platform,
      architecture,
    });
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function collectEntries(root, relative = '') {
  const entries = [];
  for (const name of readdirSync(path.join(root, relative)).sort()) {
    const entryPath = relative ? `${relative}/${name}` : name;
    const stat = lstatSync(path.join(root, entryPath));
    entries.push({ path: entryPath });
    if (stat.isDirectory()) entries.push(...collectEntries(root, entryPath));
  }
  return entries;
}

function createTarHeader({ path: entryPath, type, mode, size, linkname }) {
  const header = Buffer.alloc(512);
  const { name, prefix } = splitTarPath(entryPath);
  writeTarString(header, name, 0, 100);
  writeTarOctal(header, mode, 100, 8);
  writeTarOctal(header, 0, 108, 8);
  writeTarOctal(header, 0, 116, 8);
  writeTarOctal(header, size, 124, 12);
  writeTarOctal(header, 0, 136, 12);
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  writeTarString(header, linkname, 157, 100);
  writeTarString(header, 'ustar', 257, 6);
  writeTarString(header, '00', 263, 2);
  writeTarString(header, 'root', 265, 32);
  writeTarString(header, 'root', 297, 32);
  writeTarString(header, prefix, 345, 155);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const checksumText = checksum.toString(8).padStart(6, '0');
  header.write(checksumText, 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function splitTarPath(entryPath) {
  if (Buffer.byteLength(entryPath) <= 100) return { name: entryPath, prefix: '' };
  for (
    let index = entryPath.lastIndexOf('/');
    index > 0;
    index = entryPath.lastIndexOf('/', index - 1)
  ) {
    const prefix = entryPath.slice(0, index);
    const name = entryPath.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new Error(`Release path is too long for deterministic tar output: ${entryPath}`);
}

function writeTarString(buffer, value, offset, length) {
  if (Buffer.byteLength(value) > length) throw new Error(`Tar field is too long: ${value}`);
  buffer.write(value, offset, length, 'utf8');
}

function writeTarOctal(buffer, value, offset, length) {
  const encoded = value.toString(8).padStart(length - 1, '0');
  if (encoded.length >= length) throw new Error(`Tar numeric field is too large: ${value}`);
  buffer.write(encoded, offset, length - 1, 'ascii');
  buffer[offset + length - 1] = 0;
}

function readTarString(buffer, offset, length) {
  return buffer
    .subarray(offset, offset + length)
    .toString('utf8')
    .replace(/\0.*$/, '');
}

function readTarOctal(buffer, offset, length) {
  const value = readTarString(buffer, offset, length).trim();
  return value ? Number.parseInt(value, 8) : 0;
}

function assertSafeArchivePath(entryPath) {
  if (
    path.isAbsolute(entryPath) ||
    entryPath.split('/').some((part) => part === '..' || part === '')
  ) {
    throw new Error(`Release archive contains unsafe path: ${entryPath}`);
  }
}

function compareArtifacts(left, right) {
  const tupleIndex = (artifact) =>
    DECLARED_RELEASE_TUPLES.findIndex(
      (tuple) =>
        tuple.platform === artifact.platform && tuple.architecture === artifact.architecture,
    );
  const leftIndex = tupleIndex(left);
  const rightIndex = tupleIndex(right);
  if (leftIndex !== rightIndex)
    return leftIndex === -1 ? 1 : rightIndex === -1 ? -1 : leftIndex - rightIndex;
  return left.filename.localeCompare(right.filename);
}

function validateReleaseDescriptors(artifacts, outputDirectory, version) {
  const seen = new Set();
  for (const artifact of artifacts) {
    const tupleKey = `${artifact.platform}-${artifact.architecture}`;
    if (seen.has(tupleKey)) throw new Error(`Duplicate release tuple: ${tupleKey}`);
    seen.add(tupleKey);
    if (
      !DECLARED_RELEASE_TUPLES.some(
        (tuple) =>
          tuple.platform === artifact.platform && tuple.architecture === artifact.architecture,
      )
    ) {
      throw new Error(`Release metadata contains undeclared tuple: ${tupleKey}`);
    }
    if (artifact.nodeMajor !== RELEASE_NODE_MAJOR || artifact.nodeAbi !== RELEASE_NODE_ABI) {
      throw new Error(
        `Release metadata must declare Node ${RELEASE_NODE_MAJOR} ABI ${RELEASE_NODE_ABI}: ${artifact.filename}`,
      );
    }
    const expectedFilename = artifactFilename({ version, ...artifact });
    if (artifact.filename !== expectedFilename) {
      throw new Error(`Release metadata filename mismatch: expected ${expectedFilename}`);
    }
    const archive = readFileSync(path.join(outputDirectory, artifact.filename));
    if (archive.length !== artifact.size || sha256(archive) !== artifact.sha256) {
      throw new Error(`Release metadata digest or size mismatch: ${artifact.filename}`);
    }
  }
  for (const tuple of DECLARED_RELEASE_TUPLES) {
    const tupleKey = `${tuple.platform}-${tuple.architecture}`;
    if (!seen.has(tupleKey))
      throw new Error(`Release manifest is missing declared tuple: ${tupleKey}`);
  }
}

export function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function assertDeclaredTuple(platform, architecture) {
  if (
    !DECLARED_RELEASE_TUPLES.some(
      (tuple) => tuple.platform === platform && tuple.architecture === architecture,
    )
  ) {
    throw new Error(`Cannot build undeclared release tuple: ${platform}-${architecture}`);
  }
}

function assertBuildRuntime(platform, architecture) {
  if (process.platform !== platform || process.arch !== architecture) {
    throw new Error(
      `Release artifacts must be built on their declared host; requested ${platform}-${architecture}, running ${process.platform}-${process.arch}`,
    );
  }
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const nodeAbi = Number(process.versions.modules);
  if (nodeMajor !== RELEASE_NODE_MAJOR || nodeAbi !== RELEASE_NODE_ABI) {
    throw new Error(
      `Release artifacts require Node ${RELEASE_NODE_MAJOR} ABI ${RELEASE_NODE_ABI}; running Node ${process.versions.node} ABI ${process.versions.modules}`,
    );
  }
}

function copyRuntimePackageFiles(packageResult, runtimeRoot) {
  for (const { path: relativePath } of packageResult.files) {
    if (
      relativePath === 'package.json' ||
      relativePath === 'scripts/smoke-providers.mjs' ||
      (!relativePath.startsWith('dist/') &&
        !relativePath.startsWith('examples/') &&
        relativePath !== 'LICENSE.md' &&
        relativePath !== 'README.md')
    ) {
      continue;
    }
    const source = path.join(repositoryRoot, relativePath);
    const destination = path.join(runtimeRoot, relativePath);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    if (lstatSync(source).mode & 0o111) chmodSync(destination, 0o755);
  }
}

function installProductionDependencies(runtimeRoot) {
  const npmCli = path.resolve(
    path.dirname(process.execPath),
    '../lib/node_modules/npm/bin/npm-cli.js',
  );
  if (!existsSync(npmCli))
    throw new Error(`Could not locate npm CLI beside release Node runtime: ${npmCli}`);
  const result = spawnSync(
    process.execPath,
    [npmCli, 'ci', '--omit=dev', '--no-audit', '--no-fund'],
    {
      cwd: runtimeRoot,
      encoding: 'utf8',
      env: { ...process.env, npm_config_update_notifier: 'false' },
    },
  );
  if (result.status !== 0) {
    throw new Error(`Production dependency install failed:\n${result.stderr || result.stdout}`);
  }
}

function writeRuntimePackage(runtimeRoot, manifest) {
  const runtimeManifest = {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    license: manifest.license,
    type: manifest.type,
    bin: manifest.bin,
    engines: { node: '^24.0.0' },
    dependencies: manifest.dependencies,
  };
  writeFileSync(
    path.join(runtimeRoot, 'package.json'),
    `${JSON.stringify(runtimeManifest, null, 2)}\n`,
  );
}

function writeLaunchers(runtimeRoot) {
  const launcher = `#!/bin/sh\nset -eu\nSCRIPT=$0\nwhile [ -L "$SCRIPT" ]; do\n  DIRECTORY=$(CDPATH= cd -P -- "$(dirname -- "$SCRIPT")" && pwd)\n  SCRIPT=$(readlink "$SCRIPT")\n  case $SCRIPT in /*) ;; *) SCRIPT=$DIRECTORY/$SCRIPT ;; esac\ndone\nROOT=$(CDPATH= cd -P -- "$(dirname -- "$SCRIPT")/.." && pwd)\nexec node "$ROOT/dist/cli/index.js" "$@"\n`;
  mkdirSync(path.join(runtimeRoot, 'bin'));
  for (const alias of ['spool']) {
    const target = path.join(runtimeRoot, 'bin', alias);
    writeFileSync(target, launcher, { mode: 0o755 });
    chmodSync(target, 0o755);
  }
}

function findNativeModule(runtimeRoot) {
  const expected = 'node_modules/better-sqlite3/build/Release/better_sqlite3.node';
  if (!existsSync(path.join(runtimeRoot, expected))) {
    throw new Error(`Production install is missing native module: ${expected}`);
  }
  return expected;
}

function smokeNativeModule(runtimeRoot) {
  const script =
    "const{createRequire}=require('node:module');const path=require('node:path');const r=createRequire(path.join(process.cwd(),'package.json'));const D=r('better-sqlite3');const db=new D(':memory:');db.close();";
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: runtimeRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`Native module smoke check failed:\n${result.stderr}`);
}

function parseArguments(argv) {
  const [command = 'artifact', ...tokens] = argv;
  const options = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const key = tokens[index];
    const value = tokens[index + 1];
    if (!key?.startsWith('--') || value === undefined)
      throw new Error(`Invalid argument: ${key ?? ''}`);
    options[key.slice(2)] = value;
  }
  return { command, options };
}

function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  const outputDirectory = path.resolve(options.output ?? path.join(repositoryRoot, 'release'));
  if (command === 'artifact') {
    const descriptor = buildRuntimeArtifact({
      outputDirectory,
      platform: options.platform ?? process.platform,
      architecture: options.architecture ?? process.arch,
    });
    process.stdout.write(`${JSON.stringify(descriptor)}\n`);
    return;
  }
  if (command === 'manifest') {
    const manifest = JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
    const sourceRevision =
      options['source-revision'] ??
      spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
      }).stdout.trim();
    process.stdout.write(
      `${createReleaseManifest({ outputDirectory, version: manifest.version, sourceRevision })}\n`,
    );
    return;
  }
  if (command === 'validate-tag') {
    const manifest = JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
    process.stdout.write(`${validateReleaseTag(options.tag ?? '', manifest.version)}\n`);
    return;
  }
  throw new Error(`Unknown release build command: ${command}`);
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
