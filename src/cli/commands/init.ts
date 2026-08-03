import { existsSync } from 'node:fs';

import type { DoctorCommandRunner, DoctorReport } from './doctor.js';
import { collectDoctorReport, formatDoctorReport } from './doctor.js';
import { renderShellCommand, sanitizeTerminalText, spoolArgv } from '../output.js';
import {
  ClackSetupPrompter,
  PlainSetupPrompter,
  PromptCancelledError,
  type PromptOption,
  type SetupPrompter,
} from '../prompts.js';
import { ConfigDocumentError } from '../../config/document.js';
import { loadConfig } from '../../config/load.js';
import { canonicalExistingDirectory, resolveConfigPath, samePath } from '../../config/paths.js';
import { isIanaTimeZone, type RawConfig } from '../../config/schema.js';
import type { BuiltinProviderName } from '../../providers/preflight.js';
import {
  assertProviderArgumentChoice,
  assessSetupConfiguration,
  defaultStateDirectory,
  deriveRepositoryMappings,
  detectBuiltinProviders,
  mapSelectedProviders,
  publishSetupConfiguration,
  SetupError,
  type ProviderAccessProfile,
  type ProviderArgumentChoice,
  type ProviderSetupDefinition,
  type ProviderSetupStatus,
  type SetupConfigurationCandidate,
} from '../../config/setup.js';
import type { GitRunner } from '../../workspaces/git.js';

type SetupMode = 'quickstart' | 'advanced';
type AdditionalArgumentChoice = 'none' | 'add';
type NotCreatedReason =
  'cancelled' | 'final-review-declined' | 'no-agents-selected' | 'no-ready-agents';

export interface InitResult {
  kind: 'created';
  configPath: string;
  stateDirectory: string;
  watchedFolders: string[];
  repositories: RawConfig['repositories'];
  providerStatuses: ProviderSetupStatus[];
  doctor: DoctorReport;
  daemonCommand: string;
}

export interface InitNotCreatedResult {
  kind: 'not-created';
  reason: NotCreatedReason;
}

export type InitOutcome = InitResult | InitNotCreatedResult;

export interface RunInitOptions {
  configPath?: string;
  prompter?: SetupPrompter;
  plain?: boolean;
  commandRunner?: DoctorCommandRunner;
  gitRunner?: GitRunner;
  pathValue?: string;
  isInteractive?: boolean;
  defaultStatePath?: string;
  publishConfiguration?: (candidate: SetupConfigurationCandidate) => string;
  environment?: NodeJS.ProcessEnv;
}

