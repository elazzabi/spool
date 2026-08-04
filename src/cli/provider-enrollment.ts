import { renderShellCommand, sanitizeTerminalText } from './output.js';
import type { SetupPrompter } from './prompts.js';
import type { RawConfig } from '../config/schema.js';
import type { BuiltinProviderName } from '../providers/preflight.js';
import {
  assertProviderArgumentChoice,
  detectBuiltinProviders,
  type ProviderAccessProfile,
  type ProviderArgumentChoice,
  type ProviderProbeRunner,
  type ProviderSetupDefinition,
  type ProviderSetupStatus,
} from '../config/setup.js';

type AdditionalArgumentChoice = 'none' | 'add';

export interface ProviderDetectionOptions {
  commandRunner?: ProviderProbeRunner;
  pathValue?: string;
  providerNames?: readonly BuiltinProviderName[];
  environment?: NodeJS.ProcessEnv;
}

export async function detectProviders(
  prompter: SetupPrompter,
  options: ProviderDetectionOptions,
  message = 'Checking Claude, Codex, Cursor, and Pi',
): Promise<ProviderSetupStatus[]> {
  return prompter.progress(
    message,
    () =>
      detectBuiltinProviders({
        ...(options.commandRunner === undefined ? {} : { commandRunner: options.commandRunner }),
        ...(options.pathValue === undefined ? {} : { pathValue: options.pathValue }),
        ...(options.providerNames === undefined ? {} : { providerNames: options.providerNames }),
        ...(options.environment === undefined ? {} : { environment: options.environment }),
      }),
    'Agent check complete',
  );
}

export async function reconcileProviderArgumentChoices(
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

export async function collectProviderArgumentChoice(
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
        showRetryNote(prompter, error);
      }
    }
  }
  const choice = { profile, extraArgs } satisfies ProviderArgumentChoice;
  assertProviderArgumentChoice(definition, choice);
  return choice;
}

export function formatProviderArgumentReview(
  providers: RawConfig['providers'],
  statuses: readonly ProviderSetupStatus[],
  selected: ReadonlySet<string>,
  argumentChoices: ReadonlyMap<string, ProviderArgumentChoice>,
): string[] {
  const lines: string[] = [];
  for (const status of statuses) {
    const { definition } = status;
    if (!selected.has(definition.name)) continue;
    const profile = argumentChoices.get(definition.name)?.profile ?? 'recommended';
    const configuredArgs = providers[definition.name]?.defaultArgs ?? [];
    lines.push(
      `${displayName(definition.name)} [${profile === 'custom-only' ? 'CUSTOM ONLY' : profile.toUpperCase()}]`,
      `  Configured defaultArgs: ${configuredArgs.length === 0 ? '(none)' : renderShellCommand(configuredArgs)}`,
      `  Adapter-enforced: ${definition.adapterOwnedArgs.map(sanitizeTerminalText).join(', ')}`,
    );
  }
  return lines;
}

export function showSelectedAgentWarnings(
  prompter: SetupPrompter,
  selected: ReadonlySet<BuiltinProviderName>,
): void {
  if (!selected.has('pi')) return;
  prompter.note(
    'Pi is configured for file review with read, grep, find, and ls only. This is not an OS sandbox: Pi can read and send any host-readable file, including through absolute or parent-traversal paths, and it cannot inspect a Git diff with these defaults. Enable Pi only on a trusted machine and repository.',
    'Pi access limits',
  );
}

export function formatAgentStatusSummary(
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
    `Unavailable: ${formatUnavailableProviders(unavailable)}`,
  ];
}

export function formatUnavailableProviders(statuses: readonly ProviderSetupStatus[]): string {
  return statuses.length === 0
    ? 'None'
    : statuses
        .map(
          (status) =>
            `${displayName(status.definition.name)} (${sanitizeTerminalText(status.reason)})`,
        )
        .join(', ');
}

export function displayName(name: string): string {
  const safe = sanitizeTerminalText(name);
  return `${safe.charAt(0).toUpperCase()}${safe.slice(1)}`;
}

export function showRetryNote(prompter: SetupPrompter, error: unknown): void {
  const detail = sanitizeTerminalText(error instanceof Error ? error.message : String(error));
  prompter.note(`${detail}. Please try again.`, 'Check this value');
}

function formatAgentNames(statuses: readonly ProviderSetupStatus[]): string {
  return statuses.length === 0
    ? 'None'
    : statuses.map((status) => displayName(status.definition.name)).join(', ');
}
