import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { normalizeGitHubRepository } from '../config/schema.js';
import { samePath } from '../config/paths.js';
import { inspectGitOperations, type GitOperationMarker } from './operations.js';

export interface GitCommandResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

export interface GitRunOptions {
  allowedExitCodes?: readonly number[];
}

export interface GitRunner {
  run(cwd: string, args: readonly string[], options?: GitRunOptions): Promise<GitCommandResult>;
}

export interface NodeGitRunnerOptions {
  executable?: string;
  timeoutMilliseconds?: number;
  maxOutputBytes?: number;
  environment?: NodeJS.ProcessEnv;
}

export class GitCommandError extends Error {
  readonly args: readonly string[];
  readonly exitCode: number | null;

  constructor(message: string, args: readonly string[], exitCode: number | null = null) {
    super(message);
    this.name = 'GitCommandError';
    this.args = args;
    this.exitCode = exitCode;
  }
}

export class NodeGitRunner implements GitRunner {
  readonly #executable: string;
  readonly #timeoutMilliseconds: number;
  readonly #maxOutputBytes: number;
  readonly #environment: NodeJS.ProcessEnv;

  constructor(options: NodeGitRunnerOptions = {}) {
    this.#executable = options.executable ?? 'git';
    this.#timeoutMilliseconds = options.timeoutMilliseconds ?? 5_000;
    this.#maxOutputBytes = options.maxOutputBytes ?? 4 * 1024 * 1024;
    this.#environment = {
      ...process.env,
      ...options.environment,
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'Never',
      LC_ALL: 'C',
    };
  }

  async run(
    cwd: string,
    args: readonly string[],
    options: GitRunOptions = {},
  ): Promise<GitCommandResult> {
    const allowedExitCodes = options.allowedExitCodes ?? [0];
    return new Promise((resolve, reject) => {
      const child = spawn(this.#executable, [...args], {
        cwd,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: this.#environment,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        finish(
          new GitCommandError(`Git command timed out after ${this.#timeoutMilliseconds}ms`, args),
        );
      }, this.#timeoutMilliseconds);

      const collect = (target: Buffer[], chunk: Buffer): void => {
        outputBytes += chunk.length;
        if (outputBytes > this.#maxOutputBytes) {
          child.kill('SIGKILL');
          finish(new GitCommandError('Git command output exceeded the configured limit', args));
          return;
        }
        target.push(chunk);
      };
      child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
      child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
      child.once('error', (error) =>
        finish(new GitCommandError(`Unable to run Git: ${error.message}`, args)),
      );
      child.once('close', (exitCode) => {
        if (settled) return;
        const result = {
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
          exitCode: exitCode ?? -1,
        };
        if (!allowedExitCodes.includes(result.exitCode)) {
          const detail = result.stderr.toString('utf8').trim();
          finish(
            new GitCommandError(
              `Git ${args[0] ?? 'command'} failed with exit ${result.exitCode}${detail ? `: ${detail}` : ''}`,
              args,
              result.exitCode,
            ),
          );
          return;
        }
        finish(undefined, result);
      });

      function finish(error?: Error, result?: GitCommandResult): void {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else if (result) resolve(result);
      }
    });
  }
}

export interface FileIdentity {
  device: string;
  inode: string;
}

export interface GitRemote {
  name: string;
  urls: string[];
  pushUrls: string[];
}

export interface GitStatusSummary {
  hash: string;
  entries: string[];
  staged: number;
  modified: number;
  untracked: number;
  conflicted: number;
  other: number;
}

export interface WorkspaceFingerprint {
  repository: string;
  canonicalWorkspace: string;
  workspaceIdentity: FileIdentity;
  gitDirectory: string;
  gitDirectoryIdentity: FileIdentity;
  gitCommonDirectory: string;
  gitCommonDirectoryIdentity: FileIdentity;
  branch: string | null;
  detached: boolean;
  head: string;
  remotes: GitRemote[];
  originRepository: string | null;
  status: GitStatusSummary;
  operations: GitOperationMarker[];
}

