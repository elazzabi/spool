import { lstat, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';

import { isTerminalJobState } from '../domain/job.js';
import type { LedgerRepository } from '../ledger/repositories.js';

export const DEFAULT_TERMINAL_LOG_RETENTION_DAYS = 30;

export interface LogRetentionResult {
  removed: string[];
  skippedUnsafe: string[];
}

export async function pruneTerminalAttemptLogs(options: {
  stateDirectory: string;
  ledger: LedgerRepository;
  olderThan: Date;
}): Promise<LogRetentionResult> {
  const logsDirectory = await realpath(path.join(options.stateDirectory, 'logs'));
  const cutoff = options.olderThan.getTime();
  const removed: string[] = [];
  const skippedUnsafe: string[] = [];

  for (const attempt of options.ledger.listAllAttempts()) {
    if (attempt.state !== 'Terminal' || !attempt.terminalAt) continue;
    const job = options.ledger.getJob(attempt.jobId);
    if (!job?.terminalAt || !isTerminalJobState(job.state)) continue;
    if (Date.parse(attempt.terminalAt) > cutoff || Date.parse(job.terminalAt) > cutoff) continue;

    let stats;
    try {
      stats = await lstat(attempt.logPath);
    } catch (error) {
      if (isMissing(error)) continue;
      skippedUnsafe.push(attempt.logPath);
      continue;
    }
    if (!stats.isFile() || stats.isSymbolicLink()) {
      skippedUnsafe.push(attempt.logPath);
      continue;
    }

    let canonicalLog: string;
    try {
      canonicalLog = await realpath(attempt.logPath);
    } catch {
      skippedUnsafe.push(attempt.logPath);
      continue;
    }
    if (path.dirname(canonicalLog) !== logsDirectory) {
      skippedUnsafe.push(attempt.logPath);
      continue;
    }
    try {
      await unlink(canonicalLog);
      removed.push(canonicalLog);
    } catch {
      skippedUnsafe.push(attempt.logPath);
    }
  }

  return { removed, skippedUnsafe };
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}