export async function runInit(options: RunInitOptions = {}): Promise<InitOutcome> {
  const configPath = resolveConfigPath(options.configPath);
  if (existsSync(configPath)) {
    throw new ConfigDocumentError(existingConfigurationMessage(configPath));
  }
  if (
    options.prompter === undefined &&
    !(options.isInteractive ?? (process.stdin.isTTY && process.stdout.isTTY))
  ) {
    throw new SetupError('spool init requires an interactive terminal');
  }

  const prompter =
    options.prompter ?? (options.plain ? new PlainSetupPrompter() : new ClackSetupPrompter());
  try {
    prompter.intro('MDSpool setup');
    prompter.note(
      'Choose the local agents MDSpool may run. Authentication stays with each agent CLI.',
      'Welcome',
    );
    const mode = await prompter.select<SetupMode>(
      'How would you like to set up MDSpool?',
      [
        { value: 'quickstart', label: 'QuickStart', hint: 'Recommended defaults' },
        { value: 'advanced', label: 'Advanced', hint: 'Customize storage and polling' },
      ],
      'quickstart',
    );

    let providerStatuses = await detectProviders(prompter, options);
    if (!providerStatuses.some((status) => status.ready)) {
      return finishWithoutReadyAgent(prompter, providerStatuses);
    }

    let selected = await selectAgents(prompter, providerStatuses);
    if (selected === null) {
      prompter.outro(noAgentRecoveryMessage());
      return { kind: 'not-created', reason: 'no-agents-selected' };
    }
    showSelectedAgentWarnings(prompter, selected);
    const argumentChoices = new Map<BuiltinProviderName, ProviderArgumentChoice>();
    await reconcileProviderArgumentChoices(prompter, providerStatuses, selected, argumentChoices);

    const watchedFolders = await collectDirectories(
      prompter,
      'Obsidian or Markdown folder to watch',
      'Add another watched folder?',
    );
    const repositories = await collectRepositories(prompter, options.gitRunner);

    const settings =
      mode === 'advanced'
        ? await collectAdvancedSettings(prompter, options.defaultStatePath)
        : {
            timeZone: detectedTimeZone(),
            pollIntervalSeconds: 30,
            stateDirectory: options.defaultStatePath ?? defaultStateDirectory(),
          };

    while (true) {
      const refreshedStatuses = await detectProviders(
        prompter,
        options,
        'Rechecking selected agents',
        [...selected],
      );
      const latestStatuses = providerStatuses.map(
        (status) =>
          refreshedStatuses.find(
            (refreshed) => refreshed.definition.name === status.definition.name,
          ) ?? status,
      );
      const noLongerReady = [...selected].filter(
        (name) => !latestStatuses.find((status) => status.definition.name === name)?.ready,
      );
      providerStatuses = latestStatuses;
      if (noLongerReady.length > 0) {
        prompter.note(
          `${noLongerReady.map(displayName).join(', ')} changed readiness. Review the updated agent list before continuing.`,
          'Agent status changed',
        );
        if (!providerStatuses.some((status) => status.ready)) {
          return finishWithoutReadyAgent(prompter, providerStatuses);
        }
        const reselection = await selectAgents(
          prompter,
          providerStatuses,
          [...selected].filter((name) =>
            providerStatuses.some((status) => status.definition.name === name && status.ready),
          ),
        );
        if (reselection === null) {
          prompter.outro(noAgentRecoveryMessage());
          return { kind: 'not-created', reason: 'no-agents-selected' };
        }
        selected = reselection;
        showSelectedAgentWarnings(prompter, selected);
        await reconcileProviderArgumentChoices(
          prompter,
          providerStatuses,
          selected,
          argumentChoices,
        );
        continue;
      }

      const providers = mapSelectedProviders(providerStatuses, selected, argumentChoices);
      const candidate = await assessCandidate(prompter, configPath, {
        vaults: watchedFolders,
        stateDirectory: settings.stateDirectory,
        timeZone: settings.timeZone,
        pollIntervalSeconds: settings.pollIntervalSeconds,
        dayAliases: {},
        providers,
        repositories,
      });
      prompter.note(
        formatSetupReview(mode, candidate, providerStatuses, selected, argumentChoices),
        'Review',
      );
      if (!(await prompter.confirm('Create this configuration?', true))) {
        prompter.outro('Setup cancelled. Nothing was written.');
        return { kind: 'not-created', reason: 'final-review-declined' };
      }

      try {
        (options.publishConfiguration ?? publishSetupConfiguration)(candidate);
      } catch (error) {
        prompter.outro(
          'Setup could not publish the configuration. Nothing partial was kept; fix the issue and rerun spool init.',
        );
        throw error;
      }

      const config = loadConfig(candidate.configPath, {
        ...(options.pathValue === undefined ? {} : { pathValue: options.pathValue }),
      });
      const doctor = await collectDoctorReport(config, {
        ...(options.commandRunner === undefined ? {} : { commandRunner: options.commandRunner }),
        ...(options.environment === undefined ? {} : { environment: options.environment }),
      });
      const result: InitResult = {
        kind: 'created',
        configPath: config.configPath,
        stateDirectory: config.stateDirectory,
        watchedFolders: config.vaults,
        repositories,
        providerStatuses,
        doctor,
        daemonCommand: renderShellCommand(
          options.configPath === undefined ? ['spool', 'daemon'] : spoolArgv(config, 'daemon'),
        ),
      };
      prompter.outro(formatInitResult(result));
      return result;
    }
  } catch (error) {
    if (error instanceof PromptCancelledError) {
      prompter.outro('Setup cancelled. Nothing was written.');
      return { kind: 'not-created', reason: 'cancelled' };
    }
    throw error;
  } finally {
    prompter.close();
  }
}

function existingConfigurationMessage(configPath: string): string {
  const config = { configPath };
  return [
    `Configuration already exists at ${configPath}.`,
    'spool init only creates the first configuration; it cannot continue or update an existing setup.',
    '',
    'Inspect it with:',
    `  ${renderShellCommand(spoolArgv(config, 'config', 'show'))}`,
    '',
    'Change watched folders or repositories with:',
    `  ${renderShellCommand(spoolArgv(config, 'config', 'watch', '--help'))}`,
    `  ${renderShellCommand(spoolArgv(config, 'config', 'repository', '--help'))}`,
    '',
    'For providers, polling, time zone, or state storage, edit this YAML file directly.',
    'To start over or recover an unusable configuration, move this file aside and run spool init again.',
    'If the daemon is running, restart it after changes.',
  ].join('\n');
}

