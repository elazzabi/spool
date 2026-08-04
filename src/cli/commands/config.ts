import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { sanitizeTerminalText, type StaticCliPresenter } from '../output.js';
import {
  addRepositoryMapping,
  addWatchedFolder,
  ConfigDocumentError,
  readRawConfigDocument,
  removeRepositoryMapping,
  type RepositoryRemovalResult,
  removeWatchedFolder,
} from '../../config/document.js';
import { loadConfig } from '../../config/load.js';
import { canonicalExistingDirectory, isPathInside, samePath } from '../../config/paths.js';
import type { SpoolConfig } from '../../config/schema.js';
import { deriveRepositoryMappings } from '../../config/setup.js';
import { openLedgerDatabase } from '../../ledger/database.js';
import {
  currentProcessStartIdentity,
  DaemonLock,
  DaemonLockConflictError,
  type DaemonOwnershipIdentity,
} from '../../ledger/daemon-lock.js';
import { LedgerRepository } from '../../ledger/repositories.js';
import { redactSensitiveArgv } from '../../providers/argv.js';

export interface ConfigurationSummary {
  configPath: string;
  watchedFolders: string[];
  stateDirectory: string;
  timeZone: string;
  pollIntervalSeconds: number;
  providers: Array<{
    name: string;
    enabled: boolean;
    executable: string;
    directive: string;
    defaultArgs: string[];
  }>;
  repositories: SpoolConfig['repositories'];
}

export function configurationSummary(configPath?: string): ConfigurationSummary {
  const config = loadConfig(configPath);
  return {
    configPath: config.configPath,
    watchedFolders: config.vaults,
    stateDirectory: config.stateDirectory,
    timeZone: config.timeZone,
    pollIntervalSeconds: config.pollIntervalSeconds,
    providers: config.providers.map((provider) => ({
      name: provider.name,
      enabled: provider.enabled,
      executable: provider.executable,
      directive: provider.directive,
      defaultArgs: redactSensitiveArgv(provider.defaultArgs),
    })),
    repositories: config.repositories,
  };
}

export function presentConfigurationSummary(
  summary: ConfigurationSummary,
  presenter: StaticCliPresenter,
): void {
  presenter.intro('spool configuration');
  presenter.section('General', [
    `Config: ${sanitizeTerminalText(summary.configPath)}`,
    `State: ${sanitizeTerminalText(summary.stateDirectory)}`,
    `Time zone: ${sanitizeTerminalText(summary.timeZone)}`,
    `Poll interval: ${String(summary.pollIntervalSeconds)} seconds`,
  ]);
  presenter.section('Watched folders', summary.watchedFolders.map(sanitizeTerminalText));
  presenter.section(
    'Providers',
    summary.providers.map(
      (provider) =>
        `${sanitizeTerminalText(provider.name)} | ${provider.enabled ? 'enabled' : 'disabled'} | ${provider.defaultArgs.map(renderArg).join(' ') || 'no flags'}`,
    ),
  );
  presenter.section('Repository pools', repositoryPoolLines(summary.repositories));
  presenter.outro('Configuration inspection complete');
}

export function listWatchedFolders(configPath?: string): string[] {
  return loadConfig(configPath).vaults;
}

export function addWatchedFolderCommand(configPath: string | undefined, folder: string): string[] {
  return addWatchedFolder(configPath, folder);
}

export interface AddedRepositoryMapping {
  clone: string;
  repository: string;
}

export async function addRepositoryCommand(
  configPath: string | undefined,
  clonePath: string,
): Promise<AddedRepositoryMapping> {
  const document = readRawConfigDocument(configPath);
  const [mapping] = await deriveRepositoryMappings([clonePath], {
    baseDirectory: process.cwd(),
  });
  if (!mapping?.clones[0]) {
    throw new ConfigDocumentError('Unable to derive a repository mapping');
  }
  addRepositoryMapping(document.path, mapping);
  return { clone: mapping.clones[0], repository: mapping.repository };
}

