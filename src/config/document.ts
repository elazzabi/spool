import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import YAML from 'yaml';

import { loadConfig } from './load.js';
import { canonicalExistingDirectory, resolveConfigPath, samePath } from './paths.js';
import {
  type RawConfig,
  type RepositoryConfig,
  normalizeGitHubRepository,
  normalizeRepositoryAlias,
  rawConfigSchema,
} from './schema.js';
import { currentProcessStartIdentity, readProcessStartIdentity } from '../process-identity.js';
import type { BuiltinProviderName } from '../providers/preflight.js';

export class ConfigDocumentError extends Error {
  override readonly name = 'ConfigDocumentError';
}

export interface RawConfigDocument {
  path: string;
  source: string;
  raw: RawConfig;
}

export interface ConfigTargetAssessment {
  target: string;
  parent: string;
}

export interface RepositoryRemovalResult {
  clone: string;
  repository: string;
  poolRemoved: boolean;
}

export function assessConfigTarget(configPath?: string): ConfigTargetAssessment {
  const requested = resolveConfigPath(configPath);
  try {
    lstatSync(requested);
    throw new ConfigDocumentError(`Configuration already exists at ${requested}`);
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error;
  }

  const requestedParent = path.dirname(requested);
  let existingAncestor = requestedParent;
  while (!existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    existingAncestor = parent;
  }
  const canonicalAncestor = safeDirectory(existingAncestor);
  const canonicalParent = path.resolve(
    canonicalAncestor,
    path.relative(existingAncestor, requestedParent),
  );
  return {
    target: path.join(canonicalParent, path.basename(requested)),
    parent: canonicalParent,
  };
}

export function prepareConfigParent(configPath?: string): string {
  return path.dirname(safeTarget(configPath, true));
}

export function readRawConfigDocument(configPath?: string): RawConfigDocument {
  const target = existingSafeTarget(configPath);
  const source = readFileSync(target, 'utf8');
  return { path: target, source, raw: parseRawConfig(source, target) };
}

export function createConfigDocument(
  configPath: string | undefined,
  raw: RawConfig,
  dependencies: {
    chmod?: (target: string, mode: number) => void;
    syncParent?: (directory: string) => void;
  } = {},
): string {
  const target = safeTarget(configPath, true);
  const candidate = writeValidatedCandidate(target, raw);
  let linked = false;
  try {
    try {
      linkSync(candidate, target);
      linked = true;
    } catch (error) {
      if (isNodeError(error, 'EEXIST')) {
        throw new ConfigDocumentError(`Configuration already exists at ${target}`);
      }
      throw error;
    }
    (dependencies.chmod ?? chmodSync)(target, 0o600);
    (dependencies.syncParent ?? syncParent)(path.dirname(target));
    return target;
  } catch (error) {
    if (linked) removeOwnedPublishedLink(target, candidate);
    throw error;
  } finally {
    removeIfPresent(candidate);
  }
}

function removeOwnedPublishedLink(target: string, candidate: string): void {
  try {
    const targetStats = lstatSync(target);
    const candidateStats = lstatSync(candidate);
    if (targetStats.dev !== candidateStats.dev || targetStats.ino !== candidateStats.ino) return;
    unlinkSync(target);
    try {
      syncParent(path.dirname(target));
    } catch {
      // The target is gone; retain the original publication error if durability sync also fails.
    }
  } catch {
    // A concurrent replacement or removal is not owned by this publication attempt.
  }
}

export function mutateConfigDocument(
  configPath: string | undefined,
  mutate: (raw: RawConfig) => void,
): RawConfigDocument {
  const target = existingSafeTarget(configPath);
  const lockPath = `${target}.lock`;
  let lockDescriptor: number | undefined;
  let ownsLock = false;
  let candidate: string | undefined;
  try {
    lockDescriptor = acquireConfigLock(lockPath);
    ownsLock = true;

    const identity = sourceIdentity(target);
    const raw = parseRawConfig(identity.source, target);
    const originalRaw = structuredClone(raw);
    mutate(raw);
    if (isDeepStrictEqual(raw, originalRaw)) {
      assertSourceUnchanged(target, identity);
      return { path: target, source: identity.source, raw };
    }
    candidate = writeValidatedCandidate(target, raw);
    writeBackup(target, identity.source);
    assertSourceUnchanged(target, identity);
    renameSync(candidate, target);
    candidate = undefined;
    chmodSync(target, 0o600);
    syncParent(path.dirname(target));
    return readRawConfigDocument(target);
  } finally {
    if (lockDescriptor !== undefined) closeSync(lockDescriptor);
    if (candidate) removeIfPresent(candidate);
    if (ownsLock) removeIfPresent(lockPath);
  }
}

