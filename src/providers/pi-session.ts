import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { pathsOverlap, samePath } from '../config/paths.js';

export interface PiSessionDirectoryOptions {
  readonly stateDirectory: string;
  readonly workspaceDirectories: readonly string[];
}

export interface PiSessionDirectoryInspection {
  readonly sessionDirectory: string;
  readonly error: string | null;
}

export function piSessionDirectory(stateDirectory: string): string {
  return path.join(realpathSync(stateDirectory), 'pi', 'sessions');
}

export function ensurePiSessionDirectory(options: PiSessionDirectoryOptions): string {
  const inspection = inspectPiSessionDirectory(options);
  if (inspection.error) throw new Error(inspection.error);

  const parent = path.dirname(inspection.sessionDirectory);
  ensureOwnerPrivateDirectory(parent, 'Pi session parent');
  ensureOwnerPrivateDirectory(inspection.sessionDirectory, 'Pi session directory');
  return realpathSync(inspection.sessionDirectory);
}

export function inspectPiSessionDirectory(
  options: PiSessionDirectoryOptions,
): PiSessionDirectoryInspection {
  const sessionDirectory = piSessionDirectory(options.stateDirectory);
  const overlappingWorkspace = options.workspaceDirectories.find((workspace) => {
    let canonicalWorkspace: string;
    try {
      canonicalWorkspace = realpathSync(workspace);
    } catch {
      canonicalWorkspace = path.resolve(workspace);
    }
    return pathsOverlap(sessionDirectory, canonicalWorkspace);
  });
  if (overlappingWorkspace) {
    return {
      sessionDirectory,
      error: `Pi session directory must not overlap a leased repository workspace: ${overlappingWorkspace}`,
    };
  }

  for (const [target, label] of [
    [path.dirname(sessionDirectory), 'Pi session parent'],
    [sessionDirectory, 'Pi session directory'],
  ] as const) {
    const error = inspectExistingOwnerPrivateDirectory(target, label);
    if (error) return { sessionDirectory, error };
  }
  return { sessionDirectory, error: null };
}

function ensureOwnerPrivateDirectory(target: string, label: string): void {
  try {
    mkdirSync(target, { mode: 0o700 });
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  const unsafe = inspectExistingOwnerPrivateDirectory(target, label);
  if (unsafe) throw new Error(unsafe);
}

function inspectExistingOwnerPrivateDirectory(target: string, label: string): string | null {
  let stats;
  try {
    stats = lstatSync(target);
  } catch (error) {
    if (isMissing(error)) return null;
    return `${label} cannot be inspected safely: ${errorMessage(error)}`;
  }
  if (stats.isSymbolicLink()) return `${label} must not be a symbolic link: ${target}`;
  if (!stats.isDirectory()) return `${label} must be a directory: ${target}`;
  if ((stats.mode & 0o777) !== 0o700) {
    return `${label} must be owner-private with mode 0700: ${target}`;
  }
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    return `${label} must be owned by the current user: ${target}`;
  }
  try {
    if (!samePath(realpathSync(target), path.resolve(target))) {
      return `${label} must resolve without symbolic links: ${target}`;
    }
  } catch (error) {
    return `${label} cannot be resolved safely: ${errorMessage(error)}`;
  }
  return null;
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return errorCode(error) === 'EEXIST';
}

function errorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
