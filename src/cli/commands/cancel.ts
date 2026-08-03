import type { MDSpoolConfig } from '../../config/schema.js';
import { openLedgerDatabase } from '../../ledger/database.js';
import { LedgerRepository } from '../../ledger/repositories.js';

export function requestJobCancellation(
  config: MDSpoolConfig,
  taskOrJobId: string,
): { taskId: string; jobId: string; state: string; cancellationRequested: boolean } {
  const database = openLedgerDatabase(config.stateDirectory);
  try {
    const ledger = new LedgerRepository(database);
    const job = ledger.getJob(taskOrJobId) ?? ledger.getJobByMarker(taskOrJobId);
    if (!job) throw new Error(`No durable job matches task or job ID ${taskOrJobId}`);
    const updated = ledger.requestCancellation(job.id);
    return {
      taskId: updated.sourceMarker,
      jobId: updated.id,
      state: updated.state,
      cancellationRequested: updated.cancellationRequested,
    };
  } finally {
    database.close();
  }
}