export function addBuiltinProvider(
  configPath: string | undefined,
  target: BuiltinProviderName,
  reviewedProvider: RawConfig['providers'][string],
  expectedTarget: RawConfig['providers'][string] | undefined,
): RawConfigDocument {
  if (expectedTarget?.enabled) {
    throw new ConfigDocumentError(`Provider is already enabled: ${target}`);
  }
  if (!reviewedProvider.enabled) {
    throw new ConfigDocumentError(`Reviewed provider must be enabled: ${target}`);
  }

  return mutateConfigDocument(configPath, (raw) => {
    const currentTarget = raw.providers[target];
    if (currentTarget?.enabled) {
      throw new ConfigDocumentError(`Provider is already enabled: ${target}`);
    }
    if (!isDeepStrictEqual(currentTarget, expectedTarget)) {
      throw new ConfigDocumentError(`Provider ${target} changed since it was reviewed`);
    }

    const reviewedDirective = (reviewedProvider.directive ?? `@${target}`).toLowerCase();
    for (const [name, provider] of Object.entries(raw.providers)) {
      if (name === target) continue;
      const directive = provider.directive ?? `@${name}`;
      if (directive.toLowerCase() === reviewedDirective) {
        throw new ConfigDocumentError(
          `Provider directive ${reviewedProvider.directive ?? `@${target}`} is already used by ${name}`,
        );
      }
    }

    raw.providers[target] = {
      ...reviewedProvider,
      defaultArgs: [...reviewedProvider.defaultArgs],
    };
  });
}

export function addWatchedFolder(configPath: string | undefined, folder: string): string[] {
  const target = existingSafeTarget(configPath);
  const canonicalFolder = canonicalExistingDirectory(folder, path.dirname(target));
  const updated = mutateConfigDocument(target, (raw) => {
    const current = raw.vaults.map((vault) =>
      canonicalExistingDirectory(vault, path.dirname(target)),
    );
    if (current.some((vault) => samePath(vault, canonicalFolder))) {
      throw new ConfigDocumentError(`Folder is already watched: ${canonicalFolder}`);
    }
    raw.vaults.push(canonicalFolder);
  });
  return updated.raw.vaults.map((vault) =>
    canonicalExistingDirectory(vault, path.dirname(updated.path)),
  );
}

export function addRepositoryMapping(
  configPath: string | undefined,
  mapping: RawConfig['repositories'][number],
): RepositoryConfig[] {
  const target = existingSafeTarget(configPath);
  if (mapping.clones.length !== 1) {
    throw new ConfigDocumentError('Exactly one clone is required for a repository addition');
  }
  const repository = normalizeGitHubRepository(mapping.repository);
  const clone = canonicalExistingDirectory(mapping.clones[0]!, path.dirname(target));

  const updated = mutateConfigDocument(target, (raw) => {
    for (const configuredRepository of raw.repositories) {
      for (const configuredPath of configuredRepository.clones) {
        const configuredClone = canonicalExistingDirectory(configuredPath, path.dirname(target));
        if (samePath(configuredClone, clone)) {
          throw new ConfigDocumentError(`Clone is already configured: ${clone}`);
        }
      }
    }

    const existing = raw.repositories.find(
      (configuredRepository) =>
        normalizeGitHubRepository(configuredRepository.repository) === repository,
    );
    if (existing) existing.clones.push(clone);
    else raw.repositories.push({ repository, clones: [clone] });
  });

  return loadConfig(updated.path).repositories;
}

export function assignRepositoryAlias(
  configPath: string | undefined,
  repositoryIdentity: string,
  aliasValue: string,
): RepositoryConfig {
  const target = existingSafeTarget(configPath);
  const repository = normalizeGitHubRepository(repositoryIdentity);
  const alias = normalizeRepositoryAlias(aliasValue);

  const updated = mutateConfigDocument(target, (raw) => {
    const configuredRepository = raw.repositories.find(
      (candidate) => normalizeGitHubRepository(candidate.repository) === repository,
    );
    if (!configuredRepository) {
      throw new ConfigDocumentError(`Repository is not configured: ${repository}`);
    }

    for (const candidate of raw.repositories) {
      if (candidate === configuredRepository || candidate.alias === undefined) continue;
      if (normalizeRepositoryAlias(candidate.alias) === alias) {
        throw new ConfigDocumentError(
          `Repository alias ${JSON.stringify(alias)} is already used by ${normalizeGitHubRepository(candidate.repository)}`,
        );
      }
    }

    if (
      configuredRepository.alias !== undefined &&
      normalizeRepositoryAlias(configuredRepository.alias) === alias
    ) {
      return;
    }
    configuredRepository.alias = alias;
  });

  const configuredRepository = loadConfig(updated.path).repositories.find(
    (candidate) => candidate.repository === repository,
  );
  if (!configuredRepository) {
    throw new ConfigDocumentError(`Repository is not configured: ${repository}`);
  }
  return configuredRepository;
}