export type WorkspaceUnsafeCode =
  | 'path-unavailable'
  | 'git-inspection-failed'
  | 'git-toplevel-mismatch'
  | 'origin-missing'
  | 'origin-not-github'
  | 'origin-mismatch'
  | 'worktree-dirty'
  | 'git-operation-active';

export interface WorkspaceUnsafeReason {
  code: WorkspaceUnsafeCode;
  message: string;
}

export interface WorkspaceInspection {
  configuredPath: string;
  canonicalWorkspace: string | null;
  requestedRepository: string;
  eligible: boolean;
  reasons: WorkspaceUnsafeReason[];
  fingerprint: WorkspaceFingerprint | null;
}

export interface InspectGitWorkspaceOptions {
  runner?: GitRunner;
}

export type WorkspaceBranchRestoration =
  | { kind: 'restored' | 'already-restored'; inspection: WorkspaceInspection }
  | { kind: 'refused'; reason: string; inspection: WorkspaceInspection };

export async function restoreWorkspaceBaselineBranch(
  configuredPath: string,
  requestedRepository: string,
  baseline: WorkspaceFingerprint,
  options: InspectGitWorkspaceOptions = {},
): Promise<WorkspaceBranchRestoration> {
  const runner = options.runner ?? new NodeGitRunner();
  const current = await inspectGitWorkspace(configuredPath, requestedRepository, { runner });
  const currentFingerprint = current.fingerprint;
  if (!currentFingerprint) {
    return {
      kind: 'refused',
      reason: `Workspace could not be inspected: ${current.reasons.map(({ message }) => message).join('; ')}`,
      inspection: current,
    };
  }
  if (currentFingerprint.status.entries.length > 0) {
    return {
      kind: 'refused',
      reason: `Workspace is not clean (${describeStatus(currentFingerprint.status)})`,
      inspection: current,
    };
  }
  if (currentFingerprint.branch === baseline.branch && currentFingerprint.head === baseline.head) {
    return { kind: 'already-restored', inspection: current };
  }
  if (!currentFingerprint.branch) {
    return {
      kind: 'refused',
      reason: 'Baseline restoration requires an attached current branch',
      inspection: current,
    };
  }
  if (!baseline.branch) {
    return {
      kind: 'refused',
      reason: 'Baseline restoration requires an attached baseline branch',
      inspection: current,
    };
  }
  if (currentFingerprint.branch === baseline.branch) {
    return {
      kind: 'refused',
      reason: `Baseline branch ${baseline.branch} no longer points to its captured commit`,
      inspection: current,
    };
  }

  const targetRef = `refs/heads/${baseline.branch}^{commit}`;
  let target: GitCommandResult;
  try {
    target = await runner.run(
      currentFingerprint.canonicalWorkspace,
      ['rev-parse', '--verify', '--quiet', targetRef],
      { allowedExitCodes: [0, 1] },
    );
  } catch (error) {
    return {
      kind: 'refused',
      reason: `Baseline branch ${baseline.branch} could not be verified: ${errorMessage(error)}`,
      inspection: current,
    };
  }
  const targetHead = target.stdout.toString('utf8').trim();
  if (target.exitCode !== 0 || targetHead !== baseline.head) {
    return {
      kind: 'refused',
      reason: `Baseline branch ${baseline.branch} no longer resolves to its captured commit`,
      inspection: current,
    };
  }

  let disabledHooksPath: string;
  try {
    disabledHooksPath = await mkdtemp(path.join(tmpdir(), 'spool-disabled-hooks-'));
  } catch (error) {
    return {
      kind: 'refused',
      reason: `Git hooks could not be safely disabled for baseline restoration: ${errorMessage(error)}`,
      inspection: current,
    };
  }
  try {
    await runner.run(currentFingerprint.canonicalWorkspace, [
      '-c',
      `core.hooksPath=${disabledHooksPath}`,
      'switch',
      '--no-guess',
      '--no-overwrite-ignore',
      baseline.branch,
    ]);
  } catch (error) {
    const inspection = await inspectGitWorkspace(configuredPath, requestedRepository, { runner });
    return {
      kind: 'refused',
      reason: `Git could not restore baseline branch ${baseline.branch}: ${errorMessage(error)}`,
      inspection,
    };
  } finally {
    await rm(disabledHooksPath, { recursive: true, force: true }).catch(() => undefined);
  }

  const inspection = await inspectGitWorkspace(configuredPath, requestedRepository, { runner });
  const restored = inspection.fingerprint;
  if (
    !restored ||
    restored.status.entries.length > 0 ||
    restored.branch !== baseline.branch ||
    restored.head !== baseline.head
  ) {
    return {
      kind: 'refused',
      reason: `Workspace did not exactly match captured branch ${baseline.branch} after restoration`,
      inspection,
    };
  }
  return { kind: 'restored', inspection };
}

