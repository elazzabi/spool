import { execFile } from 'node:child_process';

import type { MDSpoolConfig, ProviderConfig } from '../../config/schema.js';
import {
  builtinProviderName,
  builtinProviderProbeArgs,
  evaluateBuiltinProviderPreflight,
} from '../../providers/preflight.js';
import { redactSensitiveArgv } from '../../providers/argv.js';
import { selectProviderEnvironment } from '../../providers/environment.js';
import { piEnvironmentAllowlist, piLaunchArgs } from '../../providers/pi.js';
import {
  hasPiModelRow,
  piModelProbeArgs,
  piStoredAuthGuidance,
} from '../../providers/pi-readiness.js';
import { inspectPiSessionDirectory } from '../../providers/pi-session.js';
import type { ProviderCapabilities } from '../../providers/types.js';
import { sanitizeTerminalText } from '../../terminal.js';
import type { StaticCliPresenter } from '../output.js';

export interface DoctorRunOptions {
  shell: false;
  timeoutMs: number;
  environment?: NodeJS.ProcessEnv;
}

export interface DoctorCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export type DoctorCommandRunner = (
  executable: string,
  args: string[],
  options: DoctorRunOptions,
) => Promise<DoctorCommandResult>;

export interface ProviderDoctorReport {
  name: string;
  enabled: boolean;
  available: boolean;
  executable: string;
  version: string | null;
  effectiveArgv: string[];
  capabilities: string[];
  capabilityProbe: {
    ok: boolean;
    argv: string[];
    detail: string;
  } | null;
  warnings: string[];
  error: string | null;
}

export interface DoctorReport {
  ok: boolean;
  configPath: string;
  stateDirectory: string;
  providers: ProviderDoctorReport[];
}

type DoctorProviderStatus = 'available' | 'disabled' | 'unavailable';

interface DoctorProviderPresentation {
  name: string;
  status: DoctorProviderStatus;
  details: Array<{ label: string; value: string }>;
  warnings: string[];
  error: string | null;
}

interface DoctorReportPresentation {
  configPath: string;
  stateDirectory: string;
  overall: 'ready' | 'attention needed';
  providers: DoctorProviderPresentation[];
}

