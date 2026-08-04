import {
  ClackSetupPrompter,
  PlainSetupPrompter,
  PromptCancelledError,
  type PromptOption,
  type SetupPrompter,
} from '../prompts.js';
import {
  collectProviderArgumentChoice,
  detectProviders,
  displayName,
  formatProviderArgumentReview,
  formatUnavailableProviders,
  showSelectedAgentWarnings,
} from '../provider-enrollment.js';
import { renderShellCommand, sanitizeTerminalText } from '../output.js';
import { addBuiltinProvider, readRawConfigDocument } from '../../config/document.js';
import type { RawConfig } from '../../config/schema.js';
import {
  mapSelectedProviders,
  providerSetupDefinitions,
  SetupError,
  type ProviderArgumentChoice,
  type ProviderProbeRunner,
  type ProviderSetupStatus,
} from '../../config/setup.js';
import type { BuiltinProviderName } from '../../providers/preflight.js';

type ConfigAgentNotAddedReason =
  'cancelled' | 'final-review-declined' | 'no-addable-agents' | 'no-ready-agents';

export interface ConfigAgentAddedResult {
  kind: 'added';
  provider: BuiltinProviderName;
  configPath: string;
}

export interface ConfigAgentNotAddedResult {
  kind: 'not-added';
  reason: ConfigAgentNotAddedReason;
}

export type ConfigAgentAddOutcome = ConfigAgentAddedResult | ConfigAgentNotAddedResult;

export interface RunConfigAgentAddOptions {
  configPath?: string;
  prompter?: SetupPrompter;
  plain?: boolean;
  commandRunner?: ProviderProbeRunner;
  pathValue?: string;
  environment?: NodeJS.ProcessEnv;
  isInteractive?: boolean;
}

export async function runConfigAgentAdd(
  options: RunConfigAgentAddOptions = {},
): Promise<ConfigAgentAddOutcome> {
  const document = readRawConfigDocument(options.configPath);
  if (
    options.prompter === undefined &&
    !(options.isInteractive ?? (process.stdin.isTTY && process.stdout.isTTY))
  ) {
    throw new SetupError('spool config agent add requires an interactive terminal');
  }

  const prompter =
    options.prompter ?? (options.plain ? new PlainSetupPrompter() : new ClackSetupPrompter());
  try {
    prompter.intro('spool agent setup');
    const eligible = providerSetupDefinitions.filter(
      (definition) => !document.raw.providers[definition.name]?.enabled,
    );
    const conflicts = eligible.flatMap((definition) => {
      const owner = directiveOwner(document.raw, definition.name, definition.directive);
      return owner === undefined ? [] : [{ definition, owner }];
    });
    for (const { definition, owner } of conflicts) {
      prompter.note(
        `${sanitizeTerminalText(definition.directive)} is already used by ${sanitizeTerminalText(owner)}. Change that provider directive before adding ${displayName(definition.name)}.`,
        'Directive conflict',
      );
    }
    const conflictNames = new Set(conflicts.map(({ definition }) => definition.name));
    const candidates = eligible.filter((definition) => !conflictNames.has(definition.name));
    if (candidates.length === 0) {
      prompter.outro(
        conflicts.length === 0
          ? 'Every supported coding agent is already enabled. Nothing was changed.'
          : 'No supported coding agent can be added until the directive conflict is resolved. Nothing was changed.',
      );
      return { kind: 'not-added', reason: 'no-addable-agents' };
    }

    let statuses = await detectProviders(prompter, {
      ...options,
      providerNames: candidates.map(({ name }) => name),
    });
    while (true) {
      if (!statuses.some((status) => status.ready)) {
        prompter.note(formatUnavailableProviders(statuses), 'Agents found');
        prompter.outro(
          'No addable coding agent is ready. Install or sign in to an available agent CLI, then retry. Nothing was changed.',
        );
        return { kind: 'not-added', reason: 'no-ready-agents' };
      }

      const selected = await selectAgent(prompter, statuses);
      const status = statuses.find(({ definition }) => definition.name === selected)!;
      const expectedTarget = document.raw.providers[selected];
      const choice = await collectProviderArgumentChoice(prompter, status.definition);
      showSelectedAgentWarnings(prompter, new Set([selected]));

      const [rechecked] = await detectProviders(
        prompter,
        { ...options, providerNames: [status.definition.name] },
        `Rechecking ${displayName(selected)}`,
      );
      if (!rechecked?.ready) {
        prompter.note(
          `${displayName(selected)} changed readiness. Review the updated agent list before continuing.`,
          'Agent status changed',
        );
        statuses = await detectProviders(prompter, {
          ...options,
          providerNames: candidates.map(({ name }) => name),
        });
        continue;
      }

      const reviewedProvider = mapSelectedProviders(
        [rechecked],
        new Set([selected]),
        new Map([[selected, choice]]),
      )[selected]!;
      prompter.note(
        formatReview(document.path, rechecked, expectedTarget, reviewedProvider, choice),
        'Review',
      );
      if (!(await prompter.confirm(`Add ${displayName(selected)} to this configuration?`, true))) {
        prompter.outro('Agent setup cancelled. Nothing was changed.');
        return { kind: 'not-added', reason: 'final-review-declined' };
      }

      try {
        addBuiltinProvider(document.path, selected, reviewedProvider, expectedTarget);
      } catch (error) {
        prompter.outro(
          'The agent was not added. Review the current configuration and retry; no partial provider update was kept.',
        );
        throw error;
      }
      prompter.outro(
        `Added ${displayName(selected)} to ${sanitizeTerminalText(document.path)}. Restart a running daemon to apply this change.`,
      );
      return { kind: 'added', provider: selected, configPath: document.path };
    }
  } catch (error) {
    if (error instanceof PromptCancelledError) {
      prompter.outro('Agent setup cancelled. Nothing was changed.');
      return { kind: 'not-added', reason: 'cancelled' };
    }
    throw error;
  } finally {
    prompter.close();
  }
}