export async function inspectGitWorkspace(
  configuredPath: string,
  requestedRepository: string,
  options: InspectGitWorkspaceOptions = {},
): Promise<WorkspaceInspection> {
  const repository = normalizeGitHubRepository(requestedRepository);
  const runner = options.runner ?? new NodeGitRunner();
  let canonicalWorkspace: string;
  try {
    canonicalWorkspace = await realpath(configuredPath);
  } catch (error) {
    return failedInspection(configuredPath, repository, 'path-unavailable', errorMessage(error));
  }

  try {
    const topLevel = await canonicalGitPath(
      canonicalWorkspace,
      runner,
      ['rev-parse', '--show-toplevel'],
      canonicalWorkspace,
    );
    if (!samePath(topLevel, canonicalWorkspace)) {
      return {
        configuredPath,
        canonicalWorkspace,
        requestedRepository: repository,
        eligible: false,
        reasons: [
          {
            code: 'git-toplevel-mismatch',
            message: `Configured clone resolves to ${canonicalWorkspace}, but Git top level is ${topLevel}`,
          },
        ],
        fingerprint: null,
      };
    }

    const gitDirectory = await canonicalGitPath(
      canonicalWorkspace,
      runner,
      ['rev-parse', '--git-dir'],
      canonicalWorkspace,
    );
    const gitCommonDirectory = await canonicalGitPath(
      canonicalWorkspace,
      runner,
      ['rev-parse', '--git-common-dir'],
      canonicalWorkspace,
    );
    const [workspaceStat, gitDirectoryStat, commonDirectoryStat] = await Promise.all([
      stat(canonicalWorkspace),
      stat(gitDirectory),
      stat(gitCommonDirectory),
    ]);

    const remotes = await readRemotes(canonicalWorkspace, runner);
    const origin = remotes.find((remote) => remote.name === 'origin');
    let originRepository: string | null = null;
    let originInvalid = false;
    if (origin) {
      for (const url of origin.urls) {
        try {
          const normalized = normalizeGitHubRepository(url);
          if (normalized === repository) originRepository = normalized;
        } catch {
          originInvalid = true;
        }
      }
    }

    const branchResult = await runner.run(
      canonicalWorkspace,
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      { allowedExitCodes: [0, 1] },
    );
    const branch =
      branchResult.exitCode === 0 ? branchResult.stdout.toString('utf8').trim() || null : null;
    const head = await gitText(canonicalWorkspace, runner, ['rev-parse', 'HEAD']);
    const statusResult = await runner.run(canonicalWorkspace, [
      'status',
      '--porcelain=v2',
      '-z',
      '--untracked-files=all',
    ]);
    const status = summarizeStatus(statusResult.stdout);
    const operations = await inspectGitOperations(gitDirectory, gitCommonDirectory);

    const fingerprint: WorkspaceFingerprint = {
      repository,
      canonicalWorkspace,
      workspaceIdentity: fileIdentity(workspaceStat),
      gitDirectory,
      gitDirectoryIdentity: fileIdentity(gitDirectoryStat),
      gitCommonDirectory,
      gitCommonDirectoryIdentity: fileIdentity(commonDirectoryStat),
      branch,
      detached: branch === null,
      head,
      remotes,
      originRepository,
      status,
      operations,
    };
    const reasons: WorkspaceUnsafeReason[] = [];
    if (!origin) {
      reasons.push({ code: 'origin-missing', message: 'The clone has no origin remote' });
    } else if (!originRepository) {
      reasons.push({
        code: originInvalid ? 'origin-not-github' : 'origin-mismatch',
        message: originInvalid
          ? 'The origin remote is not a valid GitHub repository URL'
          : `The origin remote does not map to ${repository}`,
      });
    }
    if (status.entries.length > 0) {
      reasons.push({
        code: 'worktree-dirty',
        message: `The clone is not clean (${describeStatus(status)})`,
      });
    }
    if (operations.length > 0) {
      reasons.push({
        code: 'git-operation-active',
        message: `Git operation or lock markers are present: ${operations.map((item) => item.kind).join(', ')}`,
      });
    }

    return {
      configuredPath,
      canonicalWorkspace,
      requestedRepository: repository,
      eligible: reasons.length === 0,
      reasons,
      fingerprint,
    };
  } catch (error) {
    return failedInspection(
      configuredPath,
      repository,
      'git-inspection-failed',
      errorMessage(error),
      canonicalWorkspace,
    );
  }
}

