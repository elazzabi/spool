import { createHash } from 'node:crypto';
import path from 'node:path';

import { spoolArgv } from '../cli/output.js';
import { deepestContainingDirectory, samePath } from '../config/paths.js';
import type { MDSpoolConfig } from '../config/schema.js';
import {
  isTerminalJobState,
  type Attempt,
  type Job,
  type JobState,
  type TerminalJobState,
} from '../domain/job.js';
import type { LedgerRepository } from '../ledger/repositories.js';
import { fireAndForgetOperational } from '../logging/events.js';
import type { OperationalLogStore } from '../logging/store.js';
import type {
  ProviderAdapter,
  ProviderEvidence,
  ProviderRunResult,
  ProviderTerminalState,
} from '../providers/types.js';
import { redactSensitiveArgv } from '../providers/argv.js';
import type { ReceiptStatus } from '../notes/render.js';
import { weeklyNoteFilename } from '../notes/week.js';
import type { NoteProjector } from './projector.js';

type ObserverOperationalLog = Pick<OperationalLogStore, 'providerTerminal'>;

export class AttemptObserver {
  readonly #config: MDSpoolConfig;
  readonly #ledger: LedgerRepository;
  readonly #projector: NoteProjector;
  readonly #now: () => Date;
  readonly #operationalLog: ObserverOperationalLog | null;
  readonly #terminalAttempts = new Set<string>();

  constructor(options: {
    config: MDSpoolConfig;
    ledger: LedgerRepository;
    projector: NoteProjector;
    operationalLog?: ObserverOperationalLog;
    now?: () => Date;
  }) {
    this.#config = options.config;
    this.#ledger = options.ledger;
    this.#projector = options.projector;
    this.#operationalLog = options.operationalLog ?? null;
    this.#now = options.now ?? (() => new Date());
  }

  recordProcess(attemptId: string, process: { pid: number; processStartIdentity: string }): void {
    this.#ledger.recordAttemptProcess(attemptId, process);
  }

  recordSession(attemptId: string, adapter: ProviderAdapter, sessionId: string): void {
    const attempt = this.#ledger.recordAttemptSession(attemptId, adapter.name, sessionId);
    if (attempt.state === 'Launching' || attempt.state === 'Uncertain') {
      this.#ledger.transitionAttempt(attemptId, 'Running');
    }
    const job = this.#requiredJob(attempt.jobId);
    if (job.state === 'Queued') this.#ledger.transitionJob(job.id, 'Working');
    this.enqueueReceipt(job.id, adapter, `session:${digest(sessionId)}`);
  }