export function removeRepositoryCommand(
  configPath: string | undefined,
  clonePath: string,
): RepositoryRemovalResult {
  const config = loadConfig(configPath);
  let canonicalClone: string;
  try {
    canonicalClone = canonicalExistingDirectory(clonePath, process.cwd());
  } catch (error) {
    throw sanitizedConfigDocumentError(error);
  }

  assertWorkspaceDoesNotContainSpoolConfiguration(config, canonicalClone);

  const database = openLedgerDatabase(config.stateDirectory);
  const daemonLock = new DaemonLock(database);
  const owner: DaemonOwnershipIdentity = {
    nonce: randomUUID(),
    pid: process.pid,
    processStartIdentity: currentProcessStartIdentity(),
  };
  let ownsDaemonLock = false;
  try {
    try {
      daemonLock.acquireProcessScoped(owner);
      ownsDaemonLock = true;
    } catch (error) {
      if (error instanceof DaemonLockConflictError) {
        throw new ConfigDocumentError(
          `Cannot remove ${sanitizeTerminalText(canonicalClone)} while another spool daemon is running; stop the daemon and retry`,
        );
      }
      throw error;
    }

    assertWorkspaceHasNoNonReleasedLease(new LedgerRepository(database), canonicalClone);
    try {
      return removeRepositoryMapping(config.configPath, canonicalClone);
    } catch (error) {
      throw sanitizedConfigDocumentError(error);
    }
  } finally {
    if (ownsDaemonLock) daemonLock.release(owner);
    database.close();
  }
}

function assertWorkspaceDoesNotContainSpoolConfiguration(
  config: SpoolConfig,
  canonicalClone: string,
): void {
  if (isPathInside(canonicalClone, config.stateDirectory)) {
    throw new ConfigDocumentError(
      `Cannot remove ${sanitizeTerminalText(canonicalClone)} because the spool state directory ${sanitizeTerminalText(config.stateDirectory)} is inside it; move the state directory outside this workspace, update the configuration, and retry`,
    );
  }
  if (isPathInside(canonicalClone, config.configPath)) {
    throw new ConfigDocumentError(
      `Cannot remove ${sanitizeTerminalText(canonicalClone)} because the spool configuration ${sanitizeTerminalText(config.configPath)} is inside it; move the configuration outside this workspace and retry`,
    );
  }
}

export function removeWatchedFolderCommand(
  configPath: string | undefined,
  folder: string,
): string[] {
  const config = loadConfig(configPath);
  const canonicalFolder = canonicalExistingDirectory(folder, path.dirname(config.configPath));
  const database = openLedgerDatabase(config.stateDirectory);
  const daemonLock = new DaemonLock(database);
  const owner: DaemonOwnershipIdentity = {
    nonce: randomUUID(),
    pid: process.pid,
    processStartIdentity: currentProcessStartIdentity(),
  };
  let ownsDaemonLock = false;
  try {
    daemonLock.acquire(owner, 30_000);
    ownsDaemonLock = true;
    assertFolderHasNoDurableWork(new LedgerRepository(database), canonicalFolder);
    return removeWatchedFolder(config.configPath, canonicalFolder);
  } finally {
    if (ownsDaemonLock) daemonLock.release(owner);
    database.close();
  }
}

export function formatWatchedFolders(folders: readonly string[]): string {
  return folders.map((folder) => sanitizeTerminalText(folder)).join('\n');
}

export function presentWatchedFolders(
  folders: readonly string[],
  presenter: StaticCliPresenter,
): void {
  presenter.intro('spool watched folders');
  presenter.section(
    'Folders',
    folders.length === 0
      ? ['No watched folders.']
      : folders.map((folder) => sanitizeTerminalText(folder)),
  );
  presenter.outro('Watch inspection complete');
}

function assertFolderHasNoDurableWork(ledger: LedgerRepository, folder: string): void {
  for (const reference of ledger.watchRemovalReferences()) {
    if (isPathInside(folder, path.resolve(reference.sourcePath))) {
      const label = reference.kind === 'job' ? 'unfinished job' : 'undelivered projection';
      throw new ConfigDocumentError(
        `Cannot stop watching ${sanitizeTerminalText(folder)} while an ${label} references it`,
      );
    }
  }
}

function assertWorkspaceHasNoNonReleasedLease(
  ledger: LedgerRepository,
  canonicalClone: string,
): void {
  const lease = ledger
    .listLeases()
    .find((candidate) => samePath(candidate.canonicalWorkspace, canonicalClone));
  if (!lease || lease.state === 'Released') return;
  throw new ConfigDocumentError(
    `Cannot remove ${sanitizeTerminalText(canonicalClone)} while its workspace lease is ${lease.state}; recover or release the workspace, then retry`,
  );
}

function sanitizedConfigDocumentError(error: unknown): ConfigDocumentError {
  const message = error instanceof Error ? error.message : String(error);
  return new ConfigDocumentError(sanitizeTerminalText(message));
}

function repositoryPoolLines(repositories: ConfigurationSummary['repositories']): string[] {
  const lines: string[] = [];
  for (const repository of repositories) {
    lines.push(sanitizeTerminalText(repository.repository));
    for (const clone of repository.clones) lines.push(`  ${sanitizeTerminalText(clone)}`);
  }
  return lines;
}

function renderArg(value: string): string {
  return JSON.stringify(sanitizeTerminalText(value));
}
