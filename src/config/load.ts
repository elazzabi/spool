import { readFileSync } from 'node:fs';
import path from 'node:path';

import YAML from 'yaml';
import { ZodError } from 'zod';

import {
  type SpoolConfig,
  isIanaTimeZone,
  normalizeGitHubRepository,
  normalizeRepositoryAlias,
  rawConfigSchema,
} from './schema.js';
import {
  canonicalExistingDirectory,
  canonicalExistingFile,
  pathsOverlap,
  resolveConfigPath,
  resolveExecutable,
  type ConfigPathEnvironment,
} from './paths.js';

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export interface LoadConfigOptions extends ConfigPathEnvironment {
  pathValue?: string;
}

export function loadConfig(explicitPath?: string, options: LoadConfigOptions = {}): SpoolConfig {
  const requestedPath = resolveConfigPath(explicitPath, options);
  let configPath: string;
  let parsed: unknown;
  try {
    configPath = canonicalExistingFile(requestedPath);
    parsed = YAML.parse(readFileSync(configPath, 'utf8'), { uniqueKeys: true });
  } catch (error) {
    throw configError(`Unable to read configuration at ${requestedPath}`, error);
  }

  try {
    const raw = rawConfigSchema.parse(parsed);
    if (!isIanaTimeZone(raw.timeZone)) {
      throw new ConfigError(`Invalid IANA time zone: ${raw.timeZone}`);
    }

    const baseDirectory = path.dirname(configPath);
    const vaults = uniqueCanonicalDirectories(raw.vaults, baseDirectory, 'vault');
    const stateDirectory = canonicalExistingDirectory(raw.stateDirectory, baseDirectory);
    if (vaults.some((vault) => pathsOverlap(vault, stateDirectory))) {
      throw new ConfigError('State directory must not overlap a watched vault');
    }
    const directives = new Set<string>();
    const providers = Object.entries(raw.providers).map(([name, provider]) => {
      const directive = provider.directive ?? `@${name}`;
      const normalizedDirective = directive.toLowerCase();
      if (directives.has(normalizedDirective)) {
        throw new ConfigError(`Duplicate provider directive: ${directive}`);
      }
      directives.add(normalizedDirective);
      const resolved = resolveExecutable(provider.executable, {
        baseDirectory,
        ...(options.pathValue === undefined ? {} : { pathValue: options.pathValue }),
      });
      return {
        name,
        enabled: provider.enabled,
        executable: resolved.executable,
        executableResolved: resolved.resolved,
        directive,
        defaultArgs: [...provider.defaultArgs],
      };
    });

    validateDayAliases(raw.dayAliases);
    const repositories = raw.repositories.map((repository) => ({
      repository: normalizeGitHubRepository(repository.repository),
      ...(repository.alias === undefined
        ? {}
        : { alias: normalizeRepositoryAlias(repository.alias) }),
      clones: uniqueCanonicalDirectories(repository.clones, baseDirectory, 'clone'),
    }));
    validateRepositoryOwnership(repositories);

    return {
      configPath,
      vaults,
      stateDirectory,
      timeZone: raw.timeZone,
      pollIntervalSeconds: raw.pollIntervalSeconds,
      dayAliases: raw.dayAliases,
      providers,
      repositories,
    };
  } catch (error) {
    throw configError(`Invalid configuration at ${configPath}`, error);
  }
}

function uniqueCanonicalDirectories(
  values: string[],
  baseDirectory: string,
  kind: string,
): string[] {
  const result = values.map((value) => canonicalExistingDirectory(value, baseDirectory));
  const seen = new Set<string>();
  for (const directory of result) {
    const identity = pathIdentity(directory);
    if (seen.has(identity)) throw new ConfigError(`Duplicate ${kind} path: ${directory}`);
    seen.add(identity);
  }
  return result;
}

function validateDayAliases(aliases: Record<string, string[] | undefined>): void {
  const seen = new Map<string, string>();
  for (const [day, values] of Object.entries(aliases)) {
    for (const value of values ?? []) {
      const identity = value.trim().toLocaleLowerCase('en-US');
      const previous = seen.get(identity);
      if (previous && previous !== day) {
        throw new ConfigError(
          `Day alias ${JSON.stringify(value)} belongs to both ${previous} and ${day}`,
        );
      }
      seen.set(identity, day);
    }
  }
}

function validateRepositoryOwnership(
  repositories: Array<{ repository: string; alias?: string; clones: string[] }>,
): void {
  const repositoryNames = new Set<string>();
  const repositoryAliases = new Map<string, string>();
  for (const item of repositories) {
    if (repositoryNames.has(item.repository)) {
      throw new ConfigError(`Duplicate repository mapping: ${item.repository}`);
    }
    repositoryNames.add(item.repository);
    if (item.alias !== undefined) {
      const previous = repositoryAliases.get(item.alias);
      if (previous !== undefined) {
        throw new ConfigError(
          `Duplicate repository alias ${JSON.stringify(item.alias)} belongs to both ${previous} and ${item.repository}`,
        );
      }
      repositoryAliases.set(item.alias, item.repository);
    }
  }

  const clones = repositories.flatMap((item) =>
    item.clones.map((clone) => ({ clone, repository: item.repository })),
  );
  for (let leftIndex = 0; leftIndex < clones.length; leftIndex += 1) {
    const left = clones[leftIndex];
    if (!left) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < clones.length; rightIndex += 1) {
      const right = clones[rightIndex];
      if (!right) continue;
      if (pathsOverlap(left.clone, right.clone)) {
        throw new ConfigError(
          `Clone paths overlap between ${left.repository} and ${right.repository}: ${left.clone} / ${right.clone}`,
        );
      }
    }
  }
}

function pathIdentity(value: string): string {
  return process.platform === 'win32' || process.platform === 'darwin'
    ? value.toLowerCase()
    : value;
}

function configError(prefix: string, error: unknown): ConfigError {
  if (error instanceof ConfigError) return error;
  if (error instanceof ZodError) {
    const details = error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    return new ConfigError(`${prefix}: ${details}`);
  }
  const details = error instanceof Error ? error.message : String(error);
  return new ConfigError(`${prefix}: ${details}`);
}
