import { execFile } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmdirSync,
} from 'node:fs';
import path from 'node:path';

import { assessConfigTarget, createConfigDocument } from './document.js';
import {
  builtinProviderProbeArgs,
  evaluateBuiltinProviderPreflight,
  type BuiltinProviderName,
} from '../providers/preflight.js';
import { selectProviderEnvironment } from '../providers/environment.js';
import { assertAllowedProviderArgv, type ProviderArgvPolicy } from '../providers/argv.js';
import { piEnvironmentAllowlist, piSafeArgs } from '../providers/pi.js';
import {
  hasExcludedPiAmbientCredential,
  hasPiModelRow,
  piModelProbeArgs,
  piStoredAuthGuidance,
} from '../providers/pi-readiness.js';
import { NodeGitRunner, type GitRunner } from '../workspaces/git.js';
import { sanitizeTerminalText } from '../terminal.js';
import {
  canonicalExistingDirectory,
  pathsOverlap,
  resolveExecutable,
  resolveUserPath,
  samePath,
} from './paths.js';
import {
  isIanaTimeZone,
  normalizeGitHubRepository,
  type RawConfig,
  rawConfigSchema,
} from './schema.js';

export class SetupError extends Error {
  override readonly name = 'SetupError';
}

export interface ProviderSetupDefinition {
  name: BuiltinProviderName;
  executable: string;
  directive: string;
  recommendedArgs: string[];
  authenticationArgs: string[];
  access: ProviderAccessDefinition;
  argvPolicy: ProviderArgvPolicy;
  adapterOwnedArgs: readonly string[];
}

export type ProviderAccessProfile = 'recommended' | 'unrestricted' | 'custom-only';

export interface ProviderUnrestrictedAccessDefinition {
  readonly label: string;
  readonly args: readonly string[];
  readonly warning: string;
}

export interface ProviderAccessDefinition {
  readonly recommendedDescription: string;
  readonly customOnlyDescription: string;
  readonly unrestricted?: ProviderUnrestrictedAccessDefinition;
}

export interface ProviderArgumentChoice {
  readonly profile: ProviderAccessProfile;
  readonly extraArgs: readonly string[];
}

export interface ProviderSetupStatus {
  definition: ProviderSetupDefinition;
  installed: boolean;
  authenticated: boolean;
  parserSupported: boolean;
  ready: boolean;
  installedVersion: string | null;
  reason: string;
  warnings: readonly string[];
}

export interface ProviderProbeRunOptions {
  shell: false;
  timeoutMs: number;
  environment?: NodeJS.ProcessEnv;
}

export interface ProviderProbeResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  failure?: 'timed-out' | 'failed';
}

export type ProviderProbeRunner = (
  executable: string,
  args: string[],
  options: ProviderProbeRunOptions,
) => Promise<ProviderProbeResult>;

export interface SetupConfigurationCandidate {
  configPath: string;
  configParent: string;
  stateDirectory: string;
  raw: RawConfig;
}

