import process from 'node:process';

import {
  ClackStaticCliPresenter,
  sanitizeTerminalText,
  type StaticCliPresenter,
} from '../output.js';
import {
  DaemonActiveInstallError,
  discoverManagedPrefix,
  ManagedInstallError,
  readManagedInstallOwnership,
  uninstallManagedRelease,
  type ManagedInstallDependencies,
} from '../../distribution/managed-install.js';

export type UninstallStatus = 'uninstalled' | 'unmanaged' | 'daemon-active' | 'failed-preserved';
export interface UninstallResult {
  status: UninstallStatus;
  exitCode: 0 | 1;
  version?: string;
  message: string;
}
export interface UninstallDependencies {
  uninstall?: typeof uninstallManagedRelease;
  uninstallDependencies?: ManagedInstallDependencies;
  entrypointPath?: string;
}

export async function runManagedUninstall(
  options: { prefix?: string; configPath?: string },
  dependencies: UninstallDependencies = {},
): Promise<UninstallResult> {
  let prefix: string | null;
  let ownership: ReturnType<typeof readManagedInstallOwnership>;
  try {
    prefix = options.prefix ?? discoverManagedPrefix(dependencies.entrypointPath);
    ownership = prefix ? readManagedInstallOwnership(prefix) : null;
  } catch (error) {
    return {
      status: 'failed-preserved',
      exitCode: 1,
      message: `Managed ownership metadata is invalid; no files were removed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!prefix || !ownership) {
    return {
      status: 'unmanaged',
      exitCode: 1,
      message:
        'This MDSpool executable is not owned by the GitHub installer; no files were removed.',
    };
  }
  try {
    const uninstalled = await (dependencies.uninstall ?? uninstallManagedRelease)(
      { prefix, ...(options.configPath ? { configPath: options.configPath } : {}) },
      dependencies.uninstallDependencies,
    );
    return { ...uninstalled };
  } catch (error) {
    if (error instanceof DaemonActiveInstallError) {
      return {
        status: 'daemon-active',
        exitCode: 1,
        version: ownership.version,
        message: error.message,
      };
    }
    const detail = error instanceof Error ? error.message : String(error);
    const message = error instanceof ManagedInstallError ? error.message : detail;
    return {
      status: 'failed-preserved',
      exitCode: 1,
      version: ownership.version,
      message: `Uninstall refused; managed MDSpool ${ownership.version} remains active: ${message}`,
    };
  }
}

export function presentUninstallResult(
  result: UninstallResult,
  json: boolean,
  presenter: StaticCliPresenter = new ClackStaticCliPresenter(),
) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const message = sanitizeTerminalText(result.message);
  if (result.exitCode === 0) presenter.success(message);
  else presenter.error(message);
}