export function formatInitResult(result: InitResult): string {
  const enabled = new Set(
    result.doctor.providers.filter((provider) => provider.enabled).map((provider) => provider.name),
  );
  return [
    result.doctor.ok ? 'Setup complete.' : 'Setup complete; provider diagnostics need attention.',
    `Configuration: ${sanitizeTerminalText(result.configPath)}`,
    `Watching: ${result.watchedFolders.map(sanitizeTerminalText).join(', ')}`,
    '',
    ...formatAgentStatusSummary(result.providerStatuses, enabled),
    '',
    formatDoctorReport(result.doctor),
    '',
    'Start MDSpool with:',
    `  ${result.daemonCommand}`,
  ].join('\n');
}

async function detectProviders(
  prompter: SetupPrompter,
  options: RunInitOptions,
  message = 'Checking Claude, Codex, Cursor, and Pi',
  providerNames?: readonly BuiltinProviderName[],
): Promise<ProviderSetupStatus[]> {
  return prompter.progress(
    message,
    () =>
      detectBuiltinProviders({
        ...(options.commandRunner === undefined ? {} : { commandRunner: options.commandRunner }),
        ...(options.pathValue === undefined ? {} : { pathValue: options.pathValue }),
        ...(providerNames === undefined ? {} : { providerNames }),
        ...(options.environment === undefined ? {} : { environment: options.environment }),
      }),
    'Agent check complete',
  );
}

async function selectAgents(
  prompter: SetupPrompter,
  statuses: readonly ProviderSetupStatus[],
  initialValues: readonly BuiltinProviderName[] = statuses
    .filter((status) => status.ready)
    .map((status) => status.definition.name),
): Promise<Set<BuiltinProviderName> | null> {
  let initial = initialValues;
  while (true) {
    const selected = await prompter.multiselect(
      'Which agents should MDSpool enable?',
      statuses.map<PromptOption<BuiltinProviderName>>((status) => ({
        value: status.definition.name,
        label: displayName(status.definition.name),
        hint: status.ready
          ? `Ready${status.installedVersion ? ` · ${sanitizeTerminalText(status.installedVersion)}` : ''}`
          : sanitizeTerminalText(status.reason),
        disabled: !status.ready,
      })),
      initial,
    );
    if (selected.length > 0) return new Set(selected);
    if (await prompter.confirm('Exit without creating a configuration?', false)) return null;
    initial = [];
  }
}

async function collectDirectories(
  prompter: SetupPrompter,
  firstQuestion: string,
  continueQuestion: string,
  validate?: (directory: string) => Promise<void>,
): Promise<string[]> {
  const directories: string[] = [];
  do {
    while (true) {
      const answer = await prompter.text(firstQuestion);
      try {
        if (!answer) throw new SetupError(`${firstQuestion} is required`);
        const canonical = canonicalExistingDirectory(answer, process.cwd());
        if (directories.some((directory) => samePath(directory, canonical))) {
          throw new SetupError(
            `Directory was provided more than once: ${sanitizeTerminalText(canonical)}`,
          );
        }
        await validate?.(canonical);
        directories.push(canonical);
        break;
      } catch (error) {
        retryNote(prompter, error);
      }
    }
  } while (await prompter.confirm(continueQuestion, false));
  return directories;
}

async function collectRepositories(
  prompter: SetupPrompter,
  gitRunner?: GitRunner,
): Promise<RawConfig['repositories']> {
  const repositories: RawConfig['repositories'] = [];
  prompter.note(
    'Choose an existing project folder on this computer. It must be a Git checkout with a GitHub origin. MDSpool makes the folder available to selected agents; it does not clone repositories or clean local changes.',
    'Agent workspace',
  );
  await collectDirectories(
    prompter,
    'Project folder agents may work in',
    'Add another project folder?',
    async (clone) => {
      const [mapping] = await deriveRepositoryMappings([clone], {
        ...(gitRunner === undefined ? {} : { gitRunner }),
      });
      if (!mapping) throw new SetupError(`Unable to map Git clone ${sanitizeTerminalText(clone)}`);
      const existing = repositories.find(
        (repository) => repository.repository === mapping.repository,
      );
      if (existing) existing.clones.push(...mapping.clones);
      else repositories.push(mapping);
    },
  );
  return repositories;
}

async function reconcileProviderArgumentChoices(
  prompter: SetupPrompter,
  statuses: readonly ProviderSetupStatus[],
  selected: ReadonlySet<BuiltinProviderName>,
  choices: Map<BuiltinProviderName, ProviderArgumentChoice>,
): Promise<void> {
  for (const name of choices.keys()) {
    if (!selected.has(name)) choices.delete(name);
  }
  for (const status of statuses) {
    const { definition } = status;
    if (!status.ready || !selected.has(definition.name) || choices.has(definition.name)) continue;
    choices.set(definition.name, await collectProviderArgumentChoice(prompter, definition));
  }
}