export function removeRepositoryMapping(
  configPath: string | undefined,
  canonicalClone: string,
): RepositoryRemovalResult {
  const target = existingSafeTarget(configPath);
  let result: RepositoryRemovalResult | undefined;

  mutateConfigDocument(target, (raw) => {
    let match:
      | {
          repositoryIndex: number;
          cloneIndex: number;
          clone: string;
        }
      | undefined;

    for (const [repositoryIndex, configuredRepository] of raw.repositories.entries()) {
      for (const [cloneIndex, configuredPath] of configuredRepository.clones.entries()) {
        const configuredClone = canonicalExistingDirectory(configuredPath, path.dirname(target));
        if (samePath(configuredClone, canonicalClone)) {
          match = { repositoryIndex, cloneIndex, clone: configuredClone };
          break;
        }
      }
      if (match) break;
    }

    if (!match) throw new ConfigDocumentError(`Clone is not configured: ${canonicalClone}`);

    const configuredRepository = raw.repositories[match.repositoryIndex]!;
    if (raw.repositories.length === 1 && configuredRepository.clones.length === 1) {
      throw new ConfigDocumentError(
        'Cannot remove the final configured repository clone; add another clone first',
      );
    }

    const poolRemoved = configuredRepository.clones.length === 1;
    result = {
      clone: match.clone,
      repository: normalizeGitHubRepository(configuredRepository.repository),
      poolRemoved,
    };

    if (poolRemoved) raw.repositories.splice(match.repositoryIndex, 1);
    else configuredRepository.clones.splice(match.cloneIndex, 1);
  });

  if (!result) throw new ConfigDocumentError(`Clone is not configured: ${canonicalClone}`);
  return result;
}

export function removeWatchedFolder(configPath: string | undefined, folder: string): string[] {
  const target = existingSafeTarget(configPath);
  const canonicalFolder = canonicalExistingDirectory(folder, path.dirname(target));
  const updated = mutateConfigDocument(target, (raw) => {
    const current = raw.vaults.map((vault) =>
      canonicalExistingDirectory(vault, path.dirname(target)),
    );
    const index = current.findIndex((vault) => samePath(vault, canonicalFolder));
    if (index < 0) throw new ConfigDocumentError(`Folder is not watched: ${canonicalFolder}`);
    if (raw.vaults.length === 1) {
      throw new ConfigDocumentError('Cannot remove the final watched folder');
    }
    raw.vaults.splice(index, 1);
  });
  return updated.raw.vaults.map((vault) =>
    canonicalExistingDirectory(vault, path.dirname(updated.path)),
  );
}

function writeValidatedCandidate(target: string, raw: RawConfig): string {
  const parsed = rawConfigSchema.parse(raw);
  const candidate = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      candidate,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    writeFileSync(descriptor, YAML.stringify(parsed), 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    loadConfig(candidate);
    return candidate;
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    removeIfPresent(candidate);
    throw error;
  }
}