export const providerSetupDefinitions: readonly ProviderSetupDefinition[] = [
  {
    name: 'claude',
    executable: 'claude',
    directive: '@claude',
    recommendedArgs: ['--permission-mode', 'plan'],
    authenticationArgs: ['auth', 'status', '--json'],
    access: {
      recommendedDescription: 'Use plan mode so Claude proposes changes without applying them.',
      customOnlyDescription: "Start without MDSpool's recommended permission-mode baseline.",
      unrestricted: {
        label: 'Unrestricted (dangerous)',
        args: ['--dangerously-skip-permissions'],
        warning:
          'Claude will skip every permission check and may read, change, or run anything available to your account in registered workspaces.',
      },
    },
    argvPolicy: {
      reservedArgs: [
        '-p',
        '--print',
        '--output-format',
        '--verbose',
        '-r',
        '--resume',
        '-c',
        '--continue',
        '--no-session-persistence',
      ],
      deniedRules: [
        { names: ['--dangerously-skip-permissions'] },
        { names: ['--permission-mode'], values: ['bypassPermissions'] },
      ],
    },
    adapterOwnedArgs: ['-p', '--output-format stream-json', '--verbose', '--resume <session-id>'],
  },
  {
    name: 'codex',
    executable: 'codex',
    directive: '@codex',
    recommendedArgs: ['--sandbox', 'read-only'],
    authenticationArgs: ['login', 'status'],
    access: {
      recommendedDescription: 'Use the read-only sandbox for filesystem access.',
      customOnlyDescription: "Start without MDSpool's recommended sandbox baseline.",
      unrestricted: {
        label: 'Unrestricted (dangerous)',
        args: ['--dangerously-bypass-approvals-and-sandbox'],
        warning:
          'Codex will bypass approval prompts and sandboxing, allowing commands and filesystem changes with your full local privileges.',
      },
    },
    argvPolicy: {
      reservedArgs: ['exec', 'resume', '--json', '-', '--ephemeral'],
      deniedRules: [{ names: ['--dangerously-bypass-approvals-and-sandbox'] }],
    },
    adapterOwnedArgs: ['exec', '--json', '- (stdin prompt)', 'resume <session-id>'],
  },
  {
    name: 'cursor',
    executable: 'cursor-agent',
    directive: '@cursor',
    recommendedArgs: ['--mode', 'plan'],
    authenticationArgs: ['about'],
    access: {
      recommendedDescription: 'Use plan mode so Cursor proposes changes without applying them.',
      customOnlyDescription: "Start without MDSpool's recommended mode baseline.",
      unrestricted: {
        label: 'Direct changes (dangerous)',
        args: ['--force'],
        warning:
          'Cursor will execute commands and apply changes without confirmation in registered workspaces.',
      },
    },
    argvPolicy: {
      reservedArgs: ['-p', '--print', '--output-format', '--workspace', '--resume', '--continue'],
      deniedRules: [{ names: ['--force', '--yolo'] }],
    },
    adapterOwnedArgs: [
      '--print',
      '--output-format stream-json',
      '--workspace <workspace>',
      '--resume <session-id>',
    ],
  },
  {
    name: 'pi',
    executable: 'pi',
    directive: '@pi',
    recommendedArgs: [...piSafeArgs],
    authenticationArgs: [...piModelProbeArgs],
    access: {
      recommendedDescription:
        "Use MDSpool's offline file-review tools with extensions, context files, skills, and prompt templates disabled.",
      customOnlyDescription:
        'Start without the recommended baseline; MDSpool still appends its enforced Pi restrictions.',
    },
    argvPolicy: {
      reservedArgs: [
        ...piSafeArgs.filter((arg) => arg.startsWith('-')),
        '-t',
        '-ne',
        '-nc',
        '-ns',
        '-np',
        '--extension',
        '-e',
        '--skill',
        '--prompt-template',
        '--mcp-config',
        '--session-dir',
        '--session',
        '--no-session',
        '--continue',
        '-c',
        '--resume',
        '-r',
        '--fork',
        '--mode',
        '--json',
      ],
      deniedRules: [],
    },
    adapterOwnedArgs: [
      ...piSafeArgs,
      '--session-dir <managed>',
      '--mode json',
      '--session <session-id>',
    ],
  },
] as const;

export async function detectBuiltinProviders(
  options: {
    commandRunner?: ProviderProbeRunner;
    pathValue?: string;
    baseDirectory?: string;
    providerNames?: readonly BuiltinProviderName[];
    environment?: NodeJS.ProcessEnv;
  } = {},
): Promise<ProviderSetupStatus[]> {
  const commandRunner = options.commandRunner ?? runSetupCommand;
  const baseDirectory = options.baseDirectory ?? process.cwd();
  const providerNames = options.providerNames;
  const definitions =
    providerNames === undefined
      ? providerSetupDefinitions
      : providerSetupDefinitions.filter((definition) => providerNames.includes(definition.name));
  return Promise.all(
    definitions.map((definition) =>
      detectBuiltinProvider(
        definition,
        commandRunner,
        baseDirectory,
        options.pathValue ?? options.environment?.PATH,
        options.environment ?? process.env,
      ),
    ),
  );
}

export function mapSelectedProviders(
  statuses: readonly ProviderSetupStatus[],
  selectedProviderNames: ReadonlySet<string>,
  argumentChoices: ReadonlyMap<string, ProviderArgumentChoice> = new Map(),
): RawConfig['providers'] {
  const statusesByName = new Map<string, ProviderSetupStatus>(
    statuses.map((status) => [status.definition.name, status] as const),
  );
  for (const selectedName of selectedProviderNames) {
    if (!statusesByName.get(selectedName)?.ready) {
      throw new SetupError(`Selected provider is not ready: ${sanitizeTerminalText(selectedName)}`);
    }
  }

  const providers: RawConfig['providers'] = {};
  for (const status of statuses) {
    const { definition } = status;
    const selected = selectedProviderNames.has(definition.name);
    const defaultArgs = selected
      ? configuredProviderArgs(
          definition,
          argumentChoices.get(definition.name) ?? {
            profile: 'recommended',
            extraArgs: [],
          },
        )
      : [...definition.recommendedArgs];
    providers[definition.name] = {
      enabled: selected,
      executable: definition.executable,
      directive: definition.directive,
      defaultArgs,
    };
  }
  return providers;
}

