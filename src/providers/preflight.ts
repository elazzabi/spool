import type { ProviderCapabilities } from './types.js';

export type BuiltinProviderName = 'claude' | 'codex' | 'cursor' | 'pi';
export type ProviderPreflightStatus = 'supported' | 'warning' | 'unsupported';

export interface BuiltinProviderPreflight {
  readonly provider: BuiltinProviderName;
  readonly expectedVersion: string;
  readonly installedVersion: string | null;
  readonly status: ProviderPreflightStatus;
  readonly parserSupported: boolean;
  readonly capabilities: ProviderCapabilities;
  readonly warnings: readonly string[];
}

export interface BuiltinProviderPreflightInput {
  readonly provider: BuiltinProviderName;
  readonly versionOutput: string;
  readonly probe: { readonly ok: boolean; readonly output: string };
}

const validatedBaselineVersions: Record<BuiltinProviderName, string> = {
  claude: '2.1.212',
  codex: '0.144.5',
  cursor: '2026.01.28-fd13201',
  pi: '0.74.2',
};

const noCapabilities: ProviderCapabilities = {
  launch: false,
  observe: false,
  inspect: false,
  resume: false,
  cancel: false,
  needsInput: false,
};

export function evaluateBuiltinProviderPreflight(
  input: BuiltinProviderPreflightInput,
): BuiltinProviderPreflight {
  const expectedVersion = validatedBaselineVersions[input.provider];
  const installedVersion = parseVersion(input.provider, input.versionOutput);
  const warnings: string[] = [];
  let status: ProviderPreflightStatus = 'supported';
  let parserSupported = true;

  if (!installedVersion) {
    status = 'unsupported';
    parserSupported = false;
    warnings.push(`Could not parse the ${input.provider} version`);
  } else if (installedVersion !== expectedVersion) {
    status = 'warning';
    warnings.push(
      `${input.provider} ${installedVersion} differs from validated baseline ${expectedVersion}; continuing with the detected machine contract`,
    );
  }

  const probeReason = validateProbe(input.provider, input.probe);
  if (probeReason) {
    status = 'unsupported';
    parserSupported = false;
    warnings.unshift(probeReason);
  }

  const capabilities = parserSupported ? capabilitiesFor() : noCapabilities;
  if (input.provider === 'claude' && parserSupported && !capabilities.needsInput) {
    warnings.push(
      'Claude foreground print events lack distinct replayable needs-input episodes; Needs input is disabled',
    );
  }
  return Object.freeze({
    provider: input.provider,
    expectedVersion,
    installedVersion,
    status,
    parserSupported,
    capabilities: Object.freeze({ ...capabilities }),
    warnings: Object.freeze(warnings),
  });
}

export function assertBuiltinParserSupported(
  preflight: BuiltinProviderPreflight,
  provider: BuiltinProviderName,
): void {
  if (preflight.provider !== provider) {
    throw new Error(`Expected ${provider} preflight, received ${preflight.provider}`);
  }
  if (!preflight.parserSupported) {
    throw new Error(
      `${provider} ${preflight.installedVersion ?? 'unknown'} does not expose a supported machine contract`,
    );
  }
}

export function expectedBuiltinProviderVersion(provider: BuiltinProviderName): string {
  return validatedBaselineVersions[provider];
}

export function builtinProviderName(value: string): BuiltinProviderName | null {
  const normalized = value.toLowerCase();
  return normalized === 'claude' ||
    normalized === 'codex' ||
    normalized === 'cursor' ||
    normalized === 'pi'
    ? normalized
    : null;
}

export function builtinProviderProbeArgs(provider: BuiltinProviderName): string[] {
  if (provider === 'codex') return ['exec', '--help'];
  if (provider === 'pi') return ['--offline', '--no-extensions', '--help'];
  return ['--help'];
}

function parseVersion(provider: BuiltinProviderName, output: string): string | null {
  const pattern =
    provider === 'cursor' ? /\b(\d{4}\.\d{2}\.\d{2}-[A-Za-z0-9.-]+)\b/ : /\b(\d+\.\d+\.\d+)\b/;
  return pattern.exec(output)?.[1] ?? null;
}

function validateProbe(
  provider: BuiltinProviderName,
  probe: BuiltinProviderPreflightInput['probe'],
): string | null {
  if (!probe.ok) return `${provider} capability probe failed`;
  if (provider === 'claude') {
    const normalized = probe.output.toLowerCase();
    if (!['--print', 'stream-json', '--resume'].every((flag) => normalized.includes(flag))) {
      return 'Claude help does not expose the required print, stream JSON, and resume contract';
    }
    return null;
  }
  const normalized = probe.output.toLowerCase();
  if (provider === 'codex' && (!normalized.includes('--json') || !normalized.includes('resume'))) {
    return 'Codex help does not expose the required JSON and resume contract';
  }
  if (
    provider === 'cursor' &&
    !['--print', 'stream-json', '--workspace', '--resume'].every((flag) =>
      normalized.includes(flag),
    )
  ) {
    return 'Cursor help does not expose the required stream, workspace, and resume contract';
  }
  if (
    provider === 'pi' &&
    ![
      '--mode',
      'json',
      '--session',
      '--session-dir',
      '--tools',
      '--offline',
      '--no-extensions',
      '--no-context-files',
      '--no-skills',
      '--no-prompt-templates',
      '--list-models',
    ].every((flag) => normalized.includes(flag))
  ) {
    return 'Pi help does not expose the required JSON, session, safe-tool, automatic-resource-disable, offline, and model-list contract';
  }
  return null;
}

function capabilitiesFor(): ProviderCapabilities {
  return {
    launch: true,
    observe: false,
    inspect: true,
    resume: true,
    cancel: false,
    needsInput: false,
  };
}