  recordEvidence(attemptId: string, adapter: ProviderAdapter, evidence: ProviderEvidence): void {
    if (!this.#ledger.recordProviderEvidence(attemptId, evidence)) return;
    const attempt = this.#requiredAttempt(attemptId);
    if (evidence.kind === 'session') return;
    if (evidence.kind === 'output') {
      this.enqueueReceipt(attempt.jobId, adapter, `output:${digest(evidence.eventKey)}`);
      return;
    }
    if (evidence.kind === 'terminal') return;

    const job = this.#requiredJob(attempt.jobId);
    if (evidence.state === 'working') {
      this.#moveJob(job, 'Working');
      const open = this.#ledger
        .listInterventions(job.id)
        .filter((intervention) => intervention.closedAt === null)
        .at(-1);
      if (open) {
        this.#ledger.closeIntervention(job.id, open.eventKey, evidence.message ?? 'Agent resumed');
        this.#enqueueIntervention(job, open.eventKey, true, open.prompt, adapter);
      }
    } else if (evidence.state === 'needs_input') {
      if (!adapter.capabilities.needsInput || !evidence.episodeId) {
        this.enqueueReceipt(
          job.id,
          adapter,
          `unavailable:${digest(evidence.eventKey)}`,
          evidence.message ?? 'Provider input request could not be represented safely.',
        );
        return;
      }
      this.#moveJob(job, 'NeedsInput');
      const eventKey = `needs-${digest(evidence.episodeId)}`;
      const prompt = evidence.message ?? 'The agent needs additional input.';
      this.#ledger.recordIntervention(job.id, eventKey, prompt);
      this.#enqueueIntervention(job, eventKey, false, prompt, adapter);
    }
    this.enqueueReceipt(job.id, adapter, `state:${digest(evidence.eventKey)}`, evidence.message);
  }

  finalize(attemptId: string, adapter: ProviderAdapter, result: ProviderRunResult): void {
    const attempt = this.#requiredAttempt(attemptId);
    const job = this.#requiredJob(attempt.jobId);
    if (result.launchState === 'not_started') {
      this.#ledger.transitionAttempt(attempt.id, 'Terminal');
      this.#recordTerminal(job.id, attempt.id, adapter.name, 'failed');
      this.enqueueReceipt(
        job.id,
        adapter,
        `launch-not-started:${attempt.attemptNumber}`,
        result.diagnostics.join('; ') || 'Provider did not start; the job remains queued.',
      );
      return;
    }
    if (result.launchState === 'uncertain' || result.terminalState === 'unproven') {
      if (attempt.state !== 'Uncertain') {
        this.#ledger.markAttemptUncertain(
          attempt.id,
          result.diagnostics.join('; ') || 'Provider launch or terminal state is uncertain',
        );
      }
      this.#recordTerminal(job.id, attempt.id, adapter.name, 'uncertain');
      this.enqueueReceipt(
        job.id,
        adapter,
        `uncertain:${attempt.attemptNumber}`,
        result.diagnostics.join('; ') || 'Provider state is uncertain; MDSpool will not relaunch.',
      );
      return;
    }

    const terminal = result.terminalState;
    for (const intervention of this.#ledger
      .listInterventions(job.id)
      .filter((item) => item.closedAt === null)) {
      this.#ledger.closeIntervention(
        job.id,
        intervention.eventKey,
        `Agent reached terminal state: ${terminal}`,
      );
      this.#enqueueIntervention(job, intervention.eventKey, true, intervention.prompt, adapter);
    }
    this.#ledger.finalizeAttemptAndJob(attempt.id, terminalJobStates[terminal]);
    this.#recordTerminal(
      job.id,
      attempt.id,
      adapter.name,
      result.timedOut ? 'timed_out' : terminal,
    );
    const finalJob = this.#requiredJob(job.id);
    const commandDirectory = attemptWorkspace(attempt);
    const terminalKey = `terminal-${digest(
      result.observation.terminalProof?.proof ?? `${terminal}:${attempt.id}`,
    )}`;
    this.enqueueReceipt(finalJob.id, adapter, `receipt:${terminalKey}`);
    if (terminal === 'completed') {
      const command = inspectArgv(adapter, this.#requiredAttempt(attempt.id).sessionId);
      if (this.#isCurrentNote(finalJob.sourcePath)) {
        this.#projector.enqueueSource(finalJob, `complete:${finalJob.id}:${terminalKey}`, {
          kind: 'complete',
          taskId: finalJob.sourceMarker,
          eventKey: `review-${digest(attempt.id)}`,
          reviewText: 'Check agent output using command',
          ...(command ? { inspectCommand: command } : {}),
          ...(commandDirectory ? { inspectCommandDirectory: commandDirectory } : {}),
        });
      } else {
        this.#projector.enqueueSource(finalJob, `check-source:${finalJob.id}:${terminalKey}`, {
          kind: 'check-source',
          taskId: finalJob.sourceMarker,
        });
        this.#projector.enqueueCurrentWeek(
          finalJob,
          `current-review:${finalJob.id}:${terminalKey}`,
          {
            eventKey: `review-${digest(attempt.id)}`,
            taskId: finalJob.sourceMarker,
            checked: false,
            text: 'Check agent output using command',
            ...(command ? { command } : {}),
            ...(commandDirectory ? { commandDirectory } : {}),
          },
        );
      }
    } else {
      const command = inspectArgv(adapter, this.#requiredAttempt(attempt.id).sessionId);
      if (command) {
        const actionKey = `${terminal}-action-${digest(attempt.id)}`;
        const text = `Inspect ${terminal} agent session using command`;
        if (this.#isCurrentNote(finalJob.sourcePath)) {
          this.#projector.enqueueSource(finalJob, `terminal-action:${finalJob.id}:${actionKey}`, {
            kind: 'follow-up',
            taskId: finalJob.sourceMarker,
            eventKey: actionKey,
            checked: false,
            text,
            command,
            ...(commandDirectory ? { commandDirectory } : {}),
          });
        } else {
          this.#projector.enqueueCurrentWeek(
            finalJob,
            `current-terminal-action:${finalJob.id}:${actionKey}`,
            {
              eventKey: actionKey,
              taskId: finalJob.sourceMarker,
              checked: false,
              text,
              command,
              ...(commandDirectory ? { commandDirectory } : {}),
            },
          );
        }
      }
    }
  }

  releaseAttempt(attemptId: string): void {
    this.#terminalAttempts.delete(attemptId);
  }

  enqueueReceipt(
    jobId: string,
    adapter: ProviderAdapter,
    revision: string,
    contextOverride?: string,
    workspaceQuarantine?: string | null,
  ): void {
    const job = this.#requiredJob(jobId);
    const attempt = this.#ledger.listAttempts(jobId).at(-1) ?? null;
    const command = inspectArgv(adapter, attempt?.sessionId ?? null);
    const commandDirectory = attemptWorkspace(attempt);
    this.#projector.enqueueSource(job, `receipt:${job.id}:${revision}`, {
      kind: 'receipt',
      taskId: job.sourceMarker,
      receipt: {
        taskId: job.sourceMarker,
        sessionId: attempt?.sessionId ?? null,
        status: receiptStatus(job),
        updatedAt: attempt?.updatedAt ?? job.updatedAt,
        context: contextOverride ?? job.context,
        cancelCommand: spoolArgv(this.#config, 'cancel', job.sourceMarker),
        ...(command ? { inspectCommand: command } : {}),
        ...(commandDirectory ? { inspectCommandDirectory: commandDirectory } : {}),
        ...(attempt?.latestOutput ? { latestOutput: attempt.latestOutput } : {}),
        ...(workspaceQuarantine ? { workspaceQuarantine } : {}),
      },
    });
  }

  #enqueueIntervention(
    job: Job,
    eventKey: string,
    checked: boolean,
    prompt: string,
    adapter: ProviderAdapter,
  ): void {
    const attempt = this.#ledger.listAttempts(job.id).at(-1);
    const command = resumeArgv(adapter, attempt?.sessionId ?? null);
    const commandDirectory = attemptWorkspace(attempt ?? null);
    this.#projector.enqueueSource(
      job,
      `intervention:${job.id}:${eventKey}:${checked ? 'closed' : 'open'}`,
      {
        kind: checked ? 'resolve-follow-up' : 'follow-up',
        taskId: job.sourceMarker,
        eventKey,
        checked,
        text: `Agent needs input: ${prompt}`,
        ...(command ? { command } : {}),
        ...(commandDirectory ? { commandDirectory } : {}),
      },
    );
    if (!this.#isCurrentNote(job.sourcePath)) {
      this.#projector.enqueueCurrentWeek(
        job,
        `current-intervention:${job.id}:${eventKey}:${checked ? 'closed' : 'open'}`,
        {
          eventKey,
          taskId: job.sourceMarker,
          checked,
          text: `Agent needs input: ${prompt}`,
          ...(command ? { command } : {}),
          ...(commandDirectory ? { commandDirectory } : {}),
        },
      );
    }
  }

  #moveJob(job: Job, target: JobState): void {
    if (job.state === target) return;
    if (job.state === 'Queued' && target !== 'Cancelled') {
      this.#ledger.transitionJob(job.id, 'Working');
      if (target !== 'Working') this.#ledger.transitionJob(job.id, target);
      return;
    }
    this.#ledger.transitionJob(job.id, target);
  }

  #isCurrentNote(sourcePath: string): boolean {
    const owningRoot = deepestContainingDirectory(this.#config.vaults, sourcePath);
    if (!owningRoot) return false;
    const currentNotePath = path.join(
      owningRoot,
      weeklyNoteFilename(this.#now(), this.#config.timeZone),
    );
    return samePath(path.resolve(sourcePath), path.resolve(currentNotePath));
  }

  #requiredJob(jobId: string): Job {
    const job = this.#ledger.getJob(jobId);
    if (!job) throw new Error(`Unknown job ${jobId}`);
    return job;
  }

  #requiredAttempt(attemptId: string): Attempt {
    const attempt = this.#ledger.getAttempt(attemptId);
    if (!attempt) throw new Error(`Unknown attempt ${attemptId}`);
    return attempt;
  }

  #recordTerminal(
    jobId: string,
    attemptId: string,
    provider: string,
    outcome: Parameters<OperationalLogStore['providerTerminal']>[3],
  ): void {
    if (this.#terminalAttempts.has(attemptId)) return;
    this.#terminalAttempts.add(attemptId);
    fireAndForgetOperational(() =>
      this.#operationalLog?.providerTerminal(jobId, attemptId, provider, outcome),
    );
  }
}

function receiptStatus(job: Job): ReceiptStatus {
  if (job.cancellationRequested && !isTerminalJobState(job.state)) {
    return 'Cancellation requested';
  }
  return job.state === 'NeedsInput' ? 'Needs input' : job.state;
}

const terminalJobStates: Record<ProviderTerminalState, TerminalJobState> = {
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

function inspectArgv(adapter: ProviderAdapter, sessionId: string | null): string[] | null {
  if (!sessionId) return null;
  const command = adapter.inspectCommand(sessionId);
  return command ? redactSensitiveArgv([command.executable, ...command.args]) : null;
}

function resumeArgv(adapter: ProviderAdapter, sessionId: string | null): string[] | null {
  if (!sessionId) return null;
  const command = adapter.capabilities.resume
    ? (adapter.resumeCommand?.(sessionId) ?? adapter.inspectCommand(sessionId))
    : adapter.inspectCommand(sessionId);
  return command ? redactSensitiveArgv([command.executable, ...command.args]) : null;
}

function attemptWorkspace(attempt: Attempt | null): string | null {
  const workspace = attempt?.launchMetadata?.canonicalWorkspace;
  return typeof workspace === 'string' && workspace.length > 0 ? workspace : null;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 24);
}
