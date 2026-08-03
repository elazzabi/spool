import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import type { MDSpoolConfig, ProviderConfig } from '../config/schema.js';
import { openLedgerDatabase, type LedgerDatabase } from '../ledger/database.js';
import { OutboxRepository } from '../ledger/outbox.js';
import { LedgerRepository } from '../ledger/repositories.js';
import { ClaudeProvider } from '../providers/claude.js';
import { CodexProvider } from '../providers/codex.js';
import { CursorProvider } from '../providers/cursor.js';
import { PiProvider } from '../providers/pi.js';
import { ensurePiSessionDirectory } from '../providers/pi-session.js';
import {
  DEFAULT_TERMINAL_LOG_RETENTION_DAYS,
  pruneTerminalAttemptLogs,
} from '../providers/log-retention.js';
import {
  builtinProviderName,
  builtinProviderProbeArgs,
  evaluateBuiltinProviderPreflight,
  type BuiltinProviderName,
} from '../providers/preflight.js';
import { ProviderRegistry } from '../providers/registry.js';
import type { ProviderAdapter } from '../providers/types.js';
import { OperationalLogStore } from '../logging/store.js';
import type { OperationalRuntimeMode } from '../logging/events.js';
import { WorkspacePool } from '../workspaces/pool.js';
import { Reconciler, type ReconciliationPassResult } from './reconciler.js';
import { VaultWatcher } from './watcher.js';

export interface MDSpoolRuntime {
  database: LedgerDatabase;
  ledger: LedgerRepository;
  outbox: OutboxRepository;
  providers: ProviderRegistry;
  workspaces: WorkspacePool;
  reconciler: Reconciler;
  warnings: string[];
  close(outcome?: 'clean' | 'failed'): Promise<void>;
}

export async function openMDSpoolRuntime(
  config: MDSpoolConfig,
  options: {
    providers?: ProviderRegistry;
    mode?: OperationalRuntimeMode;
    onOperationalLogWarning?: (warning: string) => void;
    now?: () => Date;
  } = {},
): Promise<MDSpoolRuntime> {
  const database = openLedgerDatabase(config.stateDirectory);
  try {
    const ledger = new LedgerRepository(database);
    const outbox = new OutboxRepository(database);
    const installed = options.providers
      ? { registry: options.providers, warnings: [] }
      : await createInstalledProviderRegistry(config);
    const retention = await pruneTerminalAttemptLogs({
      stateDirectory: config.stateDirectory,
      ledger,
      olderThan: new Date(Date.now() - DEFAULT_TERMINAL_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1_000),
    });
    for (const unsafePath of retention.skippedUnsafe) {
      installed.warnings.push(`Log retention refused unsafe path: ${unsafePath}`);
    }
    const operationalLog = new OperationalLogStore({
      stateDirectory: config.stateDirectory,
      runtimeId: randomUUID(),
      mode: options.mode ?? 'run-once',
      ...(options.now ? { now: options.now } : {}),
      onWarning: (warning) => {
        installed.warnings.push(warning);
        options.onOperationalLogWarning?.(warning);
      },
    });
    const workspaces = new WorkspacePool({ repositories: config.repositories, ledger });
    const reconciler = new Reconciler({
      config,
      database,
      ledger,
      outbox,
      providers: installed.registry,
      workspaces,
      operationalLog,
      ...(options.now ? { now: options.now } : {}),
    });
    let closePromise: Promise<void> | null = null;
    return {
      database,
      ledger,
      outbox,
      providers: installed.registry,
      workspaces,
      reconciler,
      warnings: installed.warnings,
      close(outcome = 'clean') {
        closePromise ??= (async () => {
          try {
            await reconciler.shutdown(outcome);
          } finally {
            database.close();
          }
        })();
        return closePromise;
      },
    };
  } catch (error) {
    database.close();
    throw error;
  }
}

export class ReconciliationService {
  readonly #config: MDSpoolConfig;
  readonly #reconciler: Reconciler;
  readonly #watcher: VaultWatcher;
  readonly #onDiagnostic: (message: string) => void;
  readonly #reportedDiagnostics = new Set<string>();
  #interval: NodeJS.Timeout | null = null;
  #running: Promise<void> | null = null;
  #pending = false;
  #stopped = false;
  #lastError: Error | null = null;