export function assertProviderArgumentChoice(
  definition: ProviderSetupDefinition,
  choice: ProviderArgumentChoice,
): void {
  providerProfileArgs(definition, choice.profile);
  assertAllowedProviderArgv(choice.extraArgs, definition.argvPolicy);
}

function configuredProviderArgs(
  definition: ProviderSetupDefinition,
  choice: ProviderArgumentChoice,
): string[] {
  assertProviderArgumentChoice(definition, choice);
  const baseline = providerProfileArgs(definition, choice.profile);
  return [...baseline, ...choice.extraArgs];
}

function providerProfileArgs(
  definition: ProviderSetupDefinition,
  profile: ProviderAccessProfile,
): readonly string[] {
  switch (profile) {
    case 'recommended':
      return definition.recommendedArgs;
    case 'custom-only':
      return [];
    case 'unrestricted':
      if (definition.access.unrestricted === undefined) {
        throw new SetupError(`${definition.name} does not offer an unrestricted profile`);
      }
      return definition.access.unrestricted.args;
  }
}

async function detectBuiltinProvider(
  definition: ProviderSetupDefinition,
  commandRunner: ProviderProbeRunner,
  baseDirectory: string,
  pathValue: string | undefined,
  environment: NodeJS.ProcessEnv,
): Promise<ProviderSetupStatus> {
  const resolved = resolveExecutable(definition.executable, {
    baseDirectory,
    ...(pathValue === undefined ? {} : { pathValue }),
  });
  if (!resolved.resolved) return disabledStatus(definition, 'executable not found');

  try {
    const runOptions = { shell: false as const, timeoutMs: 5_000 };
    const probeOptions =
      definition.name === 'pi'
        ? {
            ...runOptions,
            environment: selectProviderEnvironment(environment, piEnvironmentAllowlist),
          }
        : runOptions;
    const [version, probe] = await Promise.all([
      commandRunner(resolved.executable, ['--version'], probeOptions),
      commandRunner(resolved.executable, builtinProviderProbeArgs(definition.name), probeOptions),
    ]);
    const preflight = evaluateBuiltinProviderPreflight({
      provider: definition.name,
      versionOutput: version.stdout || version.stderr,
      probe: { ok: probe.ok, output: `${probe.stdout}\n${probe.stderr}` },
    });
    if (!version.ok || !probe.ok) {
      const failure = [version, probe].find((result) => !result.ok)?.failure;
      return {
        definition,
        installed: true,
        authenticated: false,
        parserSupported: false,
        ready: false,
        installedVersion: preflight.installedVersion,
        reason: failure === 'timed-out' ? 'provider check timed out' : 'provider check failed',
        warnings: preflight.warnings,
      };
    }
    if (!preflight.parserSupported) {
      return {
        definition,
        installed: true,
        authenticated: false,
        parserSupported: false,
        ready: false,
        installedVersion: preflight.installedVersion,
        reason: preflight.warnings[0] ?? 'provider contract is unsupported',
        warnings: preflight.warnings,
      };
    }

    const authentication = await commandRunner(
      resolved.executable,
      definition.authenticationArgs,
      probeOptions,
    );
    if (!authentication.ok) {
      return {
        definition,
        installed: true,
        authenticated: false,
        parserSupported: true,
        ready: false,
        installedVersion: preflight.installedVersion,
        reason:
          authentication.failure === 'timed-out'
            ? 'provider check timed out'
            : 'provider check failed',
        warnings: preflight.warnings,
      };
    }
    const authenticated = authenticationEvidence(definition.name, authentication);
    return {
      definition,
      installed: true,
      authenticated,
      parserSupported: true,
      ready: authenticated,
      installedVersion: preflight.installedVersion,
      reason: authenticated
        ? 'ready'
        : definition.name === 'pi'
          ? piStoredAuthGuidance(hasExcludedPiAmbientCredential(environment))
          : 'not logged in',
      warnings: preflight.warnings,
    };
  } catch {
    return { ...disabledStatus(definition, 'provider check failed'), installed: true };
  }
}

