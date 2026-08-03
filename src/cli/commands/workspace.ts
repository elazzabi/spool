import { randomUUID } from 'node:crypto';

import type { MDSpoolConfig } from '../../config/schema.js';
import { openLedgerDatabase } from '../../ledger/database.js';
import {
  currentProcessStartIdentity,
  DaemonLock,
  DaemonLockConflictError,
  type DaemonOwnershipIdentity,
} from '../../ledger/daemon-lock.js';
import { LedgerRepository } from '../../ledger/repositories.js';
import { WorkspacePool } from '../../workspaces/pool.js';
import { parseWorkspaceCliAcknowledgmentRequest } from '../../workspaces/acknowledgment.js';
import { sanitizeTerminalText, type StaticCliPresenter } from '../output.js';

export function workspaceAcknowledgmentLines(disposition: string | null): string[] {
  const request = parseWorkspaceCliAcknowledgmentRequest(disposition);
  if (!request) return [];
  return request.phase === 'requested'
    ? ['Acknowledgment: requested']
    : ['Acknowledgment: refused', `Reason: ${sanitizeTerminalText(request.reason)}`];
}

export async function listWorkspaces(config: MDSpoolConfig) {
  const database = openLedgerDatabase(config.stateDirectory);
  try {
    const ledger = new LedgerRepository(database);
    const pool = new WorkspacePool({ repositories: config.repositories, ledger });
    const repositories = await Promise.all(
      config.repositories.map(async (repository) => ({
        repository: repository.repository,
        candidates: await pool.inspect(repository.repository),
      })),
    );
    return { repositories, leases: ledger.listLeases() };
  } finally {
    database.close();
  }
}

export async function acknowledgeWorkspace(config: MDSpoolConfig, workspace: string) {
  const database = openLedgerDatabase(config.stateDirectory);
  const daemonLock = new DaemonLock(database);
  const owner: DaemonOwnershipIdentity = {
    nonce: randomUUID(),
    pid: process.pid,
    processStartIdentity: currentProcessStartIdentity(),
  };
  let ownsDaemonLock = false;
  try {
    try {
      daemonLock.acquire(owner, Math.max(60_000, config.pollIntervalSeconds * 3_000));
      ownsDaemonLock = true;
    } catch (error) {
      if (error instanceof DaemonLockConflictError) {
        const ledger = new LedgerRepository(database);
        return {
          kind: 'requested' as const,
          lease: ledger.requestWorkspaceCliAcknowledgment(workspace),
        };
      }
      throw error;
    }
    const ledger = new LedgerRepository(database);
    const pool = new WorkspacePool({ repositories: config.repositories, ledger });
    return await pool.acknowledge(workspace);
  } finally {
    if (ownsDaemonLock) daemonLock.release(owner);
    database.close();
  }
}

export function presentWorkspaceReport(
  report: Awaited<ReturnType<typeof listWorkspaces>>,
  presenter: StaticCliPresenter,
): void {
  presenter.intro('MDSpool workspaces');
  presenter.section('Repositories', [
    `${String(report.repositories.length)} configured ${report.repositories.length === 1 ? 'repository' : 'repositories'}`,
  ]);
  for (const repository of report.repositories) {
    const repositoryName = sanitizeTerminalText(repository.repository);
    const count = repository.candidates.length;
    presenter.section(
      `${repositoryName} pool`,
      count === 0
        ? ['No configured workspaces.']
        : repository.candidates.flatMap((candidate, index) => [
            ...(index === 0 ? [] : ['']),
            `Path: ${sanitizeTerminalText(candidate.configuredPath)}`,
            `Status: ${sanitizeTerminalText(candidate.code)}`,
            `Detail: ${sanitizeTerminalText(candidate.message)}`,
          ]),
    );
  }

  presenter.section(
    'Leases',
    report.leases.length === 0
      ? ['No workspace leases.']
      : report.leases.flatMap((lease, index) => [
          ...(index === 0 ? [] : ['']),
          `Path: ${sanitizeTerminalText(lease.canonicalWorkspace)}`,
          `State: ${sanitizeTerminalText(lease.state)}`,
          `Job ID: ${sanitizeTerminalText(lease.jobId)}`,
          ...workspaceAcknowledgmentLines(lease.disposition),
        ]),
  );
  presenter.outro('Workspace inspection complete');
}
