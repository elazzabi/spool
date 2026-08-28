#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';

import { collectDoctorReport, presentDoctorReport } from './commands/doctor.js';
import { runConfigAgentAdd } from './commands/config-agent.js';
import {
  addRepositoryCommand,
  addWatchedFolderCommand,
  assignRepositoryAliasCommand,
  configurationSummary,
  listWatchedFolders,
  presentConfigurationSummary,
  presentWatchedFolders,
  removeRepositoryCommand,
  removeWatchedFolderCommand,
} from './commands/config.js';
import { ClackStaticCliPresenter, sanitizeTerminalText } from './output.js';
import { runInit } from './commands/init.js';
import { runLogs } from './commands/logs.js';
import { requestJobCancellation } from './commands/cancel.js';
import { runDaemon } from './commands/daemon.js';
import { presentRunOnceReport, runOnce } from './commands/run-once.js';
import { collectStatus, presentStatusReport } from './commands/status.js';
import { presentUpdateResult, runManagedUpdate } from './commands/update.js';
import { presentUninstallResult, runManagedUninstall } from './commands/uninstall.js';
import {
  acknowledgeWorkspace,
  listWorkspaces,
  presentWorkspaceReport,
} from './commands/workspace.js';
import { ConfigError, loadConfig } from '../config/load.js';
import { sanitizeOperatorText } from '../providers/logs.js';

