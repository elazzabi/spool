import { constants, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ConfigPathEnvironment {
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  env?: NodeJS.ProcessEnv;
}

export function defaultConfigPath(environment: ConfigPathEnvironment = {}): string {
  const platform = environment.platform ?? process.platform;
  const homeDirectory = environment.homeDirectory ?? os.homedir();
  const env = environment.env ?? process.env;

  if (env.XDG_CONFIG_HOME) {
    return path.join(env.XDG_CONFIG_HOME, 'mdspool', 'config.yaml');
  }
  if (platform === 'win32' && env.APPDATA) {
    return path.join(env.APPDATA, 'mdspool', 'config.yaml');
  }
  if (platform === 'darwin') {
    return path.join(homeDirectory, 'Library', 'Application Support', 'mdspool', 'config.yaml');
  }
  return path.join(homeDirectory, '.config', 'mdspool', 'config.yaml');
}

export function resolveConfigPath(
  explicitPath?: string,
  environment: ConfigPathEnvironment = {},
): string {
  return resolveUserPath(explicitPath ?? defaultConfigPath(environment), environment);
}

export function isDefaultConfigPath(
  candidate: string,
  environment: ConfigPathEnvironment = {},
): boolean {
  const configuredDefault = defaultConfigPath(environment);
  if (samePath(candidate, configuredDefault)) return true;

  try {
    return samePath(realpathSync(candidate), realpathSync(configuredDefault));
  } catch {
    return false;
  }
}

export function resolveUserPath(value: string, environment: ConfigPathEnvironment = {}): string {
  return path.resolve(expandHome(value, environment.homeDirectory));
}

export function canonicalExistingDirectory(value: string, baseDirectory: string): string {
  const resolved = resolveConfiguredPath(value, baseDirectory);
  const canonical = realpathSync(resolved);
  if (!statSync(canonical).isDirectory()) {
    throw new Error(`Expected a directory: ${value}`);
  }
  return canonical;
}

export function canonicalExistingFile(value: string): string {
  const canonical = realpathSync(value);
  if (!statSync(canonical).isFile()) {
    throw new Error(`Expected a file: ${value}`);
  }
  return canonical;
}

export function resolveExecutable(
  executable: string,
  options: { baseDirectory: string; pathValue?: string },
): { executable: string; resolved: boolean } {
  const hasPathSeparator = executable.includes('/') || executable.includes('\\');
  const candidates = hasPathSeparator
    ? [resolveConfiguredPath(executable, options.baseDirectory)]
    : (options.pathValue ?? process.env.PATH ?? '')
        .split(path.delimiter)
        .filter(Boolean)
        .map((directory) => path.join(directory, executable));

  for (const candidate of candidates) {
    try {
      const canonical = realpathSync(candidate);
      const stats = statSync(canonical);
      if (stats.isFile() && canExecute(canonical)) {
        return { executable: canonical, resolved: true };
      }
    } catch {
      // A missing PATH candidate is an availability result for doctor, not a config error.
    }
  }
  return { executable, resolved: false };
}

export function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' || process.platform === 'darwin'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

export function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

export function pathsOverlap(left: string, right: string): boolean {
  return isPathInside(left, right) || isPathInside(right, left);
}

export function deepestContainingDirectory(
  directories: readonly string[],
  candidatePath: string,
): string | null {
  const candidate = path.resolve(candidatePath);
  let owner: string | null = null;
  for (const directory of directories) {
    const normalized = path.resolve(directory);
    if (!isPathInside(normalized, candidate)) continue;
    if (owner === null || (!samePath(owner, normalized) && isPathInside(owner, normalized))) {
      owner = normalized;
    }
  }
  return owner;
}

export function resolveConfiguredPath(value: string, baseDirectory: string): string {
  return path.resolve(baseDirectory, expandHome(value));
}

function expandHome(value: string, homeDirectory = os.homedir()): string {
  if (value === '~') return homeDirectory;
  if (value.startsWith(`~${path.sep}`)) return path.join(homeDirectory, value.slice(2));
  return value;
}

function canExecute(file: string): boolean {
  try {
    process.getBuiltinModule('node:fs').accessSync(file, constants.X_OK);
    return true;
  } catch {
    return process.platform === 'win32';
  }
}