async function selectAgent(
  prompter: SetupPrompter,
  statuses: readonly ProviderSetupStatus[],
): Promise<BuiltinProviderName> {
  const firstReady = statuses.find((status) => status.ready)!.definition.name;
  return prompter.select<BuiltinProviderName>(
    'Which agent should spool add?',
    statuses.map<PromptOption<BuiltinProviderName>>((status) => ({
      value: status.definition.name,
      label: displayName(status.definition.name),
      hint: status.ready
        ? `Ready${status.installedVersion ? ` · ${sanitizeTerminalText(status.installedVersion)}` : ''}`
        : sanitizeTerminalText(status.reason),
      disabled: !status.ready,
    })),
    firstReady,
  );
}

function formatReview(
  configPath: string,
  status: ProviderSetupStatus,
  previous: RawConfig['providers'][string] | undefined,
  reviewed: RawConfig['providers'][string],
  choice: ProviderArgumentChoice,
): string {
  const selected = new Set([status.definition.name]);
  const providers = { [status.definition.name]: reviewed };
  return [
    `Change: ${previous === undefined ? `Add ${displayName(status.definition.name)}` : `Replace disabled ${displayName(status.definition.name)} configuration`}`,
    ...(previous === undefined
      ? ['Before: (missing)']
      : [
          'Before:',
          `  Enabled: ${String(previous.enabled)}`,
          `  Executable: ${sanitizeTerminalText(previous.executable)}`,
          `  Directive: ${sanitizeTerminalText(previous.directive ?? `@${status.definition.name}`)}`,
          `  Default arguments: ${formatArguments(previous.defaultArgs)}`,
        ]),
    'After:',
    `  Enabled: ${String(reviewed.enabled)}`,
    `  Executable: ${sanitizeTerminalText(reviewed.executable)}`,
    `  Directive: ${sanitizeTerminalText(reviewed.directive ?? `@${status.definition.name}`)}`,
    `  Default arguments: ${formatArguments(reviewed.defaultArgs)}`,
    ...formatProviderArgumentReview(
      providers,
      [status],
      selected,
      new Map([[status.definition.name, choice]]),
    ),
    ...(status.warnings.length === 0
      ? []
      : [`Warnings: ${status.warnings.map(sanitizeTerminalText).join('; ')}`]),
    `Configuration: ${sanitizeTerminalText(configPath)}`,
    'Activation: Restart a running daemon after this change.',
  ].join('\n');
}

function formatArguments(args: readonly string[]): string {
  return args.length === 0 ? '(none)' : renderShellCommand(args);
}

function directiveOwner(
  raw: RawConfig,
  target: BuiltinProviderName,
  directive: string,
): string | undefined {
  const identity = directive.toLowerCase();
  return Object.entries(raw.providers).find(
    ([name, provider]) =>
      name !== target && (provider.directive ?? `@${name}`).toLowerCase() === identity,
  )?.[0];
}
