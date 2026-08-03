import type { WorkspaceLease } from '../domain/job.js';
import type { WorkspaceFingerprint } from './git.js';
import type { WorkspaceSentinelPayload } from './lease.js';
import type { WorkspaceLeaseHandle } from './pool.js';

interface PersistedWorkspaceLeaseHandleV1 {
  version: 1;
  repository: string;
  configuredPath: string;
  canonicalWorkspace: string;
  baseline: WorkspaceFingerprint;
  sentinel: WorkspaceSentinelPayload;
}

export function serializeWorkspaceLeaseHandle(
  handle: Omit<WorkspaceLeaseHandle, 'ledgerLease'>,
): Record<string, unknown> {
  return structuredClone({
    version: 1,
    repository: handle.repository,
    configuredPath: handle.configuredPath,
    canonicalWorkspace: handle.canonicalWorkspace,
    baseline: handle.baseline,
    sentinel: handle.sentinel,
  });
}

export function parseWorkspaceLeaseHandle(
  metadata: Record<string, unknown> | null,
  ledgerLease: WorkspaceLease,
): WorkspaceLeaseHandle | null {
  if (metadata === null) return null;
  if (metadata.version !== 1) {
    throw new Error(
      `Workspace lease metadata for ${ledgerLease.canonicalWorkspace} has an unsupported version`,
    );
  }
  if (!isNonemptyString(metadata.repository)) throw invalid(ledgerLease, 'repository');
  if (!isNonemptyString(metadata.configuredPath)) throw invalid(ledgerLease, 'configuredPath');
  if (!isNonemptyString(metadata.canonicalWorkspace)) {
    throw invalid(ledgerLease, 'canonicalWorkspace');
  }
  if (!isFingerprint(metadata.baseline)) throw invalid(ledgerLease, 'baseline');
  if (!isSentinel(metadata.sentinel)) throw invalid(ledgerLease, 'sentinel');

  const persisted = metadata as unknown as PersistedWorkspaceLeaseHandleV1;
  if (
    persisted.canonicalWorkspace !== ledgerLease.canonicalWorkspace ||
    persisted.sentinel.canonicalWorkspace !== ledgerLease.canonicalWorkspace ||
    persisted.sentinel.jobId !== ledgerLease.jobId ||
    persisted.sentinel.attemptId !== ledgerLease.attemptId ||
    persisted.repository !== persisted.sentinel.requestedRepository
  ) {
    throw new Error(
      `Workspace lease metadata for ${ledgerLease.canonicalWorkspace} conflicts with the durable lease`,
    );
  }
  return { ...persisted, ledgerLease };
}

function isFingerprint(value: unknown): value is WorkspaceFingerprint {
  if (!isRecord(value)) return false;
  return (
    isNonemptyString(value.repository) &&
    isNonemptyString(value.canonicalWorkspace) &&
    isFileIdentity(value.workspaceIdentity) &&
    isNonemptyString(value.gitDirectory) &&
    isFileIdentity(value.gitDirectoryIdentity) &&
    isNonemptyString(value.gitCommonDirectory) &&
    isFileIdentity(value.gitCommonDirectoryIdentity) &&
    (value.branch === null || typeof value.branch === 'string') &&
    typeof value.detached === 'boolean' &&
    isNonemptyString(value.head) &&
    Array.isArray(value.remotes) &&
    value.remotes.every(isRemote) &&
    (value.originRepository === null || typeof value.originRepository === 'string') &&
    isStatus(value.status) &&
    Array.isArray(value.operations) &&
    value.operations.every(
      (operation) =>
        isRecord(operation) && isNonemptyString(operation.kind) && isNonemptyString(operation.path),
    )
  );
}

function isSentinel(value: unknown): value is WorkspaceSentinelPayload {
  if (!isRecord(value) || value.version !== 1 || !Number.isSafeInteger(value.pid)) return false;
  return (
    [
      'ownerNonce',
      'jobId',
      'attemptId',
      'processStartIdentity',
      'canonicalWorkspace',
      'requestedRepository',
      'createdAt',
    ].every((key) => isNonemptyString(value[key])) && isFingerprint(value.baseline)
  );
}

function isFileIdentity(value: unknown): boolean {
  return isRecord(value) && isNonemptyString(value.device) && isNonemptyString(value.inode);
}

function isRemote(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonemptyString(value.name) &&
    isStringArray(value.urls) &&
    isStringArray(value.pushUrls)
  );
}

function isStatus(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.hash === 'string' &&
    isStringArray(value.entries) &&
    ['staged', 'modified', 'untracked', 'conflicted', 'other'].every((key) =>
      Number.isSafeInteger(value[key]),
    )
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(lease: WorkspaceLease, field: string): Error {
  return new Error(
    `Workspace lease metadata for ${lease.canonicalWorkspace} has an invalid ${field}`,
  );
}
