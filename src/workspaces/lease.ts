import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { WorkspaceFingerprint } from './git.js';

const execFileAsync = promisify(execFile);
export const WORKSPACE_SENTINEL_NAME = 'mdspool-workspace-lease.json';
const MAX_SENTINEL_BYTES = 1024 * 1024;

export interface ProcessBirthIdentity {
  pid: number;
  startIdentity: string;
}

export type ProcessMatch = 'match' | 'different' | 'not-running' | 'unknown';

export interface ProcessIdentityProvider {
  current(): Promise<ProcessBirthIdentity>;
  compare(pid: number, startIdentity: string): Promise<ProcessMatch>;
}

export interface WorkspaceSentinelPayload {
  version: 1;
  ownerNonce: string;
  jobId: string;
  attemptId: string;
  pid: number;
  processStartIdentity: string;
  canonicalWorkspace: string;
  requestedRepository: string;
  baseline: WorkspaceFingerprint;
  createdAt: string;
}

export interface SentinelOwnerInput {
  jobId: string;
  attemptId: string;
  canonicalWorkspace: string;
  requestedRepository: string;
  baseline: WorkspaceFingerprint;
}

export type SentinelAcquireResult =
  | { kind: 'acquired'; payload: WorkspaceSentinelPayload; recoveredStale: boolean }
  | { kind: 'busy'; owner: WorkspaceSentinelPayload; reason: string }
  | { kind: 'unsafe'; reason: string };

export interface SentinelVerification {
  valid: boolean;
  reason: string | null;
  payload: WorkspaceSentinelPayload | null;
  missing?: boolean;
}

export interface WorkspaceSentinelManagerOptions {
  ownerNonce?: string;
  processIdentity?: ProcessIdentityProvider;
  now?: () => Date;
}

interface ReadSentinel {
  payload: WorkspaceSentinelPayload;
  device: string;
  inode: string;
}

type CreateSentinelResult =
  { kind: 'created' } | { kind: 'exists' } | { kind: 'error'; reason: string };

export class WorkspaceSentinelManager {
  readonly ownerNonce: string;
  readonly #processIdentity: ProcessIdentityProvider;
  readonly #now: () => Date;
  #currentIdentity: Promise<ProcessBirthIdentity> | null = null;

  constructor(options: WorkspaceSentinelManagerOptions = {}) {
    this.ownerNonce = options.ownerNonce ?? randomUUID();
    this.#processIdentity = options.processIdentity ?? new SystemProcessIdentityProvider();
    this.#now = options.now ?? (() => new Date());
  }

  async acquire(
    commonDirectory: string,
    input: SentinelOwnerInput,
  ): Promise<SentinelAcquireResult> {
    const identity = await this.#identity();
    const payload: WorkspaceSentinelPayload = {
      version: 1,
      ownerNonce: this.ownerNonce,
      jobId: input.jobId,
      attemptId: input.attemptId,
      pid: identity.pid,
      processStartIdentity: identity.startIdentity,
      canonicalWorkspace: input.canonicalWorkspace,
      requestedRepository: input.requestedRepository,
      baseline: input.baseline,
      createdAt: this.#now().toISOString(),
    };
    const first = await this.#create(commonDirectory, payload);
    if (first.kind === 'created') return { kind: 'acquired', payload, recoveredStale: false };
    if (first.kind === 'error') return { kind: 'unsafe', reason: first.reason };

    let existing: ReadSentinel;
    try {
      existing = await readSentinel(commonDirectory);
    } catch (error) {
      return { kind: 'unsafe', reason: errorMessage(error) };
    }
    const match = await this.#processIdentity.compare(
      existing.payload.pid,
      existing.payload.processStartIdentity,
    );
    if (match === 'match' || match === 'unknown') {
      return {
        kind: 'busy',
        owner: existing.payload,
        reason:
          match === 'match'
            ? `Workspace is leased by live process ${existing.payload.pid}`
            : `Cannot safely determine whether lease process ${existing.payload.pid} is still live`,
      };
    }

