import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  accessSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { defaultConfigPath, resolveConfiguredPath } from '../config/paths.js';

export const MANAGED_INSTALL_FILENAME = 'managed-install.json';
export const MANAGED_NODE_ABI = 137;

export type ManagedInstallStatus = 'installed' | 'updated' | 'current' | 'attention';

export interface ManagedInstallOwnership {
  schemaVersion: 1;
  version: string;
  channel: 'stable';
  releaseSource: string;
  artifactDigest: string;
  nodeAbi: number;
  activePrefix: string;
}

export interface ManagedInstallRequest {
  candidateDirectory: string;
  prefix: string;
  version: string;
  channel: 'stable';
  releaseSource: string;
  artifactDigest: string;
  nodeAbi: number;
  configPath?: string;
}

export interface ManagedUninstallRequest {
  prefix: string;
  configPath?: string;
}

export interface ManagedInstallResult {
  status: ManagedInstallStatus;
  exitCode: 0 | 1;
  version: string;
  message: string;
}

export interface ManagedUninstallResult {
  status: 'uninstalled';
  exitCode: 0;
  version: string;
  message: string;
}

export interface ManagedInstallDependencies {
  withDaemonLock?: <T>(
    configPath: string | undefined,
    operation: () => T | Promise<T>,
  ) => Promise<T>;
  smokeCandidate?: (
    candidateDirectory: string,
    temporaryHome: string,
    expectedVersion: string,
  ) => void | Promise<void>;
  verifyActivated?: (prefix: string, version: string) => void | Promise<void>;
  pathValue?: string;
  rename?: typeof renameSync;
  remove?: typeof rmSync;
  runtimeIdentity?: ManagedRuntimeIdentity;
}

export interface ManagedRuntimeIdentity {
  platform: NodeJS.Platform;
  architecture: string;
  nodeMajor: number;
  nodeAbi: number;
}

export class ManagedInstallError extends Error {
  readonly code: string;
  readonly exitCode: 1 | 2;

