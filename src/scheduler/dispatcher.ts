import { execFile } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { spoolArgv } from '../cli/output.js';
import type { SpoolConfig } from '../config/schema.js';
import { isTerminalJobState, type Attempt, type Job } from '../domain/job.js';
import type { LedgerRepository } from '../ledger/repositories.js';
import { fireAndForgetOperational } from '../logging/events.js';
import type { OperationalLogStore } from '../logging/store.js';
import { renderCommandText } from '../notes/render.js';
import { runProviderProcess } from '../providers/process-runner.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type {
  ProviderAdapter,
  ProviderLaunchInput,
  ProviderRunCallbacks,
  ProviderRunResult,
} from '../providers/types.js';
import type { WorkspaceLeaseHandle, WorkspaceReconcileResult } from '../workspaces/pool.js';
import type { WorkspaceCandidateResult, WorkspacePool } from '../workspaces/pool.js';
import { serializeWorkspaceLeaseHandle } from '../workspaces/persisted-lease.js';
import {
  workspaceAcknowledgmentEventKey,
  workspaceAcknowledgmentText,
} from '../workspaces/acknowledgment.js';
import type { AttemptObserver } from './observer.js';
import type { NoteProjector } from './projector.js';

export type ProviderRunner = (
  request: ReturnType<ProviderAdapter['createLaunch']>,
  callbacks?: ProviderRunCallbacks,
) => Promise<ProviderRunResult>;

export type ProviderControlRunner = (
  executable: string,
  args: readonly string[],
) => Promise<boolean>;

export interface DispatchResult {
  launched: string[];
  queuedForCapacity: string[];
  unavailable: Array<{ jobId: string; reason: string }>;
}

interface CapacityUnavailable {
  kind: 'capacity';
  reason: string;
}

interface ActiveRun {
  attemptId: string;
  jobId: string;
  abort: AbortController;
  promise: Promise<void>;
}

type DispatcherOperationalLog = Pick<
  OperationalLogStore,
  | 'dispatchWaiting'
  | 'workspaceAcquired'
  | 'workspaceReleased'
  | 'workspaceQuarantined'
  | 'providerLaunched'
  | 'providerTerminal'
>;

export class JobDispatcher {
  readonly #config: SpoolConfig;
  readonly #ledger: LedgerRepository;
  readonly #providers: ProviderRegistry;
  readonly #workspaces: WorkspacePool;
  readonly #observer: AttemptObserver;
  readonly #projector: NoteProjector;
  readonly #runner: ProviderRunner;
  readonly #controlRunner: ProviderControlRunner;
  readonly #operationalLog: DispatcherOperationalLog | null;
  readonly #active = new Map<string, ActiveRun>();
  readonly #dispatchWaitReasons = new Map<
    string,
    Parameters<OperationalLogStore['dispatchWaiting']>[1]
  >();
  readonly #workspaceOutcomes = new Set<string>();

  constructor(options: {
    config: SpoolConfig;
    ledger: LedgerRepository;
    providers: ProviderRegistry;
    workspaces: WorkspacePool;
    observer: AttemptObserver;
    projector: NoteProjector;
    runner?: ProviderRunner;
    controlRunner?: ProviderControlRunner;
    operationalLog?: DispatcherOperationalLog;
  }) {
    this.#config = options.config;
    this.#ledger = options.ledger;
    this.#providers = options.providers;
    this.#workspaces = options.workspaces;
    this.#observer = options.observer;
    this.#projector = options.projector;
    this.#runner = options.runner ?? runProviderProcess;
    this.#controlRunner = options.controlRunner ?? runControlCommand;
    this.#operationalLog = options.operationalLog ?? null;
  }

