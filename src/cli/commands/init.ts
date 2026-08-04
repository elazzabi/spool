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
import {
  detectProviders,
  displayName,
  formatAgentStatusSummary,
  formatProviderArgumentReview,
  formatUnavailableProviders,
  reconcileProviderArgumentChoices,
  showRetryNote,
  showSelectedAgentWarnings,
} from '../provider-enrollment.js';
import { ConfigDocumentError } from '../../config/document.js';
import { loadConfig } from '../../config/load.js';
import { canonicalExistingDirectory, resolveConfigPath, samePath } from '../../config/paths.js';
import { isIanaTimeZone, type RawConfig } from '../../config/schema.js';
import type { BuiltinProviderName } from '../../providers/preflight.js';
import {
  assessSetupConfiguration,
  defaultStateDirectory,
  deriveRepositoryMappings,
  mapSelectedProviders,
  publishSetupConfiguration,
  SetupError,
  type ProviderArgumentChoice,
  type ProviderSetupStatus,
  type SetupConfigurationCandidate,
} from '../../config/setup.js';
import type { GitRunner } from '../../workspaces/git.js';

type SetupMode = 'quickstart' | 'advanced';
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
    prompter.intro('spool setup');
    prompter.note(
      'Choose the local agents spool may run. Authentication stays with each agent CLI.',
      'Welcome',
    );
    const mode = await prompter.select<SetupMode>(
      'How would you like to set up spool?',
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
        { ...options, providerNames: [...selected] },
        'Rechecking selected agents',
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
    'Add another supported coding agent with:',
    `  ${renderShellCommand(spoolArgv(config, 'config', 'agent', 'add'))}`,
    '',
    'For polling, time zone, or state storage, edit this YAML file directly.',
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
    'Start spool with:',
    `  ${result.daemonCommand}`,
  ].join('\n');
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
      'Which agents should spool enable?',
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
        showRetryNote(prompter, error);
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
    'Choose an existing project folder on this computer. It must be a Git checkout with a GitHub origin. spool makes the folder available to selected agents; it does not clone repositories or clean local changes.',
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
    showRetryNote(
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
    showRetryNote(prompter, new SetupError('Polling interval must be a whole number from 1 to 45'));
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
      showRetryNote(prompter, error);
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
    ...formatProviderArgumentReview(candidate.raw.providers, statuses, selected, argumentChoices),
    `Watched folders: ${candidate.raw.vaults.map(sanitizeTerminalText).join(', ')}`,
    `Git repositories: ${candidate.raw.repositories.map((repository) => sanitizeTerminalText(repository.repository)).join(', ')}`,
    `Time zone: ${sanitizeTerminalText(candidate.raw.timeZone)}`,
    `Polling: ${String(candidate.raw.pollIntervalSeconds)} seconds`,
    `State: ${sanitizeTerminalText(candidate.stateDirectory)}`,
    `Configuration: ${sanitizeTerminalText(candidate.configPath)}`,
    ...(warnings.length === 0 ? [] : [`Warnings: ${warnings.join('; ')}`]),
  ].join('\n');
}

function finishWithoutReadyAgent(
  prompter: SetupPrompter,
  statuses: readonly ProviderSetupStatus[],
): InitNotCreatedResult {
  prompter.note(formatUnavailableProviders(statuses), 'Agents found');
  prompter.outro(noAgentRecoveryMessage());
  return { kind: 'not-created', reason: 'no-ready-agents' };
}

function noAgentRecoveryMessage(): string {
  return 'No configuration was written. Install or sign in to at least one supported agent CLI, then rerun spool init.';
}

function detectedTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}