  constructor(options: {
    config: MDSpoolConfig;
    reconciler: Reconciler;
    watcher?: VaultWatcher;
    onDiagnostic?: (message: string) => void;
  }) {
    this.#config = options.config;
    this.#reconciler = options.reconciler;
    this.#watcher =
      options.watcher ??
      new VaultWatcher({ vaults: options.config.vaults, wake: () => this.wake() });
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined);
  }

  async start(): Promise<void> {
    if (this.#interval) return;
    this.#stopped = false;
    this.#report(await this.#reconciler.runPass());
    await this.#watcher.start();
    // The second startup scan closes the watcher-initialization race and advances marker bootstrap.
    this.#report(await this.#reconciler.runPass());
    this.#interval = setInterval(() => this.wake(), this.#config.pollIntervalSeconds * 1_000);
    this.#interval.unref();
  }

  wake(): void {
    if (this.#stopped) return;
    if (this.#running) {
      this.#pending = true;
      return;
    }
    this.#running = this.#drain().finally(() => {
      this.#running = null;
    });
  }

  async stop(outcome: 'clean' | 'failed' = 'clean'): Promise<void> {
    this.#stopped = true;
    if (this.#interval) clearInterval(this.#interval);
    this.#interval = null;
    await this.#watcher.close();
    await this.#running;
    await this.#reconciler.shutdown(outcome);
  }

  lastError(): Error | null {
    return this.#lastError;
  }

  async #drain(): Promise<void> {
    do {
      this.#pending = false;
      try {
        this.#report(await this.#reconciler.runPass());
        this.#lastError = null;
      } catch (error) {
        this.#lastError = error instanceof Error ? error : new Error(String(error));
        this.#emitDiagnostic(`Reconciliation failed: ${this.#lastError.message}`);
      }
    } while (this.#pending && !this.#stopped);
  }

  #report(result: ReconciliationPassResult): void {
    for (const diagnostic of result.diagnostics) {
      this.#emitDiagnostic(diagnostic);
    }
  }

  #emitDiagnostic(diagnostic: string): void {
    if (this.#reportedDiagnostics.has(diagnostic)) return;
    this.#reportedDiagnostics.add(diagnostic);
    this.#onDiagnostic(diagnostic);
  }
}

export async function runUntilConverged(
  reconciler: Reconciler,
  maximumPasses = reconciler.convergencePassLimit(),
): Promise<ReconciliationPassResult[]> {
  const results: ReconciliationPassResult[] = [];
  for (let index = 0; index < maximumPasses; index += 1) {
    const result = await reconciler.runPass({ awaitLaunched: true });
    results.push(result);
    const launched = result.dispatches.reduce((count, item) => count + item.launched.length, 0);
    if (index > 0 && result.claimedJobIds.length === 0 && launched === 0) break;
  }
  return results;
}

export async function createInstalledProviderRegistry(config: MDSpoolConfig): Promise<{
  registry: ProviderRegistry;
  warnings: string[];
}> {
  const adapters: ProviderAdapter[] = [];
  const warnings: string[] = [];
  for (const provider of config.providers.filter((entry) => entry.enabled)) {
    const name = builtinProviderName(provider.name);
    if (!name) {
      warnings.push(`Provider ${provider.name} has no built-in adapter and remains unavailable`);
      continue;
    }
    if (!provider.executableResolved) {
      warnings.push(`Provider ${provider.name} executable is unavailable`);
      continue;
    }
    const preflight = await preflightProvider(provider, name);
    warnings.push(...preflight.warnings);
    if (!preflight.parserSupported) continue;
    switch (name) {
      case 'claude':
        adapters.push(
          new ClaudeProvider({
            executable: provider.executable,
            defaultArgs: provider.defaultArgs,
            preflight,
          }),
        );
        break;
      case 'codex':
        adapters.push(
          new CodexProvider({
            executable: provider.executable,
            defaultArgs: provider.defaultArgs,
            preflight,
          }),
        );
        break;
      case 'cursor':
        adapters.push(
          new CursorProvider({
            executable: provider.executable,
            defaultArgs: provider.defaultArgs,
            preflight,
          }),
        );
        break;
      case 'pi': {
        const sessionDirectory = ensurePiSessionDirectory({
          stateDirectory: config.stateDirectory,
          workspaceDirectories: config.repositories.flatMap((repository) => repository.clones),
        });
        adapters.push(
          new PiProvider({
            executable: provider.executable,
            defaultArgs: provider.defaultArgs,
            sessionDirectory,
            preflight,
          }),
        );
        break;
      }
      default:
        assertNeverProvider(name);
    }
  }
  return { registry: new ProviderRegistry(adapters), warnings };
}

function assertNeverProvider(provider: never): never {
  throw new Error(`Unsupported built-in provider: ${String(provider)}`);
}

async function preflightProvider(provider: ProviderConfig, name: BuiltinProviderName) {
  const [version, probe] = await Promise.all([
    execute(provider.executable, ['--version']),
    execute(provider.executable, builtinProviderProbeArgs(name)),
  ]);
  return evaluateBuiltinProviderPreflight({
    provider: name,
    versionOutput: version.stdout || version.stderr,
    probe: {
      ok: probe.ok,
      output: name === 'claude' ? probe.stdout : `${probe.stdout}\n${probe.stderr}`,
    },
  });
}

function execute(
  executable: string,
  args: readonly string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      executable,
      [...args],
      { shell: false, timeout: 5_000, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => resolve({ ok: error === null, stdout, stderr }),
    );
  });
}
