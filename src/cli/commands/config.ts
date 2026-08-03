import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { sanitizeTerminalText, type StaticCliPresenter } from '../output.js';
import {
  addRepositoryMapping,
  addWatchedFolder,
  ConfigDocumentError,
  readRawConfigDocument,
  removeWatchedFolder,
} from '../../config/document.js';
import { loadConfig } from '../../config/load.js';
import { canonicalExistingDirectory, isPathInside } from '../../config/paths.js';
import type { SpoolConfig } from '../../config/schema.js';
import { deriveRepositoryMappings } from '../../config/setup.js';
import { openLedgerDatabase } from '../../ledger/database.js';
import {
  currentProcessStartIdentity,
  DaemonLock,
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