async function collectProviderArgumentChoice(
  prompter: SetupPrompter,
  definition: ProviderSetupDefinition,
): Promise<ProviderArgumentChoice> {
  let profile: ProviderAccessProfile;
  while (true) {
    const unrestricted = definition.access.unrestricted;
    profile = await prompter.select<ProviderAccessProfile>(
      `${displayName(definition.name)} access profile`,
      [
        {
          value: 'recommended',
          label: 'Recommended',
          hint: definition.access.recommendedDescription,
        },
        ...(unrestricted === undefined
          ? []
          : [
              {
                value: 'unrestricted' as const,
                label: unrestricted.label,
                hint: unrestricted.warning,
              },
            ]),
        {
          value: 'custom-only',
          label: 'Custom only',
          hint: definition.access.customOnlyDescription,
        },
      ],
      'recommended',
    );
    if (profile !== 'unrestricted' || unrestricted === undefined) break;
    prompter.note(unrestricted.warning, `${displayName(definition.name)} unrestricted access`);
    if (await prompter.confirm(`${unrestricted.warning} Continue?`, false)) break;
  }

  const addArguments = await prompter.select<AdditionalArgumentChoice>(
    `Additional arguments for ${displayName(definition.name)}?`,
    [
      { value: 'none', label: 'No additional arguments' },
      { value: 'add', label: 'Add literal argv entries' },
    ],
    'none',
  );
  const extraArgs: string[] = [];
  if (addArguments === 'add') {
    prompter.note(
      'Each response becomes one literal argv entry and is never parsed as a shell command. Custom arguments can broaden file, process, network, tool, plugin, or configuration access. They apply to launches and inspect/resume commands; the provider validates their meaning.',
      'Custom argument safety',
    );
    while (true) {
      const argument = await prompter.text(
        `Next literal argument for ${displayName(definition.name)} (leave empty to finish)`,
        '',
      );
      if (argument.length === 0) break;
      try {
        const next = [...extraArgs, argument];
        assertProviderArgumentChoice(definition, { profile, extraArgs: next });
        extraArgs.push(argument);
      } catch (error) {
        retryNote(prompter, error);
      }
    }
  }
  const choice = { profile, extraArgs } satisfies ProviderArgumentChoice;
  assertProviderArgumentChoice(definition, choice);
  return choice;
}

async function collectAdvancedSettings(
  prompter: SetupPrompter,
  defaultStatePath?: string,
): Promise<{ timeZone: string; pollIntervalSeconds: number; stateDirectory: string }> {
  const timeZone = await askTimeZone(prompter);
  const pollIntervalSeconds = await askPollInterval(prompter);
  const stateDirectory = await prompter.text(
    'State directory',
    defaultStatePath ?? defaultStateDirectory(),
  );
  return { timeZone, pollIntervalSeconds, stateDirectory };
}

async function askTimeZone(prompter: SetupPrompter): Promise<string> {
  while (true) {
    const timeZone = await prompter.text('IANA time zone', detectedTimeZone());
    if (isIanaTimeZone(timeZone)) return timeZone;
    retryNote(
      prompter,
      new SetupError(`Invalid IANA time zone: ${sanitizeTerminalText(timeZone)}`),
    );
  }
}

async function askPollInterval(prompter: SetupPrompter): Promise<number> {
  while (true) {
    const answer = await prompter.text('Polling interval in seconds (1-45)', '30');
    const value = Number(answer);
    if (Number.isInteger(value) && value >= 1 && value <= 45) return value;
    retryNote(prompter, new SetupError('Polling interval must be a whole number from 1 to 45'));
  }
}

async function assessCandidate(
  prompter: SetupPrompter,
  configPath: string,
  raw: RawConfig,
): Promise<SetupConfigurationCandidate> {
  let stateDirectory = raw.stateDirectory;
  while (true) {
    try {
      return assessSetupConfiguration(configPath, { ...raw, stateDirectory });
    } catch (error) {
      if (!(error instanceof SetupError) || !/state/i.test(error.message)) throw error;
      retryNote(prompter, error);
      stateDirectory = await prompter.text('State directory', stateDirectory);
    }
  }
}