async function readRemotes(cwd: string, runner: GitRunner): Promise<GitRemote[]> {
  const names = (await gitText(cwd, runner, ['remote']))
    .split('\n')
    .map((name) => name.trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
  const remotes: GitRemote[] = [];
  for (const name of names) {
    const urls = (await gitText(cwd, runner, ['remote', 'get-url', '--all', name]))
      .split('\n')
      .map((url) => url.trim())
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right));
    const pushUrls = (await gitText(cwd, runner, ['remote', 'get-url', '--push', '--all', name]))
      .split('\n')
      .map((url) => url.trim())
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right));
    remotes.push({ name, urls, pushUrls });
  }
  return remotes;
}

async function canonicalGitPath(
  cwd: string,
  runner: GitRunner,
  args: readonly string[],
  relativeTo: string,
): Promise<string> {
  const reported = await gitText(cwd, runner, args);
  return realpath(path.isAbsolute(reported) ? reported : path.resolve(relativeTo, reported));
}

async function gitText(cwd: string, runner: GitRunner, args: readonly string[]): Promise<string> {
  return (await runner.run(cwd, args)).stdout.toString('utf8').trim();
}

function summarizeStatus(raw: Buffer): GitStatusSummary {
  const records = raw
    .toString('utf8')
    .split('\0')
    .filter((record) => record.length > 0);
  let staged = 0;
  let modified = 0;
  let untracked = 0;
  let conflicted = 0;
  let other = 0;
  const entries: string[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    entries.push(record);
    if (record.startsWith('? ')) {
      untracked += 1;
    } else if (record.startsWith('u ')) {
      conflicted += 1;
    } else if (record.startsWith('1 ') || record.startsWith('2 ')) {
      const status = record.slice(2, 4);
      if (status[0] && status[0] !== '.') staged += 1;
      if (status[1] && status[1] !== '.') modified += 1;
      if (record.startsWith('2 ')) index += 1;
    } else {
      other += 1;
    }
  }

  return {
    hash: createHash('sha256').update(raw).digest('hex'),
    entries,
    staged,
    modified,
    untracked,
    conflicted,
    other,
  };
}

function describeStatus(status: GitStatusSummary): string {
  return [
    ['staged', status.staged],
    ['modified', status.modified],
    ['untracked', status.untracked],
    ['conflicted', status.conflicted],
    ['other', status.other],
  ]
    .filter((entry) => entry[1] !== 0)
    .map(([name, count]) => `${String(count)} ${String(name)}`)
    .join(', ');
}

function failedInspection(
  configuredPath: string,
  repository: string,
  code: Extract<WorkspaceUnsafeCode, 'path-unavailable' | 'git-inspection-failed'>,
  detail: string,
  canonicalWorkspace: string | null = null,
): WorkspaceInspection {
  return {
    configuredPath,
    canonicalWorkspace,
    requestedRepository: repository,
    eligible: false,
    reasons: [{ code, message: detail }],
    fingerprint: null,
  };
}

function fileIdentity(value: { dev: number | bigint; ino: number | bigint }): FileIdentity {
  return { device: String(value.dev), inode: String(value.ino) };
}

export { samePath } from '../config/paths.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
