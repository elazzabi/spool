import type { MDSpoolConfig } from '../../config/schema.js';
import { openLedgerDatabase } from '../../ledger/database.js';
import { LedgerRepository } from '../../ledger/repositories.js';
import { sanitizeTerminalText, type StaticCliPresenter } from '../output.js';
import { workspaceAcknowledgmentLines } from './workspace.js';

export interface DurableStatusReport {
  jobs: Array<{
    taskId: string;
    jobId: string;
    attemptId: string | null;
    provider: string;
    state: string;
    cancellationRequested: boolean;
    sessionId: string | null;
    attemptState: string | null;
    uncertaintyReason: string | null;
    logPath: string | null;
    updatedAt: string;
  }>;
  leases: Array<{
    workspace: string;
    state: string;
    jobId: string;
    disposition: string | null;
  }>;
}

export function collectStatus(config: MDSpoolConfig): DurableStatusReport {
  const database = openLedgerDatabase(config.stateDirectory);
  try {
    const ledger = new LedgerRepository(database);
    return {
      jobs: ledger.listJobs().map((job) => {
        const attempt = ledger.listAttempts(job.id).at(-1) ?? null;
        return {
          taskId: job.sourceMarker,
          jobId: job.id,
          attemptId: attempt?.id ?? null,
          provider: job.provider,
          state: job.state,
          cancellationRequested: job.cancellationRequested,
          sessionId: attempt?.sessionId ?? null,
          attemptState: attempt?.state ?? null,
          uncertaintyReason: attempt?.uncertaintyReason ?? null,
          logPath: attempt?.logPath ?? null,
          updatedAt: attempt?.updatedAt ?? job.updatedAt,
        };
      }),
      leases: ledger.listLeases().map((lease) => ({
        workspace: lease.canonicalWorkspace,
        state: lease.state,
        jobId: lease.jobId,
        disposition: lease.disposition,
      })),
    };
  } finally {
    database.close();
  }
}

export function formatStatus(report: DurableStatusReport): string {
  const lines = ['Jobs:'];
  if (report.jobs.length === 0) lines.push('  none');
  for (const job of report.jobs) {
    lines.push(
      `  ${job.taskId} | job ${job.jobId} | ${job.provider} | ${job.state}${job.attemptId && job.attemptState ? ` | attempt ${job.attemptId} ${job.attemptState}` : ''}${job.sessionId ? ` | session ${job.sessionId}` : ''}${job.uncertaintyReason ? ` | ${job.uncertaintyReason}` : ''}${job.logPath ? ` | log ${job.logPath}` : ''} | updated ${job.updatedAt}${job.cancellationRequested ? ' | cancellation requested' : ''}`,
    );
  }
  lines.push('Workspaces:');
  if (report.leases.length === 0) lines.push('  none');
  for (const lease of report.leases) {
    lines.push(`  ${lease.workspace} | ${lease.state} | job ${lease.jobId}`);
  }
  return lines.join('\n');
}

export function presentStatusReport(
  report: DurableStatusReport,
  presenter: StaticCliPresenter,
): void {
  presenter.intro('MDSpool status');
  presenter.section('Jobs', jobLines(report.jobs));
  presenter.section('Workspaces', workspaceLines(report.leases));
  presenter.outro('Status inspection complete');
}

function jobLines(jobs: DurableStatusReport['jobs']): string[] {
  if (jobs.length === 0) return ['No durable jobs.'];
  return jobs.flatMap((job, index) => [
    ...(index === 0 ? [] : ['']),
    `Task: ${sanitizeTerminalText(job.taskId)}`,
    `Job ID: ${sanitizeTerminalText(job.jobId)}`,
    `Provider: ${sanitizeTerminalText(job.provider)}`,
    `State: ${sanitizeTerminalText(job.state)}`,
    ...(job.attemptId === null ? [] : [`Attempt: ${sanitizeTerminalText(job.attemptId)}`]),
    ...(job.attemptState === null
      ? []
      : [`Attempt state: ${sanitizeTerminalText(job.attemptState)}`]),
    ...(job.sessionId === null ? [] : [`Session: ${sanitizeTerminalText(job.sessionId)}`]),
    ...(job.uncertaintyReason === null
      ? []
      : [`Uncertainty: ${sanitizeTerminalText(job.uncertaintyReason)}`]),
    ...(job.logPath === null ? [] : [`Log: ${sanitizeTerminalText(job.logPath)}`]),
    `Updated: ${sanitizeTerminalText(job.updatedAt)}`,
    ...(job.cancellationRequested ? ['Cancellation: requested'] : []),
  ]);
}

function workspaceLines(leases: DurableStatusReport['leases']): string[] {
  if (leases.length === 0) return ['No workspace leases.'];
  return leases.flatMap((lease, index) => {
    const acknowledgment = workspaceAcknowledgmentLines(lease.disposition);
    return [
      ...(index === 0 ? [] : ['']),
      `Path: ${sanitizeTerminalText(lease.workspace)}`,
      `State: ${sanitizeTerminalText(lease.state)}`,
      `Job ID: ${sanitizeTerminalText(lease.jobId)}`,
      ...acknowledgment,
      ...(acknowledgment.length > 0 || lease.disposition === null
        ? []
        : [`Disposition: ${sanitizeTerminalText(lease.disposition)}`]),
    ];
  });
}