    if (!(await removeSameSentinel(commonDirectory, existing))) {
      return { kind: 'unsafe', reason: 'Workspace sentinel changed during stale recovery' };
    }
    const recovered = await this.#create(commonDirectory, payload);
    if (recovered.kind === 'created') return { kind: 'acquired', payload, recoveredStale: true };
    if (recovered.kind === 'exists') {
      try {
        const owner = await readSentinel(commonDirectory);
        return {
          kind: 'busy',
          owner: owner.payload,
          reason: 'Another owner acquired the workspace during stale recovery',
        };
      } catch (error) {
        return { kind: 'unsafe', reason: errorMessage(error) };
      }
    }
    return { kind: 'unsafe', reason: recovered.reason };
  }

  async verifyOwned(
    commonDirectory: string,
    expected: WorkspaceSentinelPayload,
  ): Promise<SentinelVerification> {
    try {
      const current = await readSentinel(commonDirectory);
      const valid = ownershipKey(current.payload) === ownershipKey(expected);
      return {
        valid,
        reason: valid ? null : 'Workspace sentinel belongs to another owner',
        payload: current.payload,
      };
    } catch (error) {
      return {
        valid: false,
        reason: errorMessage(error),
        payload: null,
        ...(isNodeError(error) && error.code === 'ENOENT' ? { missing: true } : {}),
      };
    }
  }

  async releaseOwned(
    commonDirectory: string,
    expected: WorkspaceSentinelPayload,
  ): Promise<SentinelVerification> {
    if (expected.ownerNonce !== this.ownerNonce) {
      return {
        valid: false,
        reason: 'Workspace sentinel is not owned by this MDSpool process',
        payload: expected,
      };
    }
    try {
      const current = await readSentinel(commonDirectory);
      if (ownershipKey(current.payload) !== ownershipKey(expected)) {
        return {
          valid: false,
          reason: 'Workspace sentinel belongs to another owner',
          payload: current.payload,
        };
      }
      if (!(await removeSameSentinel(commonDirectory, current))) {
        return {
          valid: false,
          reason: 'Workspace sentinel changed before release',
          payload: current.payload,
        };
      }
      return { valid: true, reason: null, payload: current.payload };
    } catch (error) {
      return {
        valid: false,
        reason: errorMessage(error),
        payload: null,
        ...(isNodeError(error) && error.code === 'ENOENT' ? { missing: true } : {}),
      };
    }
  }

  async releaseAbandoned(
    commonDirectory: string,
    expected: WorkspaceSentinelPayload,
  ): Promise<SentinelVerification> {
    try {
      const current = await readSentinel(commonDirectory);
      if (ownershipKey(current.payload) !== ownershipKey(expected)) {
        return {
          valid: false,
          reason: 'Workspace sentinel belongs to another owner',
          payload: current.payload,
        };
      }
      const match = await this.#processIdentity.compare(
        current.payload.pid,
        current.payload.processStartIdentity,
      );
      if (match === 'match' || match === 'unknown') {
        return {
          valid: false,
          reason: 'Workspace sentinel is still owned by a live or unknown process',
          payload: current.payload,
        };
      }
      if (!(await removeSameSentinel(commonDirectory, current))) {
        return {
          valid: false,
          reason: 'Workspace sentinel changed before abandoned release',
          payload: current.payload,
        };
      }
      return { valid: true, reason: null, payload: current.payload };
    } catch (error) {
      return { valid: false, reason: errorMessage(error), payload: null };
    }
  }

  async availability(commonDirectory: string): Promise<'available' | 'busy' | 'unsafe'> {
    let current: ReadSentinel;
    try {
      current = await readSentinel(commonDirectory);
    } catch (error) {
      return isNodeError(error) && error.code === 'ENOENT' ? 'available' : 'unsafe';
    }
    const match = await this.#processIdentity.compare(
      current.payload.pid,
      current.payload.processStartIdentity,
    );
    return match === 'different' || match === 'not-running' ? 'available' : 'busy';
  }

  async releaseQuarantined(
    commonDirectory: string,
    expected: { jobId: string; attemptId: string; canonicalWorkspace: string },
  ): Promise<SentinelVerification> {
    try {
      const current = await readSentinel(commonDirectory);
      if (
        current.payload.jobId !== expected.jobId ||
        current.payload.attemptId !== expected.attemptId ||
        current.payload.canonicalWorkspace !== expected.canonicalWorkspace
      ) {
        return {
          valid: false,
          reason: 'Workspace sentinel does not match the quarantined ledger lease',
          payload: current.payload,
        };
      }
      if (current.payload.ownerNonce !== this.ownerNonce) {
        const match = await this.#processIdentity.compare(
          current.payload.pid,
          current.payload.processStartIdentity,
        );
        if (match === 'match' || match === 'unknown') {
          return {
            valid: false,
            reason: 'The quarantined sentinel is still owned by another live or unknown process',
            payload: current.payload,
          };
        }
      }
      if (!(await removeSameSentinel(commonDirectory, current))) {
        return {
          valid: false,
          reason: 'Workspace sentinel changed before acknowledgement',
          payload: current.payload,
        };
      }
      return { valid: true, reason: null, payload: current.payload };
    } catch (error) {
      return {
        valid: false,
        reason: errorMessage(error),
        payload: null,
        ...(isNodeError(error) && error.code === 'ENOENT' ? { missing: true } : {}),
      };
    }
  }

  async verifyQuarantined(
    commonDirectory: string,
    expected: { jobId: string; attemptId: string; canonicalWorkspace: string },
  ): Promise<SentinelVerification> {
    try {
      const current = await readSentinel(commonDirectory);
      const valid =
        current.payload.jobId === expected.jobId &&
        current.payload.attemptId === expected.attemptId &&
        current.payload.canonicalWorkspace === expected.canonicalWorkspace;
      return {
        valid,
        reason: valid ? null : 'Workspace sentinel does not match the quarantined ledger lease',
        payload: current.payload,
      };
    } catch (error) {
      return {
        valid: false,
        reason: errorMessage(error),
        payload: null,
        ...(isNodeError(error) && error.code === 'ENOENT' ? { missing: true } : {}),
      };
    }
  }

  async read(commonDirectory: string): Promise<WorkspaceSentinelPayload> {
    return (await readSentinel(commonDirectory)).payload;
  }

  async #identity(): Promise<ProcessBirthIdentity> {
    this.#currentIdentity ??= this.#processIdentity.current();
    return this.#currentIdentity;
  }

  async #create(
    commonDirectory: string,
    payload: WorkspaceSentinelPayload,
  ): Promise<CreateSentinelResult> {
    const sentinelPath = path.join(commonDirectory, WORKSPACE_SENTINEL_NAME);
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag();
    let handle;
    try {
      handle = await open(sentinelPath, flags, 0o600);
      await handle.writeFile(`${JSON.stringify(payload)}\n`, 'utf8');
      await handle.sync();
      return { kind: 'created' };
    } catch (error) {
      if (isNodeError(error) && error.code === 'EEXIST') return { kind: 'exists' };
      return {
        kind: 'error',
        reason: `Cannot create workspace sentinel: ${errorMessage(error)}`,
      };
    } finally {
      await handle?.close();
    }
  }
}