  async dispatch(): Promise<DispatchResult> {
    const result: DispatchResult = { launched: [], queuedForCapacity: [], unavailable: [] };
    const jobs = this.#ledger.listDispatchableJobs();
    const dispatchableIds = new Set(jobs.map((job) => job.id));
    for (const jobId of this.#dispatchWaitReasons.keys()) {
      if (!dispatchableIds.has(jobId)) this.#dispatchWaitReasons.delete(jobId);
    }
    for (const job of jobs) {
      const adapter = this.#providers.get(job.provider);
      if (!adapter?.capabilities.launch) {
        const reason = `Provider ${job.provider} is unavailable or failed installed preflight`;
        this.#queueDiagnostic(job, reason);
        this.#recordDispatchWaiting(job.id, 'provider_unavailable');
        result.unavailable.push({ jobId: job.id, reason });
        continue;
      }
      const initialReceipt = this.#ledger.getProjection(`initial-receipt:${job.id}`);
      if (initialReceipt?.state !== 'Applied') {
        this.#recordDispatchWaiting(
          job.id,
          initialReceipt?.state === 'Blocked' ? 'projection_blocked' : 'initial_receipt_pending',
        );
        result.unavailable.push({
          jobId: job.id,
          reason: 'Initial durable note receipt has not been applied yet',
        });
        continue;
      }
      if (!job.repository) {
        const reason = 'The directive has no direct or ancestor repository context';
        this.#queueDiagnostic(job, reason);
        this.#recordDispatchWaiting(job.id, 'repository_missing');
        result.unavailable.push({
          jobId: job.id,
          reason,
        });
        continue;
      }
      const launch = await this.#prepare(job, adapter);
      if (typeof launch !== 'string') {
        this.#queueDiagnostic(job, launch.reason);
        result.queuedForCapacity.push(job.id);
      } else if (launch === 'launched') {
        this.#dispatchWaitReasons.delete(job.id);
        result.launched.push(job.id);
      } else {
        this.#queueDiagnostic(job, launch);
        result.unavailable.push({ jobId: job.id, reason: launch });
      }
    }
    return result;
  }

  async cancel(jobId: string): Promise<boolean> {
    const attempt = this.#ledger.listAttempts(jobId).at(-1);
    if (!attempt) return false;
    const active = this.#active.get(attempt.id);
    if (active) {
      active.abort.abort();
      return true;
    }
    if (!attempt.sessionId) return false;
    const adapter = this.#providers.get(this.#ledger.getJob(jobId)?.provider ?? '');
    const command = adapter?.cancelCommand?.(attempt.sessionId) ?? null;
    if (!command) return false;
    // Command success is only a request acknowledgement. A later provider observation supplies
    // terminal proof before the job can become Cancelled.
    return this.#controlRunner(command.executable, command.args);
  }

  async waitForIdle(): Promise<void> {
    while (this.#active.size > 0) {
      await Promise.all([...this.#active.values()].map((active) => active.promise));
    }
  }

  async shutdown(): Promise<void> {
    for (const active of this.#active.values()) active.abort.abort();
    await this.waitForIdle();
  }

  activeAttemptIds(): string[] {
    return [...this.#active.keys()];
  }

  reportDisposition(
    jobId: string,
    handle: WorkspaceLeaseHandle,
    disposition: WorkspaceReconcileResult,
  ): void {
    const job = this.#ledger.getJob(jobId);
    const adapter = job ? this.#providers.get(job.provider) : null;
    this.#recordWorkspaceDisposition(jobId, handle.sentinel.attemptId, disposition);
    if (job && adapter && disposition.kind === 'quarantined') {
      this.#enqueueWorkspaceAction(job, handle, disposition.detail.summary, adapter);
    }
    this.#releaseAttemptState(handle.sentinel.attemptId);
  }

  async #prepare(job: Job, adapter: ProviderAdapter): Promise<string | CapacityUnavailable> {
    const capacity = await this.#workspaces.capacity(job.repository ?? '');
    if (capacity.kind === 'unconfigured') {
      this.#recordDispatchWaiting(job.id, 'workspace_unconfigured');
      return `No workspace pool is configured for ${job.repository ?? 'this repository'}`;
    }
    if (capacity.kind === 'capacity-unavailable') {
      this.#recordDispatchWaiting(job.id, 'workspace_capacity');
      return {
        kind: 'capacity',
        reason: formatCapacityDiagnostic(this.#config, capacity.repository, capacity.inspected),
      };
    }
    const logPath = path.join(this.#config.stateDirectory, 'logs', `${randomUUID()}.log`);
    closeSync(openSync(logPath, 'wx', 0o600));
    const attempt = this.#ledger.prepareAttempt(job.id, logPath);
    const acquired = await this.#workspaces.acquire({
      repository: job.repository ?? '',
      jobId: job.id,
      attemptId: attempt.id,
    });
    if (acquired.kind !== 'acquired') {
      this.#ledger.transitionAttempt(attempt.id, 'Terminal');
      this.#recordDispatchWaiting(
        job.id,
        acquired.kind === 'capacity-unavailable' ? 'workspace_capacity' : 'workspace_unconfigured',
      );
      return acquired.kind === 'capacity-unavailable'
        ? {
            kind: 'capacity',
            reason: formatCapacityDiagnostic(this.#config, acquired.repository, acquired.inspected),
          }
        : `No workspace pool is configured for ${job.repository ?? 'this repository'}`;
    }
    fireAndForgetOperational(() => this.#operationalLog?.workspaceAcquired(job.id, attempt.id));

    const verified = await this.#workspaces.verifyBeforeSpawn(acquired.handle);
    if (verified.kind === 'quarantined') {
      this.#ledger.transitionAttempt(attempt.id, 'Terminal');
      this.#recordDispatchWaiting(job.id, 'workspace_quarantined');
      this.#recordWorkspaceQuarantined(job.id, attempt.id, 'changed_before_spawn');
      this.#enqueueWorkspaceAction(job, acquired.handle, verified.detail.summary, adapter);
      this.#releaseAttemptState(attempt.id);
      return 'Workspace changed before provider spawn and was quarantined';
    }
    this.#ledger.recordAttemptLaunchMetadata(
      attempt.id,
      serializeWorkspaceLeaseHandle(acquired.handle),
    );
    this.#ledger.transitionAttempt(attempt.id, 'Launching');
    const started = await this.#start(job, attempt, adapter, acquired.handle);
    return started === true ? 'launched' : started;
  }

  async #start(
    job: Job,
    attempt: Attempt,
    adapter: ProviderAdapter,
    handle: WorkspaceLeaseHandle,
  ): Promise<true | string> {
    const abort = new AbortController();
    let request;
    try {
      const input: ProviderLaunchInput = {
        cwd: handle.canonicalWorkspace,
        logPath: attempt.logPath,
        prompt: compileDelegationPrompt(job, handle.canonicalWorkspace),
      };
      request = adapter.createLaunch(input);
      request = { ...request, signal: abort.signal };
    } catch (error) {
      this.#ledger.transitionAttempt(attempt.id, 'Terminal');
      const disposition = await this.#workspaces.reconcileDisposition(handle);
      if (disposition.kind === 'quarantined') {
        this.#enqueueWorkspaceAction(job, handle, disposition.detail.summary, adapter);
      }
      this.#recordWorkspaceDisposition(job.id, attempt.id, disposition);
      fireAndForgetOperational(() =>
        this.#operationalLog?.providerTerminal(job.id, attempt.id, adapter.name, 'failed'),
      );
      const message = error instanceof Error ? error.message : String(error);
      this.#observer.enqueueReceipt(
        job.id,
        adapter,
        `launch-request:${attempt.attemptNumber}`,
        message,
      );
      this.#releaseAttemptState(attempt.id);
      return message;
    }

    const promise = this.#runner(request, {
      onProcessStarted: (identity) => {
        this.#observer.recordProcess(attempt.id, identity);
        fireAndForgetOperational(() =>
          this.#operationalLog?.providerLaunched(job.id, attempt.id, adapter.name),
        );
      },
      onSessionIdentity: (identity) =>
        this.#observer.recordSession(attempt.id, adapter, identity.sessionId),
      onEvidence: (evidence) => this.#observer.recordEvidence(attempt.id, adapter, evidence),
    })
      .then(async (runResult) => {
        this.#observer.finalize(attempt.id, adapter, runResult);
        const disposition = await this.#workspaces.reconcileDisposition(handle);
        if (disposition.kind === 'quarantined') {
          this.#enqueueWorkspaceAction(job, handle, disposition.detail.summary, adapter);
        }
        this.#recordWorkspaceDisposition(job.id, attempt.id, disposition);
      })
      .catch(async (error: unknown) => {
        const current = this.#ledger.getAttempt(attempt.id);
        if (current && current.state !== 'Uncertain' && current.state !== 'Terminal') {
          this.#ledger.markAttemptUncertain(
            attempt.id,
            error instanceof Error ? error.message : String(error),
          );
          fireAndForgetOperational(() =>
            this.#operationalLog?.providerTerminal(job.id, attempt.id, adapter.name, 'uncertain'),
          );
        }
        this.#observer.enqueueReceipt(
          job.id,
          adapter,
          `runner-error:${attempt.attemptNumber}`,
          'Provider runner failed after launch; spool will not relaunch automatically.',
        );
        const disposition = await this.#workspaces.reconcileDisposition(handle);
        if (disposition.kind === 'quarantined') {
          this.#enqueueWorkspaceAction(job, handle, disposition.detail.summary, adapter);
        }
        this.#recordWorkspaceDisposition(job.id, attempt.id, disposition);
      })
      .finally(() => {
        this.#active.delete(attempt.id);
        this.#releaseAttemptState(attempt.id);
      });
    this.#active.set(attempt.id, { attemptId: attempt.id, jobId: job.id, abort, promise });
    return true;
  }

  #enqueueWorkspaceAction(
    job: Job,
    handle: WorkspaceLeaseHandle,
    reason: string,
    adapter: ProviderAdapter,
  ): void {
    const key = workspaceAcknowledgmentEventKey(handle.sentinel.attemptId, 0);
    const text = `${workspaceAcknowledgmentText(handle.baseline.branch)}. ${reason}`;
    this.#ledger.recordFollowUp(job.id, key, text);
    this.#projector.enqueueSource(job, `workspace-action:${job.id}:${key}`, {
      kind: 'follow-up',
      taskId: job.sourceMarker,
      eventKey: key,
      checked: false,
      text,
    });
    this.#observer.enqueueReceipt(job.id, adapter, `quarantine:${key}`, undefined, reason);
  }

  #queueDiagnostic(job: Job, reason: string): void {
    const key = `queue-diagnostic:${job.id}:${digestPath(reason)}`;
    if (this.#ledger.getProjection(key)) return;
    this.#projector.enqueueSource(job, key, {
      kind: 'receipt',
      taskId: job.sourceMarker,
      receipt: {
        taskId: job.sourceMarker,
        sessionId: this.#ledger.listAttempts(job.id).at(-1)?.sessionId ?? null,
        status: 'Queued',
        updatedAt: job.updatedAt,
        context: reason,
        cancelCommand: spoolArgv(this.#config, 'cancel', job.sourceMarker),
      },
    });
  }

  #recordDispatchWaiting(
    jobId: string,
    reason: Parameters<OperationalLogStore['dispatchWaiting']>[1],
  ): void {
    if (this.#dispatchWaitReasons.get(jobId) === reason) return;
    this.#dispatchWaitReasons.set(jobId, reason);
    fireAndForgetOperational(() => this.#operationalLog?.dispatchWaiting(jobId, reason));
  }

  #recordWorkspaceDisposition(
    jobId: string,
    attemptId: string,
    disposition: WorkspaceReconcileResult,
  ): void {
    if (disposition.kind === 'released') {
      const key = `${attemptId}:released`;
      if (this.#workspaceOutcomes.has(key)) return;
      this.#workspaceOutcomes.add(key);
      fireAndForgetOperational(() => this.#operationalLog?.workspaceReleased(jobId, attemptId));
      return;
    }
    const reason = disposition.detail.code === 'release-failed' ? 'release_failed' : 'unsafe_state';
    this.#recordWorkspaceQuarantined(jobId, attemptId, reason);
  }

  #recordWorkspaceQuarantined(
    jobId: string,
    attemptId: string,
    reason: Parameters<OperationalLogStore['workspaceQuarantined']>[2],
  ): void {
    const key = `${attemptId}:quarantined`;
    if (this.#workspaceOutcomes.has(key)) return;
    this.#workspaceOutcomes.add(key);
    fireAndForgetOperational(() =>
      this.#operationalLog?.workspaceQuarantined(jobId, attemptId, reason),
    );
  }

  #releaseAttemptState(attemptId: string): void {
    this.#workspaceOutcomes.delete(`${attemptId}:released`);
    this.#workspaceOutcomes.delete(`${attemptId}:quarantined`);
    this.#observer.releaseAttempt(attemptId);
  }
}

function formatCapacityDiagnostic(
  config: SpoolConfig,
  repository: string,
  candidates: readonly WorkspaceCandidateResult[],
): string {
  return [
    `Waiting for a safe workspace for ${repository}:`,
    ...candidates.flatMap((candidate) => [
      `- ${candidate.configuredPath}: ${candidate.message}`,
      `  Action: ${capacityAction(config, candidate)}`,
    ]),
  ].join('\n');
}

function capacityAction(config: SpoolConfig, candidate: WorkspaceCandidateResult): string {
  const blocker = candidate.blockingLease;
  if (blocker?.leaseState === 'Quarantined') {
    return `inspect the workspace, make it clean, then acknowledge it: ${renderCommandText(
      spoolArgv(config, 'workspace', 'acknowledge', candidate.configuredPath),
    )}`;
  }
  if (blocker && !isTerminalJobState(blocker.jobState)) {
    return `wait for that task to finish, or cancel it: ${renderCommandText(
      spoolArgv(config, 'cancel', blocker.taskId),
    )}`;
  }
  if (blocker) {
    return 'wait for spool to finish releasing the completed task';
  }
  const reasons = candidate.inspection?.reasons ?? [];
  if (reasons.some((reason) => reason.code === 'worktree-dirty')) {
    return `finish, commit, stash, or remove the manual changes until this is empty: ${renderCommandText(
      ['git', '-C', candidate.configuredPath, 'status', '--short'],
    )}`;
  }
  if (reasons.some((reason) => reason.code === 'git-operation-active')) {
    return 'finish or abort the Git operation in this workspace';
  }
  if (candidate.code === 'leased') {
    return `wait for the owning spool process, then recheck: ${renderCommandText(
      spoolArgv(config, 'workspace', 'list'),
    )}`;
  }
  return `fix the reported workspace problem, then recheck: ${renderCommandText(
    spoolArgv(config, 'workspace', 'list'),
  )}`;
}

export function compileDelegationPrompt(job: Job, canonicalWorkspace: string): string {
  return [
    'spool delegated this task from a Markdown source note.',
    `Source note: ${job.sourcePath}`,
    `Canonical workspace: ${canonicalWorkspace}`,
    '',
    'Safety boundary:',
    '- Return results to this local agent session by default.',
    '- Do not create GitHub comments, reviews, approvals, requests for changes, issues, or any other GitHub write unless the task explicitly asks you to do so.',
    '- A pull-request URL provides context only; it does not authorize GitHub writes unless the task explicitly requests them.',
    '',
    'Task context:',
    job.context,
  ].join('\n');
}

function runControlCommand(executable: string, args: readonly string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      executable,
      [...args],
      {
        shell: false,
        timeout: 10_000,
        maxBuffer: 256 * 1024,
        windowsHide: true,
      },
      (error) => resolve(error === null),
    );
  });
}

function digestPath(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url').slice(0, 32);
}