export async function deriveRepositoryMappings(
  clonePaths: readonly string[],
  options: { gitRunner?: GitRunner; baseDirectory?: string } = {},
): Promise<RawConfig['repositories']> {
  const runner = options.gitRunner ?? new NodeGitRunner();
  const baseDirectory = options.baseDirectory ?? process.cwd();
  const groups = new Map<string, string[]>();
  for (const configuredPath of clonePaths) {
    let clone: string;
    try {
      clone = canonicalExistingDirectory(configuredPath, baseDirectory);
    } catch {
      throw new SetupError(`Unable to inspect clone ${sanitizeTerminalText(configuredPath)}`);
    }
    let repository: string;
    try {
      const topLevelResult = await runner.run(clone, ['rev-parse', '--show-toplevel']);
      const reportedTopLevel = topLevelResult.stdout.toString('utf8').trim();
      if (reportedTopLevel.length === 0) throw new Error('Git returned no worktree top level');
      const topLevel = canonicalExistingDirectory(reportedTopLevel, clone);
      if (!samePath(topLevel, clone)) throw new Error('Clone is not the Git worktree top level');
      const result = await runner.run(clone, ['remote', 'get-url', 'origin']);
      repository = normalizeGitHubRepository(result.stdout.toString('utf8').trim());
    } catch {
      throw new SetupError(
        `Unable to derive a GitHub origin for clone ${sanitizeTerminalText(clone)}`,
      );
    }
    const clones = groups.get(repository) ?? [];
    if (clones.some((candidate) => samePath(candidate, clone))) {
      throw new SetupError(`Clone was provided more than once: ${sanitizeTerminalText(clone)}`);
    }
    clones.push(clone);
    groups.set(repository, clones);
  }
  if (groups.size === 0) throw new SetupError('At least one local Git clone is required');
  return [...groups].map(([repository, clones]) => ({ repository, clones }));
}

export function assessSetupConfiguration(
  configPath: string | undefined,
  raw: RawConfig,
): SetupConfigurationCandidate {
  const parsed = rawConfigSchema.parse(raw);
  if (!isIanaTimeZone(parsed.timeZone)) {
    throw new SetupError(`Invalid IANA time zone: ${sanitizeTerminalText(parsed.timeZone)}`);
  }
  const config = assessConfigTarget(configPath);
  const stateDirectory = assessStateDirectory(parsed.stateDirectory, {
    vaults: parsed.vaults,
    clones: parsed.repositories.flatMap((repository) => repository.clones),
    configParent: config.parent,
  });
  return {
    configPath: config.target,
    configParent: config.parent,
    stateDirectory,
    raw: { ...parsed, stateDirectory },
  };
}

export function publishSetupConfiguration(
  candidate: SetupConfigurationCandidate,
  dependencies: {
    createDocument?: (configPath: string | undefined, raw: RawConfig) => string;
  } = {},
): string {
  const createdDirectories: string[] = [];
  const stateDirectoryExisted = existsSync(candidate.stateDirectory);
  let originalStateMode: number | undefined;
  try {
    ensurePrivateDirectory(candidate.configParent, createdDirectories);
    ensurePrivateDirectory(candidate.stateDirectory, createdDirectories);

    const checked = assessSetupConfiguration(candidate.configPath, candidate.raw);
    if (
      !samePath(checked.configPath, candidate.configPath) ||
      !samePath(checked.stateDirectory, candidate.stateDirectory)
    ) {
      throw new SetupError('Setup paths changed after review; rerun setup safely');
    }
    if (process.platform !== 'win32') {
      if (stateDirectoryExisted) {
        originalStateMode = lstatSync(checked.stateDirectory).mode & 0o777;
      }
      chmodSync(checked.stateDirectory, 0o700);
    }
    return (dependencies.createDocument ?? createConfigDocument)(checked.configPath, checked.raw);
  } catch (error) {
    if (originalStateMode !== undefined) {
      try {
        chmodSync(candidate.stateDirectory, originalStateMode);
      } catch {
        // Preserve the publication failure; never broaden cleanup to an unknown path state.
      }
    }
    removeEmptyDirectories([...createdDirectories].reverse());
    throw error;
  }
}

export function defaultStateDirectory(): string {
  if (process.env.XDG_STATE_HOME) return path.join(process.env.XDG_STATE_HOME, 'mdspool');
  if (process.platform === 'darwin') {
    return resolveUserPath('~/Library/Application Support/mdspool-state');
  }
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'mdspool', 'state');
  }
  return resolveUserPath('~/.local/state/mdspool');
}

function authenticationEvidence(
  provider: BuiltinProviderName,
  result: ProviderProbeResult,
): boolean {
  const output = `${result.stdout}\n${result.stderr}`;
  if (provider === 'claude') {
    try {
      const parsed = JSON.parse(result.stdout) as { loggedIn?: unknown };
      return parsed.loggedIn === true;
    } catch {
      return false;
    }
  }
  if (provider === 'codex') {
    return /\blogged in\b/i.test(output) && !/\bnot logged in\b/i.test(output);
  }
  if (provider === 'pi') return hasPiModelRow(output);
  const account = /^User Email\s+(.+)$/im.exec(output)?.[1]?.trim();
  return Boolean(account && !/^not logged in$/i.test(account));
}