export class SystemProcessIdentityProvider implements ProcessIdentityProvider {
  async current(): Promise<ProcessBirthIdentity> {
    const startIdentity = await processStartIdentity(process.pid);
    if (!startIdentity) throw new Error('Cannot determine the current process birth identity');
    return { pid: process.pid, startIdentity };
  }

  async compare(pid: number, startIdentity: string): Promise<ProcessMatch> {
    const current = await processStartIdentity(pid);
    if (current === null) return processExists(pid) ? 'unknown' : 'not-running';
    return current === startIdentity ? 'match' : 'different';
  }
}

async function readSentinel(commonDirectory: string): Promise<ReadSentinel> {
  const sentinelPath = path.join(commonDirectory, WORKSPACE_SENTINEL_NAME);
  const handle = await open(sentinelPath, constants.O_RDONLY | noFollowFlag());
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('Workspace sentinel is not a regular file');
    if (info.size > MAX_SENTINEL_BYTES) throw new Error('Workspace sentinel is unexpectedly large');
    const raw = await handle.readFile('utf8');
    const payload = parsePayload(raw);
    return { payload, device: String(info.dev), inode: String(info.ino) };
  } finally {
    await handle.close();
  }
}

async function removeSameSentinel(
  commonDirectory: string,
  expected: ReadSentinel,
): Promise<boolean> {
  const sentinelPath = path.join(commonDirectory, WORKSPACE_SENTINEL_NAME);
  let current;
  try {
    current = await lstat(sentinelPath);
  } catch {
    return false;
  }
  if (String(current.dev) !== expected.device || String(current.ino) !== expected.inode)
    return false;
  await unlink(sentinelPath);
  return true;
}

function parsePayload(raw: string): WorkspaceSentinelPayload {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Workspace sentinel is not valid JSON');
  }
  if (!isRecord(value)) throw new Error('Workspace sentinel payload is invalid');
  for (const key of [
    'ownerNonce',
    'jobId',
    'attemptId',
    'processStartIdentity',
    'canonicalWorkspace',
    'requestedRepository',
    'createdAt',
  ]) {
    if (typeof value[key] !== 'string' || value[key].length === 0) {
      throw new Error(`Workspace sentinel has invalid ${key}`);
    }
  }
  if (value.version !== 1 || !Number.isSafeInteger(value.pid) || !isRecord(value.baseline)) {
    throw new Error('Workspace sentinel payload is invalid');
  }
  return value as unknown as WorkspaceSentinelPayload;
}

function ownershipKey(payload: WorkspaceSentinelPayload): string {
  return JSON.stringify([
    payload.ownerNonce,
    payload.jobId,
    payload.attemptId,
    payload.pid,
    payload.processStartIdentity,
    payload.canonicalWorkspace,
  ]);
}

async function processStartIdentity(pid: number): Promise<string | null> {
  if (process.platform === 'linux') {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      const fields = stat.slice(close + 2).split(' ');
      const startTicks = fields[19];
      return startTicks ? `linux:${startTicks}` : null;
    } catch {
      return null;
    }
  }
  if (process.platform !== 'win32') {
    try {
      const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)], {
        timeout: 2_000,
        maxBuffer: 16 * 1024,
        encoding: 'utf8',
      });
      const value = stdout.trim();
      return value ? `${process.platform}:${value}` : null;
    } catch {
      return null;
    }
  }
  return null;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === 'EPERM';
  }
}

function noFollowFlag(): number {
  return 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