export async function collectDoctorReport(
  config: MDSpoolConfig,
  dependencies: { commandRunner?: DoctorCommandRunner; environment?: NodeJS.ProcessEnv } = {},
): Promise<DoctorReport> {
  const commandRunner = dependencies.commandRunner ?? runCommand;
  const providers: ProviderDoctorReport[] = [];
  for (const provider of config.providers) {
    providers.push(
      await inspectProvider(
        provider,
        config,
        commandRunner,
        dependencies.environment ?? process.env,
      ),
    );
  }
  return {
    ok: providers.filter((provider) => provider.enabled).every((provider) => provider.available),
    configPath: config.configPath,
    stateDirectory: config.stateDirectory,
    providers,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const presentation = composeDoctorReport(report, {
    renderArgument: renderArg,
    renderCapability: (capability) => capability,
  });
  const lines = [
    `Config: ${presentation.configPath}`,
    `State: ${presentation.stateDirectory}`,
    `Overall: ${presentation.overall}`,
    '',
  ];
  for (const provider of presentation.providers) {
    lines.push(`${provider.name}: ${provider.status}`);
    for (const detail of provider.details) lines.push(`  ${detail.label}: ${detail.value}`);
    for (const warning of provider.warnings) lines.push(`  warning: ${warning}`);
    if (provider.error) lines.push(`  error: ${provider.error}`);
  }
  return lines.join('\n');
}

export function presentDoctorReport(report: DoctorReport, presenter: StaticCliPresenter): void {
  const presentation = composeDoctorReport(report, {
    renderArgument: renderPresentedArg,
    renderCapability: sanitizeTerminalText,
  });
  presenter.intro('MDSpool doctor');
  presenter.section('Paths', [
    `Config: ${presentation.configPath}`,
    `State: ${presentation.stateDirectory}`,
  ]);
  if (presentation.overall === 'ready') {
    presenter.success(`Overall: ${presentation.overall}`);
  } else {
    presenter.error(`Overall: ${presentation.overall}`);
  }

  for (const provider of presentation.providers) {
    if (provider.status === 'disabled') {
      presenter.info(`${provider.name}: ${provider.status}`);
    } else if (provider.status === 'available') {
      presenter.success(`${provider.name}: ${provider.status}`);
    } else {
      presenter.error(`${provider.name}: ${provider.status}`);
    }

    presenter.section(
      `${provider.name} details`,
      provider.details.map((detail) => `${capitalize(detail.label)}: ${detail.value}`),
    );
    for (const warning of provider.warnings) {
      presenter.warn(`${provider.name} warning: ${warning}`);
    }
    if (provider.error) {
      const message = `${provider.name} error: ${provider.error}`;
      if (provider.status === 'disabled') {
        presenter.info(message);
      } else {
        presenter.error(message);
      }
    }
  }
  presenter.outro('Doctor inspection complete');
}

function composeDoctorReport(
  report: DoctorReport,
  rendering: {
    renderArgument(value: string): string;
    renderCapability(value: string): string;
  },
): DoctorReportPresentation {
  return {
    configPath: sanitizeTerminalText(report.configPath),
    stateDirectory: sanitizeTerminalText(report.stateDirectory),
    overall: report.ok ? 'ready' : 'attention needed',
    providers: report.providers.map((provider) => {
      const details = [
        { label: 'version', value: sanitizeTerminalText(provider.version ?? 'unknown') },
        {
          label: 'argv',
          value: provider.effectiveArgv
            .map((argument) => rendering.renderArgument(argument))
            .join(' '),
        },
        {
          label: 'capabilities',
          value:
            provider.capabilities
              .map((capability) => rendering.renderCapability(capability))
              .join(', ') || 'none confirmed',
        },
      ];
      if (provider.capabilityProbe) {
        details.push({
          label: 'probe',
          value: `${provider.capabilityProbe.ok ? 'ok' : 'failed'} (${sanitizeTerminalText(provider.capabilityProbe.detail)}): ${provider.capabilityProbe.argv.map((argument) => rendering.renderArgument(argument)).join(' ')}`,
        });
      }
      return {
        name: sanitizeTerminalText(provider.name),
        status: provider.enabled ? (provider.available ? 'available' : 'unavailable') : 'disabled',
        details,
        warnings: provider.warnings.map(sanitizeTerminalText),
        error: provider.error === null ? null : sanitizeTerminalText(provider.error),
      };
    }),
  };
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

async function inspectProvider(
  provider: ProviderConfig,
  config: MDSpoolConfig,
  commandRunner: DoctorCommandRunner,
  environment: NodeJS.ProcessEnv,
): Promise<ProviderDoctorReport> {
  const builtin = builtinProviderName(provider.name);
  const piSessions =
    builtin === 'pi'
      ? inspectPiSessionDirectory({
          stateDirectory: config.stateDirectory,
          workspaceDirectories: config.repositories.flatMap((repository) => repository.clones),
        })
      : null;
  const effectiveArgs =
    builtin === 'pi' && piSessions
      ? piLaunchArgs(provider.defaultArgs, piSessions.sessionDirectory)
      : provider.defaultArgs;
  const base = {
    name: provider.name,
    enabled: provider.enabled,
    executable: provider.executable,
    effectiveArgv: [provider.executable, ...redactSensitiveArgv(effectiveArgs)],
  };
  if (!provider.enabled) {
    return {
      ...base,
      available: false,
      version: null,
      capabilities: [],
      capabilityProbe: null,
      warnings: [],
      error: 'disabled by configuration',
    };
  }
  if (!provider.executableResolved) {
    return {
      ...base,
      available: false,
      version: null,
      capabilities: [],
      capabilityProbe: null,
      warnings: [],
      error: 'executable not found or not executable',
    };
  }

  if (!builtin) {
    return {
      ...base,
      available: false,
      version: null,
      capabilities: [],
      capabilityProbe: null,
      warnings: [],
      error: 'no runtime adapter is registered for this provider',
    };
  }

  const runOptions: DoctorRunOptions = { shell: false, timeoutMs: 5_000 };
  const probeOptions: DoctorRunOptions =
    builtin === 'pi'
      ? {
          ...runOptions,
          environment: selectProviderEnvironment(environment, piEnvironmentAllowlist),
        }
      : runOptions;
  try {
    const versionResult = await commandRunner(provider.executable, ['--version'], probeOptions);
    if (!versionResult.ok) {
      return {
        ...base,
        available: false,
        version: null,
        capabilities: [],
        capabilityProbe: null,
        warnings: [],
        error: safeLine(versionResult.stderr) || 'version command failed',
      };
    }

    const probeArgs = builtinProviderProbeArgs(builtin);
    const probeResult = await commandRunner(provider.executable, probeArgs, probeOptions);
    const probeText = `${probeResult.stdout}\n${probeResult.stderr}`;
    const preflight = evaluateBuiltinProviderPreflight({
      provider: builtin,
      versionOutput: versionResult.stdout || versionResult.stderr,
      probe: { ok: probeResult.ok, output: probeText.trim() },
    });
    const sessionError = piSessions?.error ?? null;
    let authenticationError: string | null = null;
    if (builtin === 'pi' && preflight.parserSupported) {
      const modelResult = await commandRunner(
        provider.executable,
        [...piModelProbeArgs],
        probeOptions,
      );
      if (!modelResult.ok || !hasPiModelRow(`${modelResult.stdout}\n${modelResult.stderr}`)) {
        authenticationError = piStoredAuthGuidance(true);
      }
    }
    const availabilityError = sessionError ?? authenticationError;
    const available = preflight.parserSupported && availabilityError === null;
    const error = preflight.parserSupported
      ? availabilityError
      : preflight.warnings.join('; ') || 'provider parser is unsupported';
    const detail = preflight.parserSupported
      ? (availabilityError ?? 'required machine contract is available')
      : (preflight.warnings[0] ?? 'provider contract is unsupported');
    return {
      ...base,
      available,
      version: preflight.installedVersion,
      capabilities: capabilityNames(preflight.capabilities),
      capabilityProbe: {
        ok: available,
        argv: [provider.executable, ...probeArgs],
        detail,
      },
      warnings: [...preflight.warnings],
      error,
    };
  } catch (error) {
    return {
      ...base,
      available: false,
      version: null,
      capabilities: [],
      capabilityProbe: null,
      warnings: [],
      error: safeLine(error instanceof Error ? error.message : String(error)),
    };
  }
}

function capabilityNames(capabilities: ProviderCapabilities): string[] {
  return [
    ...(capabilities.launch ? ['launch'] : []),
    ...(capabilities.observe ? ['status-observation'] : []),
    ...(capabilities.inspect ? ['inspect'] : []),
    ...(capabilities.resume ? ['resume'] : []),
    ...(capabilities.cancel ? ['cancel'] : []),
    ...(capabilities.needsInput ? ['needs-input'] : []),
  ];
}

function runCommand(
  executable: string,
  args: string[],
  options: DoctorRunOptions,
): Promise<DoctorCommandResult> {
  return new Promise((resolve) => {
    execFile(
      executable,
      args,
      {
        encoding: 'utf8',
        maxBuffer: 256 * 1024,
        timeout: options.timeoutMs,
        killSignal: 'SIGKILL',
        shell: options.shell,
        windowsHide: true,
        ...(options.environment === undefined ? {} : { env: options.environment }),
      },
      (error, stdout, stderr) => {
        resolve({ ok: error === null, stdout, stderr });
      },
    );
  });
}

function safeLine(value: string): string {
  const line = value.split(/\r?\n/, 1)[0] ?? '';
  return Array.from(line)
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && (code < 127 || code > 159);
    })
    .join('')
    .trim()
    .slice(0, 500);
}

function renderArg(value: string): string {
  return JSON.stringify(value);
}

function renderPresentedArg(value: string): string {
  return JSON.stringify(sanitizeTerminalText(value));
}