  constructor(code: string, message: string, exitCode: 1 | 2 = 1) {
    super(message);
    this.name = 'ManagedInstallError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

export class DaemonActiveInstallError extends ManagedInstallError {
  readonly pid: number;

  constructor(pid: number) {
    super(
      'daemon-active',
      `spool daemon pid ${String(pid)} is active. Stop it and retry: kill ${String(pid)}`,
    );
    this.name = 'DaemonActiveInstallError';
    this.pid = pid;
  }
}

export async function installManagedRelease(
  request: ManagedInstallRequest,
  dependencies: ManagedInstallDependencies = {},
): Promise<ManagedInstallResult> {
  const normalized = validateInstallRequest(
    request,
    dependencies.runtimeIdentity ?? currentRuntimeIdentity(),
  );
  const layout = managedLayout(normalized.prefix);
  const ownership = readOwnership(layout.ownershipPath);
  preflightAliasTargets(layout, ownership);

  if (ownership) {
    const comparison = compareStableReleaseVersions(normalized.version, ownership.version);
    if (comparison < 0) {
      throw new ManagedInstallError(
        'downgrade',
        `Refusing to downgrade managed spool from ${ownership.version} to ${normalized.version}`,
      );
    }
    if (comparison === 0) {
      assertIntactManagedInstall(layout, ownership);
      return pathResult(normalized.prefix, normalized.version, 'current', dependencies.pathValue);
    }
  } else if (pathExists(layout.managedRoot) || pathExists(layout.currentPath)) {
    throw new ManagedInstallError(
      'unowned-install-root',
      `Refusing to replace unowned files under ${layout.managedRoot}`,
      2,
    );
  }

  const smokeCandidate = dependencies.smokeCandidate ?? defaultSmokeCandidate;
  await withTemporaryHome(async (temporaryHome) => {
    await smokeCandidate(normalized.candidateDirectory, temporaryHome, normalized.version);
  });

  const withDaemonLock = dependencies.withDaemonLock ?? withConfiguredDaemonLock;
  return withDaemonLock(normalized.configPath, async () => {
    await activateCandidate(normalized, ownership, dependencies);
    return pathResult(
      normalized.prefix,
      normalized.version,
      ownership ? 'updated' : 'installed',
      dependencies.pathValue,
    );
  });
}

export async function uninstallManagedRelease(
  request: ManagedUninstallRequest,
  dependencies: ManagedInstallDependencies = {},
): Promise<ManagedUninstallResult> {
  const prefix = canonicalPrefix(request.prefix);
  const layout = managedLayout(prefix);
  const ownership = readOwnership(layout.ownershipPath);
  if (!ownership || canonicalPrefix(ownership.activePrefix) !== prefix) {
    throw new ManagedInstallError(
      'unmanaged',
      `No installer-owned spool installation exists under ${prefix}`,
    );
  }
  preflightAliasTargets(layout, ownership);
  assertIntactManagedInstall(layout, ownership);
  const withDaemonLock = dependencies.withDaemonLock ?? withConfiguredDaemonLock;
  return withDaemonLock(request.configPath, () => {
    for (const aliasPath of Object.values(layout.aliases)) unlinkSync(aliasPath);
    rmSync(layout.managedRoot, { recursive: true, force: true });
    removeDirectoryIfEmpty(layout.libraryDirectory);
    removeDirectoryIfEmpty(layout.binaryDirectory);
    return {
      status: 'uninstalled',
      exitCode: 0,
      version: ownership.version,
      message: `Uninstalled managed spool ${ownership.version}; configuration and state were preserved.`,
    };
  });
}

export function readManagedInstallOwnership(prefix: string): ManagedInstallOwnership | null {
  const normalizedPrefix = canonicalPrefix(prefix);
  const ownership = readOwnership(managedLayout(normalizedPrefix).ownershipPath);
  return ownership && canonicalPrefix(ownership.activePrefix) === normalizedPrefix
    ? { ...ownership, activePrefix: normalizedPrefix }
    : null;
}

export function discoverManagedPrefix(startPath = process.argv[1]): string | null {
  if (!startPath) return null;
  let directory: string;
  try {
    directory = path.dirname(realpathSync(startPath));
  } catch {
    return null;
  }
  for (let depth = 0; depth < 8; depth += 1) {
    const ownershipPath = path.join(directory, MANAGED_INSTALL_FILENAME);
    if (pathExists(ownershipPath)) {
      const prefix = canonicalPrefix(path.resolve(directory, '../..'));
      return readManagedInstallOwnership(prefix) ? prefix : null;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

async function activateCandidate(
  request: ManagedInstallRequest,
  previousOwnership: ManagedInstallOwnership | null,
  dependencies: ManagedInstallDependencies,
): Promise<void> {
  const layout = managedLayout(request.prefix);
  const rename = dependencies.rename ?? renameSync;
  const remove = dependencies.remove ?? rmSync;
  const nonce = randomUUID();
  const stagingPath = path.join(layout.versionsDirectory, `.staging-${request.version}-${nonce}`);
  const versionPath = path.join(layout.versionsDirectory, request.version);
  const currentTemporary = path.join(layout.managedRoot, `.current-${nonce}`);
  const ownershipTemporary = path.join(layout.managedRoot, `.ownership-${nonce}`);
  const aliasTemporaries = Object.fromEntries(
    Object.entries(layout.aliases).map(([alias, aliasPath]) => [
      alias,
      path.join(path.dirname(aliasPath), `.${alias}-${nonce}`),
    ]),
  ) as Record<'spool', string>;
  const previousCurrent = pathExists(layout.currentPath) ? readlinkSync(layout.currentPath) : null;
  const previousOwnershipContents = previousOwnership ? readFileSync(layout.ownershipPath) : null;
  const existingAliases = new Set(
    Object.entries(layout.aliases)
      .filter(([, aliasPath]) => pathExists(aliasPath))
      .map(([alias]) => alias),
  );
  let publishedVersion = false;
  let switchedCurrent = false;
  const publishedAliases = new Set<string>();
  let publishedOwnership = false;

  if (pathExists(versionPath)) {
    throw new ManagedInstallError(
      'version-exists',
      `Managed version directory already exists unexpectedly: ${versionPath}`,
    );
  }

  try {
    mkdirSync(layout.versionsDirectory, { recursive: true, mode: 0o755 });
    mkdirSync(layout.binaryDirectory, { recursive: true, mode: 0o755 });
    cpSync(request.candidateDirectory, stagingPath, {
      recursive: true,
      preserveTimestamps: false,
      errorOnExist: true,
    });
    rename(stagingPath, versionPath);
    publishedVersion = true;

    symlinkSync(`versions/${request.version}`, currentTemporary);
    for (const [alias, temporary] of Object.entries(aliasTemporaries)) {
      if (existingAliases.has(alias)) continue;
      symlinkSync(expectedAliasTarget(alias as 'spool'), temporary);
    }
    writeFileSync(ownershipTemporary, `${JSON.stringify(ownershipFor(request), null, 2)}\n`, {
      mode: 0o600,
    });

    rename(currentTemporary, layout.currentPath);
    switchedCurrent = true;
    for (const [alias, temporary] of Object.entries(aliasTemporaries)) {
      if (existingAliases.has(alias)) continue;
      rename(temporary, layout.aliases[alias as 'spool']);
      publishedAliases.add(alias);
    }
    rename(ownershipTemporary, layout.ownershipPath);
    publishedOwnership = true;
    await (dependencies.verifyActivated ?? defaultVerifyActivated)(request.prefix, request.version);
  } catch (error) {
    const cleanupFailures: string[] = [];
    const restorationFailures: string[] = [];
    const attempt = (label: string, operation: () => void, failures = cleanupFailures) => {
      try {
        operation();
      } catch (cleanupError) {
        failures.push(`${label}: ${messageOf(cleanupError)}`);
      }
    };
    if (publishedOwnership) {
      if (previousOwnershipContents) {
        attempt(
          'restore ownership metadata',
          () => writeFileSync(layout.ownershipPath, previousOwnershipContents, { mode: 0o600 }),
          restorationFailures,
        );
      } else {
        attempt('remove ownership metadata', () => remove(layout.ownershipPath, { force: true }));
      }
    }
    for (const alias of publishedAliases) {
      attempt(`remove ${alias} alias`, () =>
        remove(layout.aliases[alias as 'spool'], { force: true }),
      );
    }
    if (switchedCurrent) {
      attempt('remove failed current pointer', () => remove(layout.currentPath, { force: true }));
      if (previousCurrent) {
        attempt(
          'restore previous current pointer',
          () => restoreSymlink(previousCurrent, layout.currentPath, nonce, rename),
          restorationFailures,
        );
      }
    }
    if (publishedVersion) {
      attempt('remove failed version', () => remove(versionPath, { recursive: true, force: true }));
    }
    attempt('remove staging directory', () =>
      remove(stagingPath, { recursive: true, force: true }),
    );
    attempt('remove temporary current pointer', () => remove(currentTemporary, { force: true }));
    attempt('remove temporary ownership metadata', () =>
      remove(ownershipTemporary, { force: true }),
    );
    for (const temporary of Object.values(aliasTemporaries)) {
      attempt('remove temporary alias', () => remove(temporary, { force: true }));
    }
    attempt('remove temporary restored pointer', () =>
      remove(`${layout.currentPath}.restore-${nonce}`, { force: true }),
    );
    if (!previousOwnership) {
      attempt('remove empty versions directory', () =>
        removeDirectoryIfEmpty(layout.versionsDirectory),
      );
      attempt('remove empty managed root', () => removeDirectoryIfEmpty(layout.managedRoot));
      attempt('remove empty library directory', () =>
        removeDirectoryIfEmpty(layout.libraryDirectory),
      );
      attempt('remove empty binary directory', () =>
        removeDirectoryIfEmpty(layout.binaryDirectory),
      );
    }
    const detail = messageOf(error);
    if (previousOwnership && restorationFailures.length > 0) {
      throw new ManagedInstallError(
        'rollback-failed',
        `Update activation failed: ${detail}. Rollback failed and the managed installation may be inconsistent: ${restorationFailures.join('; ')}`,
      );
    }
    const cleanupDetail =
      cleanupFailures.length > 0 ? ` Cleanup was incomplete: ${cleanupFailures.join('; ')}` : '';
    throw new ManagedInstallError(
      previousOwnership
        ? 'rolled-back'
        : cleanupFailures.length > 0
          ? 'cleanup-failed'
          : 'failed-clean',
      `${previousOwnership ? `Update failed and spool ${previousOwnership.version} was restored` : 'Installation failed with no active managed version'}: ${detail}.${cleanupDetail}`,
    );
  }
}

function validateInstallRequest(
  request: ManagedInstallRequest,
  runtimeIdentity: ManagedRuntimeIdentity,
): ManagedInstallRequest {
  const candidateDirectory = path.resolve(request.candidateDirectory);
  const prefix = canonicalPrefix(request.prefix);
  if (!/^\d+\.\d+\.\d+$/.test(request.version)) {
    throw new ManagedInstallError(
      'invalid-version',
      `Expected an exact stable version: ${request.version}`,
    );
  }
  if (request.channel !== 'stable') {
    throw new ManagedInstallError(
      'unsupported-channel',
      'Only the stable release channel is supported',
    );
  }
  if (!/^[0-9a-f]{64}$/i.test(request.artifactDigest)) {
    throw new ManagedInstallError('invalid-digest', 'Artifact digest must be a SHA-256 value');
  }
  if (request.nodeAbi !== MANAGED_NODE_ABI) {
    throw new ManagedInstallError(
      'unsupported-node-abi',
      `Managed releases require Node ABI ${String(MANAGED_NODE_ABI)}`,
    );
  }
  const supportedTuple = ['darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64'].includes(
    `${runtimeIdentity.platform}-${runtimeIdentity.architecture}`,
  );
  if (
    !supportedTuple ||
    runtimeIdentity.nodeMajor !== 24 ||
    runtimeIdentity.nodeAbi !== MANAGED_NODE_ABI ||
    runtimeIdentity.nodeAbi !== request.nodeAbi
  ) {
    throw new ManagedInstallError(
      'unsupported-runtime',
      `Managed releases require macOS or Linux on x64/arm64 with Node 24 ABI ${String(MANAGED_NODE_ABI)}`,
    );
  }
  let packageManifest: Record<string, unknown>;
  let runtime: Record<string, unknown>;
  try {
    const packageValue: unknown = JSON.parse(
      readFileSync(path.join(candidateDirectory, 'package.json'), 'utf8'),
    );
    const runtimeValue: unknown = JSON.parse(
      readFileSync(path.join(candidateDirectory, 'release-runtime.json'), 'utf8'),
    );
    if (!isRecord(packageValue) || !isRecord(runtimeValue))
      throw new Error('expected JSON objects');
    packageManifest = packageValue;
    runtime = runtimeValue;
  } catch (error) {
    throw new ManagedInstallError(
      'invalid-candidate',
      `Candidate release metadata is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (packageManifest.name !== 'spool' || packageManifest.version !== request.version) {
    throw new ManagedInstallError(
      'invalid-candidate',
      `Candidate package version does not match requested spool ${request.version}`,
    );
  }
  if (runtime.nodeAbi !== request.nodeAbi) {
    throw new ManagedInstallError('invalid-candidate', 'Candidate Node ABI does not match request');
  }
  if (
    runtime.platform !== runtimeIdentity.platform ||
    runtime.architecture !== runtimeIdentity.architecture ||
    runtime.nodeMajor !== runtimeIdentity.nodeMajor
  ) {
    throw new ManagedInstallError(
      'invalid-candidate',
      'Candidate platform, architecture, or Node major does not match the running environment',
    );
  }
  for (const relativePath of ['bin/spool', 'dist/cli/index.js']) {
    const candidatePath = path.join(candidateDirectory, relativePath);
    try {
      accessSync(candidatePath, constants.R_OK | constants.X_OK);
    } catch {
      throw new ManagedInstallError(
        'invalid-candidate',
        `Candidate is missing executable runtime file: ${relativePath}`,
      );
    }
  }
  return { ...request, candidateDirectory, prefix };
}

function managedLayout(prefix: string) {
  const binaryDirectory = path.join(prefix, 'bin');
  const libraryDirectory = path.join(prefix, 'lib');
  const managedRoot = path.join(libraryDirectory, 'spool');
  return {
    binaryDirectory,
    libraryDirectory,
    managedRoot,
    versionsDirectory: path.join(managedRoot, 'versions'),
    currentPath: path.join(managedRoot, 'current'),
    ownershipPath: path.join(managedRoot, MANAGED_INSTALL_FILENAME),
    aliases: {
      spool: path.join(binaryDirectory, 'spool'),
    },
  };
}

function ownershipFor(request: ManagedInstallRequest): ManagedInstallOwnership {
  return {
    schemaVersion: 1,
    version: request.version,
    channel: request.channel,
    releaseSource: request.releaseSource,
    artifactDigest: request.artifactDigest.toLowerCase(),
    nodeAbi: request.nodeAbi,
    activePrefix: request.prefix,
  };
}

function readOwnership(ownershipPath: string): ManagedInstallOwnership | null {
  if (!pathExists(ownershipPath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(ownershipPath, 'utf8'));
  } catch (error) {
    throw new ManagedInstallError(
      'invalid-ownership',
      `Managed ownership metadata is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isOwnership(parsed)) {
    throw new ManagedInstallError('invalid-ownership', 'Managed ownership metadata is invalid');
  }
  return parsed;
}

function isOwnership(value: unknown): value is ManagedInstallOwnership {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<ManagedInstallOwnership>;
  return (
    item.schemaVersion === 1 &&
    typeof item.version === 'string' &&
    item.channel === 'stable' &&
    typeof item.releaseSource === 'string' &&
    typeof item.artifactDigest === 'string' &&
    typeof item.nodeAbi === 'number' &&
    typeof item.activePrefix === 'string'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function preflightAliasTargets(
  layout: ReturnType<typeof managedLayout>,
  ownership: ManagedInstallOwnership | null,
): void {
  for (const [alias, aliasPath] of Object.entries(layout.aliases)) {
    let aliasStats;
    try {
      aliasStats = lstatSync(aliasPath);
    } catch {
      continue;
    }
    const expected = expectedAliasTarget(alias as 'spool');
    const owned =
      ownership &&
      canonicalPrefix(ownership.activePrefix) ===
        canonicalPrefix(path.join(layout.binaryDirectory, '..')) &&
      aliasStats.isSymbolicLink() &&
      readlinkSync(aliasPath) === expected;
    if (!owned) {
      throw new ManagedInstallError(
        'occupied-alias',
        `Refusing to overwrite unrelated ${aliasPath}. Move it aside and retry.`,
        2,
      );
    }
  }
}

function assertIntactManagedInstall(
  layout: ReturnType<typeof managedLayout>,
  ownership: ManagedInstallOwnership,
): void {
  try {
    if (
      !lstatSync(layout.currentPath).isSymbolicLink() ||
      readlinkSync(layout.currentPath) !== `versions/${ownership.version}`
    ) {
      throw new Error('invalid pointer');
    }
  } catch {
    throw new ManagedInstallError(
      'damaged-install',
      'Managed current pointer is missing or invalid',
    );
  }
  const versionPath = path.join(layout.versionsDirectory, ownership.version);
  try {
    if (!lstatSync(versionPath).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new ManagedInstallError(
      'damaged-install',
      `Managed active version directory is missing or invalid: ${ownership.version}`,
    );
  }
  for (const relativePath of ['bin/spool', 'dist/cli/index.js']) {
    try {
      accessSync(path.join(versionPath, relativePath), constants.R_OK | constants.X_OK);
    } catch {
      throw new ManagedInstallError(
        'damaged-install',
        `Managed active version executable is missing or not executable: ${relativePath}`,
      );
    }
  }
  for (const [alias, aliasPath] of Object.entries(layout.aliases)) {
    if (
      !pathExists(aliasPath) ||
      !lstatSync(aliasPath).isSymbolicLink() ||
      readlinkSync(aliasPath) !== expectedAliasTarget(alias as 'spool')
    ) {
      throw new ManagedInstallError(
        'damaged-install',
        `Managed alias is missing or invalid: ${alias}`,
      );
    }
  }
}

function expectedAliasTarget(alias: 'spool'): string {
  return `../lib/spool/current/bin/${alias}`;
}

function pathResult(
  prefix: string,
  version: string,
  successStatus: Exclude<ManagedInstallStatus, 'attention'>,
  pathValue = process.env.PATH,
): ManagedInstallResult {
  if (pathValue === '') {
    return {
      status: successStatus,
      exitCode: 0,
      version,
      message: `Managed spool ${version} is ${successStatus === 'current' ? 'already current' : 'active'}.`,
    };
  }
  const expectedDirectory = path.join(prefix, 'bin');
  for (const alias of ['spool'] as const) {
    const resolved = findExecutable(alias, pathValue);
    const expected = path.join(expectedDirectory, alias);
    if (resolved !== expected) {
      const detail = resolved ? `${resolved} appears earlier on PATH.` : `${alias} is not on PATH.`;
      return {
        status: 'attention',
        exitCode: 1,
        version,
        message: `${detail} Put the managed executable first: export PATH="${expectedDirectory}:$PATH"`,
      };
    }
  }
  return {
    status: successStatus,
    exitCode: 0,
    version,
    message: `Managed spool ${version} is ${successStatus === 'current' ? 'already current' : 'active'}.`,
  };
}

function findExecutable(name: string, pathValue: string | undefined): string | null {
  for (const directory of (pathValue ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.resolve(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return path.join(realpathSync(path.dirname(candidate)), path.basename(candidate));
    } catch {
      // Continue through PATH.
    }
  }
  return null;
}

function defaultSmokeCandidate(
  candidateDirectory: string,
  temporaryHome: string,
  expectedVersion: string,
) {
  for (const alias of ['spool']) {
    const result = spawnSync(path.join(candidateDirectory, 'bin', alias), ['--version'], {
      cwd: temporaryHome,
      encoding: 'utf8',
      env: isolatedEnvironment(temporaryHome),
    });
    if (result.status !== 0 || result.stdout.trim() !== expectedVersion) {
      throw new ManagedInstallError(
        'smoke-failed',
        `Candidate ${alias} did not report spool ${expectedVersion}: ${result.stderr.trim()}`,
      );
    }
  }
}

async function defaultVerifyActivated(prefix: string, version: string) {
  await withTemporaryHome((temporaryHome) => {
    for (const alias of ['spool']) {
      const result = spawnSync(path.join(prefix, 'bin', alias), ['--version'], {
        cwd: temporaryHome,
        encoding: 'utf8',
        env: isolatedEnvironment(temporaryHome),
      });
      if (result.status !== 0 || result.stdout.trim() !== version) {
        throw new ManagedInstallError(
          'activation-failed',
          `Activated ${alias} did not report spool ${version}`,
        );
      }
    }
  });
}

async function withTemporaryHome<T>(
  operation: (temporaryHome: string) => T | Promise<T>,
): Promise<T> {
  const temporaryHome = mkdtempSync(path.join(os.tmpdir(), 'spool-install-smoke-'));
  try {
    return await operation(temporaryHome);
  } finally {
    rmSync(temporaryHome, { recursive: true, force: true });
  }
}

function isolatedEnvironment(temporaryHome: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: temporaryHome,
    XDG_CONFIG_HOME: path.join(temporaryHome, 'config'),
    XDG_STATE_HOME: path.join(temporaryHome, 'state'),
  };
}

async function withConfiguredDaemonLock<T>(
  requestedConfigPath: string | undefined,
  operation: () => T | Promise<T>,
): Promise<T> {
  const requestedPath = requestedConfigPath
    ? path.resolve(requestedConfigPath)
    : defaultConfigPath();
  if (!existsSync(requestedPath)) return operation();
  const configPath = realpathSync(requestedPath);
  const { default: YAML } = await import('yaml');
  const parsed = YAML.parse(readFileSync(configPath, 'utf8')) as { stateDirectory?: unknown };
  if (typeof parsed?.stateDirectory !== 'string' || !parsed.stateDirectory.trim()) {
    throw new ManagedInstallError(
      'invalid-config',
      `Cannot determine state directory from ${configPath}`,
    );
  }
  const stateDirectory = resolveConfiguredPath(parsed.stateDirectory, path.dirname(configPath));
  const databasePath = path.join(stateDirectory, 'spool.sqlite');
  if (!existsSync(databasePath)) return operation();

  const { default: Database } = await import('better-sqlite3');
  const { readProcessStartIdentity } = await import('../process-identity.js');
  const database = new Database(databasePath, { fileMustExist: true });
  try {
    database.pragma('busy_timeout = 2500');
    database.exec('BEGIN IMMEDIATE');
    const owner = database
      .prepare(
        'SELECT pid, process_start_identity, expires_at FROM daemon_owner WHERE singleton = 1',
      )
      .get() as { pid: number; process_start_identity: string; expires_at: number } | undefined;
    if (
      owner &&
      owner.expires_at > Date.now() &&
      readProcessStartIdentity(owner.pid) === owner.process_start_identity
    ) {
      throw new DaemonActiveInstallError(owner.pid);
    }
    return await operation();
  } finally {
    if (database.inTransaction) database.exec('ROLLBACK');
    database.close();
  }
}

function canonicalPrefix(value: string): string {
  const resolved = path.resolve(value);
  let existingAncestor = resolved;
  while (!pathExists(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) return resolved;
    existingAncestor = parent;
  }
  return path.resolve(realpathSync(existingAncestor), path.relative(existingAncestor, resolved));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function restoreSymlink(
  target: string,
  destination: string,
  nonce: string,
  rename: typeof renameSync,
) {
  const temporary = `${destination}.restore-${nonce}`;
  symlinkSync(target, temporary);
  rename(temporary, destination);
}

export function compareStableReleaseVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function currentRuntimeIdentity(): ManagedRuntimeIdentity {
  return {
    platform: process.platform,
    architecture: process.arch,
    nodeMajor: Number(process.versions.node.split('.')[0]),
    nodeAbi: Number(process.versions.modules),
  };
}

function pathExists(candidate: string): boolean {
  try {
    lstatSync(candidate);
    return true;
  } catch {
    return false;
  }
}

function removeDirectoryIfEmpty(directory: string): void {
  try {
    if (readdirSync(directory).length === 0) rmdirSync(directory);
  } catch {
    // Cleanup never broadens beyond known empty installer directories.
  }
}

function isMainEntrypoint(): boolean {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

function parseCommandArguments(argv: string[]): ManagedInstallRequest {
  const [command, ...tokens] = argv;
  if (command !== 'install') {
    throw new ManagedInstallError('usage', 'Usage: managed-install.js install [options]');
  }
  const values = new Map<string, string>();
  for (let index = 0; index < tokens.length; index += 2) {
    const option = tokens[index];
    const value = tokens[index + 1];
    if (!option?.startsWith('--') || value === undefined) {
      throw new ManagedInstallError('usage', `Invalid managed-install option: ${option ?? ''}`);
    }
    values.set(option.slice(2), value);
  }
  const required = (name: string) => {
    const value = values.get(name);
    if (!value) throw new ManagedInstallError('usage', `Missing --${name}`);
    return value;
  };
  const configPath = values.get('config');
  return {
    candidateDirectory: required('candidate'),
    prefix: required('prefix'),
    version: required('version'),
    channel: 'stable',
    releaseSource: required('release-source'),
    artifactDigest: required('artifact-digest'),
    nodeAbi: Number(required('node-abi')),
    ...(configPath ? { configPath } : {}),
  };
}

async function main() {
  try {
    const result = await installManagedRelease(parseCommandArguments(process.argv.slice(2)));
    process.stdout.write(`${result.message}\n`);
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error instanceof ManagedInstallError ? error.exitCode : 1;
  }
}

if (isMainEntrypoint()) await main();