export function createProgram(): Command {
  const program = new Command()
    .name('spool')
    .description('Delegate explicit Markdown todos to local AI agents')
    .version('0.1.6')
    .option('-c, --config <path>', 'configuration file (otherwise uses the platform default)');

  program.action(() => program.outputHelp());

  program
    .command('init')
    .description('run guided setup for the first spool configuration')
    .option('--plain', 'use accessible line-oriented prompts instead of interactive controls')
    .action(async (options: { plain?: boolean }, command: Command) => {
      const globals = command.optsWithGlobals<{ config?: string }>();
      await runInit({
        ...(globals.config === undefined ? {} : { configPath: globals.config }),
        plain: options.plain === true,
      });
    });

  program
    .command('daemon')
    .description('watch Markdown notes and reconcile jobs continuously')
    .action(async (_options: unknown, command: Command) => {
      const globals = command.optsWithGlobals<{ config?: string }>();
      await runDaemon(loadConfig(globals.config));
    });
  program
    .command('run-once')
    .description('perform reconciliation passes until local work converges')
    .option('--json', 'emit machine-readable JSON')
    .action(async (options: { json?: boolean }, command: Command) => {
      const globals = command.optsWithGlobals<{ config?: string }>();
      const report = await runOnce(loadConfig(globals.config));
      if (options.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        presentRunOnceReport(report, new ClackStaticCliPresenter());
      }
    });

  program
    .command('doctor')
    .description('validate configuration and report read-only provider diagnostics')
    .option('--json', 'emit machine-readable JSON')
    .action(async (options: { json?: boolean }, command: Command) => {
      const globals = command.optsWithGlobals<{ config?: string }>();
      const config = loadConfig(globals.config);
      const report = await collectDoctorReport(config);
      if (options.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        presentDoctorReport(report, new ClackStaticCliPresenter());
      }
      if (!report.ok) process.exitCode = 1;
    });

  program
    .command('status')
    .description('show durable jobs and workspace state')
    .option('--json', 'emit machine-readable JSON')
    .action((options: { json?: boolean }, command: Command) => {
      const globals = command.optsWithGlobals<{ config?: string }>();
      const report = collectStatus(loadConfig(globals.config));
      if (options.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        presentStatusReport(report, new ClackStaticCliPresenter());
      }
    });
  program
    .command('logs')
    .description('show retained operational logs')
    .option('-f, --follow', 'show the recent tail and follow new operational records')
    .action(async (options: { follow?: boolean }, command: Command) => {
      const globals = command.optsWithGlobals<{ config?: string }>();
      await runLogs(loadConfig(globals.config), { follow: options.follow === true });
    });
  program
    .command('cancel <task-id>')
    .description('request cancellation of one durable job')
    .action((taskId: string, _options: unknown, command: Command) => {
      const globals = command.optsWithGlobals<{ config?: string }>();
      const result = requestJobCancellation(loadConfig(globals.config), taskId);
      process.stdout.write(
        `Cancellation ${result.state === 'Cancelled' ? 'completed' : 'requested'} for ${result.taskId} (${result.jobId})\n`,
      );
    });

  program
    .command('update')
    .description('update an installer-owned spool release')
    .option('--version <version>', 'install an exact newer stable version')
    .option('--json', 'emit machine-readable JSON')
    .action(async (options: { version?: string; json?: boolean }, command: Command) => {
      const globals = command.optsWithGlobals<{ config?: string }>();
      const result = await runManagedUpdate({
        ...(options.version ? { version: options.version } : {}),
        ...(globals.config ? { configPath: globals.config } : {}),
      });
      presentUpdateResult(result, options.json === true);
      process.exitCode = result.exitCode;
    });

  program
    .command('uninstall')
    .description('remove installer-owned spool programs while preserving user data')
    .option('--json', 'emit machine-readable JSON')
    .action(async (options: { json?: boolean }, command: Command) => {
      const globals = command.optsWithGlobals<{ config?: string }>();
      const result = await runManagedUninstall({
        ...(globals.config ? { configPath: globals.config } : {}),
      });
      presentUninstallResult(result, options.json === true);
      process.exitCode = result.exitCode;
    });

  const workspace = program.command('workspace').description('inspect and recover workspace pools');
  workspace
    .command('list')
    .description('list configured workspace pools and leases')
    .option('--json', 'emit machine-readable JSON')
    .action(async (options: { json?: boolean }, command: Command) => {
      const globals = command.optsWithGlobals<{ config?: string }>();
      const result = await listWorkspaces(loadConfig(globals.config));
      if (options.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        presentWorkspaceReport(result, new ClackStaticCliPresenter());
      }
    });
  workspace
    .command('acknowledge <path>')
    .description('acknowledge a quarantined workspace')
    .action(async (workspacePath: string, _options: unknown, command: Command) => {
      const globals = command.optsWithGlobals<{ config?: string }>();
      const result = await acknowledgeWorkspace(loadConfig(globals.config), workspacePath);
      if (result.kind === 'refused') throw new Error(result.reason);
      if (result.kind === 'requested') {
        process.stdout.write(
          `Requested workspace acknowledgment for ${result.lease.canonicalWorkspace}; spool will inspect it on the next daemon pass. If no daemon is running, rerun this command.\n`,
        );
        return;
      }
      process.stdout.write(`Released workspace ${result.lease.canonicalWorkspace}\n`);
    });

  const config = program.command('config').description('inspect and update spool configuration');
  config
    .command('show')
    .description('show the effective configuration with credential-shaped flags redacted')
    .option('--json', 'emit machine-readable JSON')
    .action((options: { json?: boolean }, command: Command) => {
      const globals = command.optsWithGlobals<{ config?: string }>();
      const summary = configurationSummary(globals.config);
      if (options.json) {
        process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      } else {
        presentConfigurationSummary(summary, new ClackStaticCliPresenter());
      }
    });
  const agent = config.command('agent').description('manage supported coding agents');
  agent
    .command('add')
    .description('run guided setup for one additional supported coding agent')
    .option('--plain', 'use accessible line-oriented prompts instead of interactive controls')
    .action(async (options: { plain?: boolean }, command: Command) => {
      const globals = command.optsWithGlobals<{ config?: string }>();
      await runConfigAgentAdd({
        ...(globals.config === undefined ? {} : { configPath: globals.config }),
        plain: options.plain === true,
      });
    });
  const repository = config
    .command('repository')
    .description('manage registered GitHub repository clones');
  repository
    .command('add <path>')
    .description('add an existing GitHub worktree to the repository pools')
    .action(async (clonePath: string, _options: unknown, command: Command) => {
      const globals = command.optsWithGlobals<{ config?: string }>();
      const added = await addRepositoryCommand(globals.config, clonePath);
      process.stdout.write(
        `Added ${sanitizeTerminalText(added.clone)} to ${sanitizeTerminalText(added.repository)}. Restart a running daemon to apply this change.\n`,
      );
    });
  repository
    .command('alias <repository> <alias>')
    .description('assign or replace a lowercase slug alias for a configured repository')
    .action(
      (repositoryIdentity: string, aliasValue: string, _options: unknown, command: Command) => {
        const globals = command.optsWithGlobals<{ config?: string }>();
        const configuredRepository = assignRepositoryAliasCommand(
          globals.config,
          repositoryIdentity,
          aliasValue,
        );
        const repository = sanitizeTerminalText(configuredRepository.repository);
        const alias = sanitizeTerminalText(configuredRepository.alias ?? aliasValue);
        process.stdout.write(
          `Assigned alias ${alias} to ${repository}. Restart a running daemon to apply this change.\n`,
        );
      },
    );
  repository
    .command('remove <path>')
    .description('remove an idle repository workspace while the daemon is stopped')
    .action((clonePath: string, _options: unknown, command: Command) => {
      const globals = command.optsWithGlobals<{ config?: string }>();
      const removed = removeRepositoryCommand(globals.config, clonePath);
      const clone = sanitizeTerminalText(removed.clone);
      const repositoryIdentity = sanitizeTerminalText(removed.repository);
      const detail = removed.poolRemoved
        ? `Removed ${clone} and its now-empty ${repositoryIdentity} pool.`
        : `Removed ${clone} from ${repositoryIdentity}.`;
      process.stdout.write(`${detail} Start the daemon again to apply this change.\n`);
    });
  const watch = config.command('watch').description('manage watched Obsidian or Markdown folders');
  watch
    .command('list')
    .description('list watched folders')
    .option('--json', 'emit machine-readable JSON')
    .action((options: { json?: boolean }, command: Command) => {
      const globals = command.optsWithGlobals<{ config?: string }>();
      const folders = listWatchedFolders(globals.config);
      if (options.json) {
        process.stdout.write(`${JSON.stringify(folders, null, 2)}\n`);
      } else {
        presentWatchedFolders(folders, new ClackStaticCliPresenter());
      }
    });
  watch
    .command('add <path>')
    .description('add an existing folder to the watch list')
    .action((folder: string, _options: unknown, command: Command) => {
      const globals = command.optsWithGlobals<{ config?: string }>();
      const folders = addWatchedFolderCommand(globals.config, folder);
      process.stdout.write(
        `Now watching ${folders.length} folders. Restart a running daemon to apply this change.\n`,
      );
    });
  watch
    .command('remove <path>')
    .description('remove an idle folder from the watch list')
    .action((folder: string, _options: unknown, command: Command) => {
      const globals = command.optsWithGlobals<{ config?: string }>();
      const folders = removeWatchedFolderCommand(globals.config, folder);
      process.stdout.write(
        `Now watching ${folders.length} folders. Start the daemon again to apply this change.\n`,
      );
    });

  return program;
}

export function isMainEntrypoint(moduleUrl: string, entrypointPath: string | undefined): boolean {
  if (!entrypointPath) return false;
  try {
    return realpathSync(entrypointPath) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  try {
    await createProgram().parseAsync(process.argv);
  } catch (error) {
    const message = sanitizeOperatorText(error instanceof Error ? error.message : String(error));
    process.stderr.write(
      `${error instanceof ConfigError ? 'Configuration error' : 'Error'}: ${message}\n`,
    );
    process.exitCode = 1;
  }
}

if (isMainEntrypoint(import.meta.url, process.argv[1])) {
  await main();
}