function formatSetupReview(
  mode: SetupMode,
  candidate: SetupConfigurationCandidate,
  statuses: readonly ProviderSetupStatus[],
  selected: ReadonlySet<string>,
  argumentChoices: ReadonlyMap<string, ProviderArgumentChoice>,
): string {
  const warnings = statuses
    .filter((status) => selected.has(status.definition.name))
    .flatMap((status) => status.warnings.map(sanitizeTerminalText));
  return [
    `Mode: ${mode === 'quickstart' ? 'QuickStart' : 'Advanced'}`,
    ...formatAgentStatusSummary(statuses, selected),
    ...formatProviderArgumentReview(candidate, statuses, selected, argumentChoices),
    `Watched folders: ${candidate.raw.vaults.map(sanitizeTerminalText).join(', ')}`,
    `Git repositories: ${candidate.raw.repositories.map((repository) => sanitizeTerminalText(repository.repository)).join(', ')}`,
    `Time zone: ${sanitizeTerminalText(candidate.raw.timeZone)}`,
    `Polling: ${String(candidate.raw.pollIntervalSeconds)} seconds`,
    `State: ${sanitizeTerminalText(candidate.stateDirectory)}`,
    `Configuration: ${sanitizeTerminalText(candidate.configPath)}`,
    ...(warnings.length === 0 ? [] : [`Warnings: ${warnings.join('; ')}`]),
  ].join('\n');
}

function formatProviderArgumentReview(
  candidate: SetupConfigurationCandidate,
  statuses: readonly ProviderSetupStatus[],
  selected: ReadonlySet<string>,
  argumentChoices: ReadonlyMap<string, ProviderArgumentChoice>,
): string[] {
  const lines: string[] = [];
  for (const status of statuses) {
    const { definition } = status;
    if (!selected.has(definition.name)) continue;
    const profile = argumentChoices.get(definition.name)?.profile ?? 'recommended';
    const configuredArgs = candidate.raw.providers[definition.name]?.defaultArgs ?? [];
    lines.push(
      `${displayName(definition.name)} [${profile === 'custom-only' ? 'CUSTOM ONLY' : profile.toUpperCase()}]`,
      `  Configured defaultArgs: ${configuredArgs.length === 0 ? '(none)' : renderShellCommand(configuredArgs)}`,
      `  Adapter-enforced: ${definition.adapterOwnedArgs.map(sanitizeTerminalText).join(', ')}`,
    );
  }
  return lines;
}

function showSelectedAgentWarnings(
  prompter: SetupPrompter,
  selected: ReadonlySet<BuiltinProviderName>,
): void {
  if (!selected.has('pi')) return;
  prompter.note(
    'Pi is configured for file review with read, grep, find, and ls only. This is not an OS sandbox: Pi can read and send any host-readable file, including through absolute or parent-traversal paths, and it cannot inspect a Git diff with these defaults. Enable Pi only on a trusted machine and repository.',
    'Pi access limits',
  );
}

function formatAgentStatusSummary(
  statuses: readonly ProviderSetupStatus[],
  selected: ReadonlySet<string>,
): string[] {
  const enabled = statuses.filter((status) => selected.has(status.definition.name));
  const disabled = statuses.filter(
    (status) => status.ready && !selected.has(status.definition.name),
  );
  const unavailable = statuses.filter((status) => !status.ready);
  return [
    `Enabled: ${formatAgentNames(enabled)}`,
    `Intentionally disabled: ${formatAgentNames(disabled)}`,
    `Unavailable: ${formatUnavailable(unavailable)}`,
  ];
}

function finishWithoutReadyAgent(
  prompter: SetupPrompter,
  statuses: readonly ProviderSetupStatus[],
): InitNotCreatedResult {
  prompter.note(formatUnavailable(statuses), 'Agents found');
  prompter.outro(noAgentRecoveryMessage());
  return { kind: 'not-created', reason: 'no-ready-agents' };
}

function formatAgentNames(statuses: readonly ProviderSetupStatus[]): string {
  return statuses.length === 0
    ? 'None'
    : statuses.map((status) => displayName(status.definition.name)).join(', ');
}

function formatUnavailable(statuses: readonly ProviderSetupStatus[]): string {
  return statuses.length === 0
    ? 'None'
    : statuses
        .map(
          (status) =>
            `${displayName(status.definition.name)} (${sanitizeTerminalText(status.reason)})`,
        )
        .join(', ');
}

function noAgentRecoveryMessage(): string {
  return 'No configuration was written. Install or sign in to at least one supported agent CLI, then rerun spool init.';
}

function displayName(name: string): string {
  const safe = sanitizeTerminalText(name);
  return `${safe.charAt(0).toUpperCase()}${safe.slice(1)}`;
}

function retryNote(prompter: SetupPrompter, error: unknown): void {
  const detail = sanitizeTerminalText(error instanceof Error ? error.message : String(error));
  prompter.note(`${detail}. Please try again.`, 'Check this value');
}

function detectedTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}