function disabledStatus(definition: ProviderSetupDefinition, reason: string): ProviderSetupStatus {
  return {
    definition,
    installed: false,
    authenticated: false,
    parserSupported: false,
    ready: false,
    installedVersion: null,
    reason,
    warnings: [],
  };
}

function runSetupCommand(
  executable: string,
  args: string[],
  options: ProviderProbeRunOptions,
): Promise<ProviderProbeResult> {
  return new Promise((resolve) => {
    const child = execFile(
      executable,
      args,
      {
        encoding: 'utf8',
        maxBuffer: 256 * 1024,
        timeout: options.timeoutMs,
        killSignal: 'SIGKILL',
        shell: false,
        windowsHide: true,
        ...(options.environment === undefined ? {} : { env: options.environment }),
      },
      (error, stdout, stderr) =>
        resolve({
          ok: error === null,
          stdout,
          stderr,
          ...(error === null
            ? {}
            : { failure: error.killed ? ('timed-out' as const) : ('failed' as const) }),
        }),
    );
    child.stdin?.end();
  });
}

function assertOwnedPrivateDirectory(uid: number, mode: number, target: string): void {
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (currentUid !== undefined && uid !== currentUid) {
    throw new SetupError(
      `State directory is not owned by the current user: ${sanitizeTerminalText(target)}`,
    );
  }
  if (process.platform !== 'win32' && (mode & 0o022) !== 0) {
    throw new SetupError(
      `State directory is writable by other users: ${sanitizeTerminalText(target)}`,
    );
  }
}

function missingDirectoryChain(target: string): string[] {
  const missing: string[] = [];
  let candidate = target;
  while (!existsSync(candidate)) {
    missing.push(candidate);
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return missing;
}

function assessStateDirectory(
  requestedPath: string,
  constraints: { vaults: readonly string[]; clones: readonly string[]; configParent: string },
): string {
  const resolved = resolveUserPath(requestedPath);
  let canonical: string;
  if (existsSync(resolved)) {
    const stats = lstatSync(resolved);
    if (stats.isSymbolicLink()) {
      throw new SetupError(
        `State path must not be a symbolic link: ${sanitizeTerminalText(resolved)}`,
      );
    }
    if (!stats.isDirectory()) {
      throw new SetupError(`State path is not a directory: ${sanitizeTerminalText(resolved)}`);
    }
    assertOwnedPrivateDirectory(stats.uid, stats.mode, resolved);
    if (readdirSync(resolved).length > 0) {
      throw new SetupError(`State directory must be empty: ${sanitizeTerminalText(resolved)}`);
    }
    canonical = realpathSync(resolved);
  } else {
    const missing = missingDirectoryChain(resolved);
    const highestMissing = missing.at(-1);
    const existingAncestor = highestMissing ? path.dirname(highestMissing) : path.dirname(resolved);
    const ancestorStats = lstatSync(existingAncestor);
    if (ancestorStats.isSymbolicLink() || !ancestorStats.isDirectory()) {
      throw new SetupError(
        `State path parent is not a safe directory: ${sanitizeTerminalText(existingAncestor)}`,
      );
    }
    canonical = path.resolve(
      realpathSync(existingAncestor),
      path.relative(existingAncestor, resolved),
    );
  }

  const restricted = [
    ...constraints.vaults.map((value) => canonicalExistingDirectory(value, process.cwd())),
    ...constraints.clones.map((value) => canonicalExistingDirectory(value, process.cwd())),
    resolveUserPath(constraints.configParent),
  ];
  if (restricted.some((value) => pathsOverlap(canonical, value))) {
    throw new SetupError(
      'State directory must not overlap a watched folder, clone, or config parent',
    );
  }
  return canonical;
}

function ensurePrivateDirectory(target: string, createdDirectories: string[]): void {
  for (const directory of [...missingDirectoryChain(target)].reverse()) {
    try {
      mkdirSync(directory, { mode: 0o700 });
      chmodSync(directory, 0o700);
      createdDirectories.push(directory);
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error;
    }
    const stats = lstatSync(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new SetupError(
        `Setup path is not a safe directory: ${sanitizeTerminalText(directory)}`,
      );
    }
    assertOwnedPrivateDirectory(stats.uid, stats.mode, directory);
  }
}

function removeEmptyDirectories(targets: readonly string[]): void {
  for (const target of targets) {
    try {
      rmdirSync(target);
    } catch {
      // Never remove a directory after anything else has started using it.
    }
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