function writeBackup(target: string, source: string): void {
  const backup = `${target}.backup`;
  const candidate = `${backup}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      candidate,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    writeFileSync(descriptor, source, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(candidate, backup);
    chmodSync(backup, 0o600);
    syncParent(path.dirname(target));
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    removeIfPresent(candidate);
  }
}

interface ConfigLockRecord {
  pid: number;
  processStartIdentity: string;
  nonce: string;
}

function acquireConfigLock(lockPath: string): number {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(
        lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      const record: ConfigLockRecord = {
        pid: process.pid,
        processStartIdentity: currentProcessStartIdentity(),
        nonce: randomUUID(),
      };
      try {
        writeFileSync(descriptor, `${JSON.stringify(record)}\n`, 'utf8');
        fsyncSync(descriptor);
        return descriptor;
      } catch (error) {
        closeSync(descriptor);
        removeIfPresent(lockPath);
        throw error;
      }
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error;
      if (attempt === 0 && reclaimStaleConfigLock(lockPath)) continue;
      throw new ConfigDocumentError(
        `Another spool configuration update owns ${lockPath}; retry after it finishes`,
      );
    }
  }
  throw new ConfigDocumentError(`Unable to acquire configuration update lock ${lockPath}`);
}

function reclaimStaleConfigLock(lockPath: string): boolean {
  let descriptor: number | undefined;
  let identity: { device: bigint; inode: bigint };
  let record: ConfigLockRecord;
  try {
    const linkStats = lstatSync(lockPath);
    if (!linkStats.isFile() || linkStats.isSymbolicLink()) return false;
    descriptor = openSync(lockPath, constants.O_RDONLY);
    const stats = fstatSync(descriptor, { bigint: true });
    identity = { device: stats.dev, inode: stats.ino };
    const parsed = JSON.parse(readFileSync(descriptor, 'utf8')) as unknown;
    if (!isConfigLockRecord(parsed)) return false;
    record = parsed;
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }

  if (readProcessStartIdentity(record.pid) === record.processStartIdentity) return false;
  try {
    const current = lstatSync(lockPath, { bigint: true });
    if (current.dev !== identity.device || current.ino !== identity.inode) return false;
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function isConfigLockRecord(value: unknown): value is ConfigLockRecord {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ConfigLockRecord>;
  return (
    Number.isInteger(candidate.pid) &&
    Number(candidate.pid) > 0 &&
    typeof candidate.processStartIdentity === 'string' &&
    candidate.processStartIdentity.length > 0 &&
    typeof candidate.nonce === 'string' &&
    candidate.nonce.length > 0
  );
}

function existingSafeTarget(configPath?: string): string {
  const requested = resolveConfigPath(configPath);
  let stats;
  try {
    stats = lstatSync(requested);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      throw new ConfigDocumentError(`Configuration does not exist at ${requested}`);
    }
    throw error;
  }
  if (stats.isSymbolicLink()) {
    throw new ConfigDocumentError(`Configuration must not be a symbolic link: ${requested}`);
  }
  if (!stats.isFile()) throw new ConfigDocumentError(`Configuration is not a file: ${requested}`);
  const target = safeTarget(requested, false);
  assertOwnedFile(target);
  return target;
}

function safeTarget(configPath: string | undefined, createParent: boolean): string {
  const requested = resolveConfigPath(configPath);
  const requestedParent = path.dirname(requested);
  if (!existsSync(requestedParent)) {
    if (!createParent)
      throw new ConfigDocumentError(`Directory does not exist: ${requestedParent}`);
    mkdirSync(requestedParent, { recursive: true, mode: 0o700 });
    chmodSync(requestedParent, 0o700);
  }
  const canonicalParent = safeDirectory(requestedParent);
  return path.join(canonicalParent, path.basename(requested));
}

function safeDirectory(target: string): string {
  const stats = lstatSync(target);
  if (stats.isSymbolicLink()) {
    throw new ConfigDocumentError(`Configuration parent must not be a symbolic link: ${target}`);
  }
  if (!stats.isDirectory()) {
    throw new ConfigDocumentError(`Configuration parent is not a directory: ${target}`);
  }
  assertOwner(stats.uid, target);
  if (process.platform !== 'win32' && (stats.mode & 0o022) !== 0) {
    throw new ConfigDocumentError(`Configuration parent is writable by other users: ${target}`);
  }
  return realpathSync(target);
}

function assertOwnedFile(target: string): void {
  const stats = lstatSync(target);
  assertOwner(stats.uid, target);
  if (process.platform !== 'win32' && (stats.mode & 0o022) !== 0) {
    throw new ConfigDocumentError(`Configuration is writable by other users: ${target}`);
  }
}

function assertOwner(uid: number, target: string): void {
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (currentUid !== undefined && uid !== currentUid) {
    throw new ConfigDocumentError(`Configuration path is not owned by the current user: ${target}`);
  }
}

function parseRawConfig(source: string, configPath: string): RawConfig {
  try {
    return rawConfigSchema.parse(YAML.parse(source, { uniqueKeys: true }));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigDocumentError(`Invalid configuration at ${configPath}: ${detail}`);
  }
}

function sourceIdentity(target: string): {
  source: string;
  device: bigint;
  inode: bigint;
  digest: string;
} {
  const stats = lstatSync(target, { bigint: true });
  if (stats.isSymbolicLink()) {
    throw new ConfigDocumentError(`Configuration must not be a symbolic link: ${target}`);
  }
  const source = readFileSync(target, 'utf8');
  return {
    source,
    device: stats.dev,
    inode: stats.ino,
    digest: createHash('sha256').update(source).digest('hex'),
  };
}

function assertSourceUnchanged(target: string, expected: ReturnType<typeof sourceIdentity>): void {
  let current: ReturnType<typeof sourceIdentity>;
  try {
    current = sourceIdentity(target);
  } catch {
    throw new ConfigDocumentError(`Configuration changed during configuration update: ${target}`);
  }
  if (
    current.device !== expected.device ||
    current.inode !== expected.inode ||
    current.digest !== expected.digest
  ) {
    throw new ConfigDocumentError(`Configuration changed during configuration update: ${target}`);
  }
}

function removeIfPresent(target: string): void {
  try {
    unlinkSync(target);
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error;
  }
}

function syncParent(parent: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(parent, constants.O_RDONLY);
    fsyncSync(descriptor);
  } catch (error) {
    if (
      process.platform !== 'win32' ||
      !['EISDIR', 'EPERM', 'EACCES', 'EINVAL'].some((code) => isNodeError(error, code))
    ) {
      throw error;
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
