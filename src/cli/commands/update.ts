import process from 'node:process';

import type { StaticCliPresenter } from '../output.js';
import { ClackStaticCliPresenter, sanitizeTerminalText } from '../output.js';
import {
  DaemonActiveInstallError,
  compareStableReleaseVersions,
  discoverManagedPrefix,
  installManagedRelease,
  ManagedInstallError,
  readManagedInstallOwnership,
  type ManagedInstallDependencies,
  type ManagedInstallResult,
} from '../../distribution/managed-install.js';
import {
  acquireRelease,
  deriveReleaseBaseUrl,
  type AcquiredRelease,
} from '../../distribution/release-client.js';

export type UpdateStatus =
  | 'current'
  | 'updated'
  | 'attention'
  | 'unmanaged'
  | 'daemon-active'
  | 'downgrade-refused'
  | 'unavailable'
  | 'failed-preserved'
  | 'rolled-back'
  | 'rollback-failed';

export interface UpdateResult {
  status: UpdateStatus;
  exitCode: 0 | 1;
  version?: string;
  message: string;
}

export interface UpdateDependencies {
  acquire?: (request: { releaseBaseUrl: string; version?: string }) => Promise<AcquiredRelease>;
  install?: typeof installManagedRelease;
  installDependencies?: ManagedInstallDependencies;
  entrypointPath?: string;
  releaseBaseUrl?: string;
}

export async function runManagedUpdate(
  options: { prefix?: string; version?: string; configPath?: string },
  dependencies: UpdateDependencies = {},
): Promise<UpdateResult> {
  let prefix: string | null;
  let ownership: ReturnType<typeof readManagedInstallOwnership>;
  try {
    prefix = options.prefix ?? discoverManagedPrefix(dependencies.entrypointPath);
    ownership = prefix ? readManagedInstallOwnership(prefix) : null;
  } catch (error) {
    return result(
      'failed-preserved',
      1,
      `Managed ownership metadata is invalid; no update was attempted: ${messageOf(error)}`,
    );
  }
  if (!prefix) return unmanagedResult();
  if (!ownership) return unmanagedResult();
  if (options.version !== undefined && !/^\d+\.\d+\.\d+$/.test(options.version)) {
    return result(
      'unavailable',
      1,
      `Could not acquire the requested stable release; Expected an exact stable version: ${options.version}. MDSpool ${ownership.version} remains active.`,
      ownership.version,
    );
  }
  if (options.version !== undefined) {
    const comparison = compareStableReleaseVersions(options.version, ownership.version);
    if (comparison < 0) {
      return result(
        'downgrade-refused',
        1,
        `Refusing to downgrade managed MDSpool from ${ownership.version} to ${options.version}.`,
        ownership.version,
      );
    }
    if (comparison === 0) {
      return result(
        'current',
        0,
        `Managed MDSpool ${ownership.version} is already current.`,
        ownership.version,
      );
    }
  }

  let acquired: AcquiredRelease;
  try {
    const releaseBaseUrl =
      dependencies.releaseBaseUrl ??
      process.env.MDSPOOL_RELEASE_BASE_URL ??
      deriveReleaseBaseUrl(ownership.releaseSource);
    acquired = await (dependencies.acquire ?? acquireRelease)({
      releaseBaseUrl,
      ...(options.version ? { version: options.version } : {}),
    });
  } catch (error) {
    return result(
      'unavailable',
      1,
      `Could not acquire the requested stable release; ${messageOf(error)}. MDSpool ${ownership.version} remains active.`,
      ownership.version,
    );
  }

  if (compareStableReleaseVersions(acquired.version, ownership.version) < 0) {
    acquired.cleanup();
    return result(
      'downgrade-refused',
      1,
      `Refusing to downgrade managed MDSpool from ${ownership.version} to ${acquired.version}.`,
      ownership.version,
    );
  }
  try {
    const installed = await (dependencies.install ?? installManagedRelease)(
      {
        candidateDirectory: acquired.candidateDirectory,
        prefix,
        version: acquired.version,
        channel: 'stable',
        releaseSource: acquired.releaseSource,
        artifactDigest: acquired.artifactDigest,
        nodeAbi: acquired.nodeAbi,
        ...(options.configPath ? { configPath: options.configPath } : {}),
      },
      dependencies.installDependencies,
    );
    return mapInstalled(installed);
  } catch (error) {
    if (error instanceof DaemonActiveInstallError) {
      return result('daemon-active', 1, error.message, ownership.version);
    }
    if (error instanceof ManagedInstallError && error.code === 'rolled-back') {
      return result('rolled-back', 1, error.message, ownership.version);
    }
    if (error instanceof ManagedInstallError && error.code === 'rollback-failed') {
      return result('rollback-failed', 1, error.message);
    }
    return result(
      'failed-preserved',
      1,
      `Update failed before activation; MDSpool ${ownership.version} remains active: ${messageOf(error)}`,
      ownership.version,
    );
  } finally {
    acquired.cleanup();
  }
}

export function presentUpdateResult(
  update: UpdateResult,
  json: boolean,
  presenter: StaticCliPresenter = new ClackStaticCliPresenter(),
) {
  if (json) {
    process.stdout.write(`${JSON.stringify(update, null, 2)}\n`);
    return;
  }
  const message = sanitizeTerminalText(update.message);
  if (update.exitCode === 0) presenter.success(message);
  else if (update.status === 'attention') presenter.warn(message);
  else presenter.error(message);
}

function mapInstalled(installed: ManagedInstallResult): UpdateResult {
  const status = installed.status === 'installed' ? 'updated' : installed.status;
  return result(status, installed.exitCode, installed.message, installed.version);
}

function unmanagedResult(): UpdateResult {
  return result(
    'unmanaged',
    1,
    'This MDSpool executable is not owned by the GitHub installer. Install it with install.sh before using managed updates.',
  );
}

function result(
  status: UpdateStatus,
  exitCode: 0 | 1,
  message: string,
  version?: string,
): UpdateResult {
  return { status, exitCode, message, ...(version ? { version } : {}) };
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
