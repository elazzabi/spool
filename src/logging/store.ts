import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import path from 'node:path';

import {
  MAX_OPERATIONAL_RECORD_BYTES,
  OPERATIONAL_EVENT_VERSION,
  serializeOperationalEvent,
  type DispatchWaitReason,
  type OperationalEvent,
  type OperationalRuntimeMode,
  type ProviderTerminalOutcome,
  type WorkspaceQuarantineReason,
} from './events.js';

export const OPERATIONAL_LOG_DIRECTORY = 'operational-logs';
export const OPERATIONAL_ACTIVE_FILE = 'operations-current.jsonl';
export const OPERATIONAL_SEGMENT_BYTES = 8 * 1_024 * 1_024;
export const OPERATIONAL_MAX_SEGMENTS = 8;
export const OPERATIONAL_MAX_QUEUED_RECORDS = 1_024;
export const OPERATIONAL_ROTATE_AFTER_MS = 24 * 60 * 60 * 1_000;
export const OPERATIONAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const OPERATIONAL_LOG_FAILURE_WARNING =
  'Operational logging disabled (LOGGING_UNAVAILABLE).';

const ARCHIVE_PATTERN = /^operations-(\d{12})\.jsonl$/u;
const PRUNE_INTERVAL_MS = 60 * 60 * 1_000;

interface SegmentIdentity {
  readonly device: number;
  readonly inode: number;
}

interface QueuedRecord {
  readonly event: OperationalEvent;
  readonly encoded: Buffer;
  readonly resolve: (written: boolean) => void;
}

export interface OperationalLogStoreOptions {
  readonly stateDirectory: string;
  readonly runtimeId: string;
  readonly mode: OperationalRuntimeMode;
  readonly now?: () => Date;
  readonly onWarning?: (warning: string) => void;
}

type OperationalFileWrite = (buffer: Buffer) => Promise<{ readonly bytesWritten: number }>;

/** @internal Exported for deterministic short-write fault injection. */
export async function writeOperationalBufferFully(
  write: OperationalFileWrite,
  encoded: Buffer,
): Promise<void> {
  let offset = 0;
  while (offset < encoded.byteLength) {
    const { bytesWritten } = await write(encoded.subarray(offset));
    if (bytesWritten <= 0) throw new Error('operational log write made no progress');
    offset += bytesWritten;
  }
}

/**
 * Owner-only, bounded operational history. Constructing the sink is inert;
 * activate() must only be called after the caller acquires runtime ownership.
 */
export class OperationalLogStore {
  readonly #stateDirectory: string;
  readonly #directory: string;
  readonly #activePath: string;
  readonly #runtimeId: string;
  readonly #mode: OperationalRuntimeMode;
  readonly #now: () => Date;
  readonly #onWarning: (warning: string) => void;
  readonly #queue: QueuedRecord[] = [];
  #state: 'dormant' | 'active' | 'disabled' | 'closing' | 'closed' = 'dormant';
  #directoryIdentity: SegmentIdentity | null = null;
  #activeIdentity: SegmentIdentity | null = null;
  #activeHandle: FileHandle | null = null;
  #activeBytes = 0;
  #activeOpenedAt = 0;
  #lastPruneAt = 0;
  #draining: Promise<void> | null = null;
  #closingPromise: Promise<void> | null = null;
  #currentEvent: OperationalEvent | null = null;
  #droppedRecords = 0;
  #warned = false;

  constructor(options: OperationalLogStoreOptions) {
    this.#stateDirectory = path.resolve(options.stateDirectory);
    this.#directory = path.join(this.#stateDirectory, OPERATIONAL_LOG_DIRECTORY);
    this.#activePath = path.join(this.#directory, OPERATIONAL_ACTIVE_FILE);
    this.#runtimeId = options.runtimeId;
    this.#mode = options.mode;
    this.#now = options.now ?? (() => new Date());
    this.#onWarning = options.onWarning ?? ((warning) => process.stderr.write(`${warning}\n`));
  }

  get active(): boolean {
    return this.#state === 'active';
  }

  async activate(): Promise<boolean> {
    if (this.#state === 'active') return true;
    if (this.#state !== 'dormant') return false;
    try {
      await this.#validateStateDirectory();
      await this.#openDirectory();
      await this.#pruneArchives(true);
      await this.#rotatePriorActive();
      await this.#pruneArchives(true);
      await this.#openActive();
      this.#state = 'active';
      return true;
    } catch {
      await this.#disable();
      return false;
    }
  }

  runtimeStarted(): Promise<boolean> {
    return this.#enqueue({
      ...this.#base('runtime.started', 'info'),
      mode: this.#mode,
    });
  }

  runtimeStopped(outcome: 'clean' | 'failed'): Promise<boolean> {
    return this.#enqueue({
      ...this.#base('runtime.stopped', 'info'),
      mode: this.#mode,
      outcome,
    });
  }

  reconciliationCompleted(counts: {
    readonly claimedJobs: number;
    readonly launchedJobs: number;
    readonly waitingJobs: number;
    readonly projected: number;
    readonly blockedProjections: number;
  }): Promise<boolean> {
    return this.#enqueue({
      ...this.#base('reconciliation.completed', 'info'),
      ...counts,
    });
  }

  reconciliationFailed(): Promise<boolean> {
    return this.#enqueue({
      ...this.#base('reconciliation.failed', 'error'),
      reason: 'internal_error',
    });
  }

  jobClaimed(jobId: string, provider: string): Promise<boolean> {
    return this.#enqueue({
      ...this.#base('job.claimed', 'info'),
      jobId,
      provider,
    });
  }

  dispatchWaiting(jobId: string, reason: DispatchWaitReason): Promise<boolean> {
    return this.#enqueue({
      ...this.#base('dispatch.waiting', 'warn'),
      jobId,
      reason,
    });
  }

  workspaceAcquired(jobId: string, attemptId: string): Promise<boolean> {
    return this.#enqueue({
      ...this.#base('workspace.acquired', 'info'),
      jobId,
      attemptId,
    });
  }

  workspaceReleased(jobId: string, attemptId: string): Promise<boolean> {
    return this.#enqueue({
      ...this.#base('workspace.released', 'info'),
      jobId,
      attemptId,
    });
  }

  workspaceQuarantined(
    jobId: string,
    attemptId: string,
    reason: WorkspaceQuarantineReason,
  ): Promise<boolean> {
    return this.#enqueue({
      ...this.#base('workspace.quarantined', 'warn'),
      jobId,
      attemptId,
      reason,
    });
  }

  providerLaunched(jobId: string, attemptId: string, provider: string): Promise<boolean> {
    return this.#enqueue({
      ...this.#base('provider.launched', 'info'),
      jobId,
      attemptId,
      provider,
    });
  }

  providerTerminal(
    jobId: string,
    attemptId: string,
    provider: string,
    outcome: ProviderTerminalOutcome,
  ): Promise<boolean> {
    const severity = outcome === 'completed' ? 'info' : outcome === 'uncertain' ? 'warn' : 'error';
    return this.#enqueue({
      ...this.#base('provider.terminal', severity),
      jobId,
      attemptId,
      provider,
      outcome,
    });
  }

  async close(): Promise<void> {
    if (this.#state === 'closed') return;
    if (this.#closingPromise) return this.#closingPromise;
    if (this.#state === 'dormant' || this.#state === 'disabled') {
      this.#state = 'closed';
      return;
    }
    this.#closingPromise = this.#finishClose();
    return this.#closingPromise;
  }

  async #finishClose(): Promise<void> {
    this.#state = 'closing';
    do {
      this.#startDrain();
      await this.#draining;
    } while (this.#draining || this.#queue.length > 0);
    await this.#closeActive();
    this.#state = 'closed';
  }

  #base<TType extends OperationalEvent['type'], TSeverity extends OperationalEvent['severity']>(
    type: TType,
    severity: TSeverity,
  ): {
    version: typeof OPERATIONAL_EVENT_VERSION;
    eventId: string;
    timestamp: string;
    runtimeId: string;
    type: TType;
    severity: TSeverity;
  } {
    return {
      version: OPERATIONAL_EVENT_VERSION,
      eventId: randomUUID(),
      timestamp: this.#now().toISOString(),
      runtimeId: this.#runtimeId,
      type,
      severity,
    };
  }

  #enqueue(event: OperationalEvent): Promise<boolean> {
    if (this.#state !== 'active') return Promise.resolve(false);
    let encoded: Buffer;
    try {
      encoded = serializeOperationalEvent(event);
    } catch {
      return Promise.resolve(false);
    }

    if (this.#isCoalescedQuietPass(event)) return Promise.resolve(false);

    const inUse = this.#queue.length + (this.#currentEvent ? 1 : 0);
    if (inUse >= OPERATIONAL_MAX_QUEUED_RECORDS) {
      if (event.severity !== 'info') {
        const replaceAt = this.#queue.findIndex((item) => item.event.severity === 'info');
        if (replaceAt >= 0) {
          const [dropped] = this.#queue.splice(replaceAt, 1);
          dropped?.resolve(false);
          this.#droppedRecords += 1;
        } else {
          this.#droppedRecords += 1;
          return Promise.resolve(false);
        }
      } else {
        this.#droppedRecords += 1;
        return Promise.resolve(false);
      }
    }

    return new Promise<boolean>((resolve) => {
      this.#queue.push({ event, encoded, resolve });
      this.#startDrain();
    });
  }

  #isCoalescedQuietPass(event: OperationalEvent): boolean {
    if (
      event.type !== 'reconciliation.completed' ||
      event.claimedJobs !== 0 ||
      event.launchedJobs !== 0 ||
      event.waitingJobs !== 0 ||
      event.projected !== 0 ||
      event.blockedProjections !== 0
    ) {
      return false;
    }
    return [this.#currentEvent, ...this.#queue.map((item) => item.event)].some(
      (candidate) =>
        candidate?.type === 'reconciliation.completed' &&
        candidate.claimedJobs === 0 &&
        candidate.launchedJobs === 0 &&
        candidate.waitingJobs === 0 &&
        candidate.projected === 0 &&
        candidate.blockedProjections === 0,
    );
  }

  #startDrain(): void {
    if (this.#draining) return;
    this.#draining = this.#drain().finally(() => {
      this.#draining = null;
      if ((this.#state === 'active' || this.#state === 'closing') && this.#queue.length > 0) {
        this.#startDrain();
      }
    });
  }

  async #drain(): Promise<void> {
    while ((this.#state === 'active' || this.#state === 'closing') && this.#queue.length > 0) {
      const item = this.#queue.shift();
      if (!item) break;
      this.#currentEvent = item.event;
      try {
        await this.#write(item.encoded);
        item.resolve(true);
      } catch {
        await this.#disable();
        item.resolve(false);
        break;
      } finally {
        this.#currentEvent = null;
      }
    }

    if (
      (this.#state === 'active' || this.#state === 'closing') &&
      this.#queue.length === 0 &&
      this.#droppedRecords > 0
    ) {
      const count = this.#droppedRecords;
      this.#droppedRecords = 0;
      const event: OperationalEvent = {
        ...this.#base('logging.records_dropped', 'warn'),
        count,
        reason: 'queue_overload',
      };
      try {
        await this.#write(serializeOperationalEvent(event));
      } catch {
        await this.#disable();
      }
    }
  }

  async #write(encoded: Buffer): Promise<void> {
    if (encoded.byteLength > MAX_OPERATIONAL_RECORD_BYTES) {
      throw new Error('oversized operational record');
    }
    await this.#assertDirectoryIdentity();
    if (
      this.#activeBytes + encoded.byteLength > OPERATIONAL_SEGMENT_BYTES ||
      this.#now().getTime() - this.#activeOpenedAt >= OPERATIONAL_ROTATE_AFTER_MS
    ) {
      await this.#rotateActive();
    }
    const handle = this.#activeHandle;
    const identity = this.#activeIdentity;
    if (!handle || !identity) throw new Error('operational log is not open');
    const current = await handle.stat();
    if (
      !isSafeSegment(current) ||
      current.dev !== identity.device ||
      current.ino !== identity.inode
    ) {
      throw new Error('operational log identity changed');
    }
    await writeOperationalBufferFully((buffer) => handle.write(buffer), encoded);
    await handle.sync();
    this.#activeBytes += encoded.byteLength;
    if (this.#now().getTime() - this.#lastPruneAt >= PRUNE_INTERVAL_MS) {
      await this.#pruneArchives(false);
    }
  }

  async #validateStateDirectory(): Promise<void> {
    const stats = await lstat(this.#stateDirectory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('unsafe state directory');
    if ((await realpath(this.#stateDirectory)) !== this.#stateDirectory) {
      throw new Error('state directory identity changed');
    }
    assertOwnerPrivate(stats, 0o700);
  }

  async #openDirectory(): Promise<void> {
    try {
      await mkdir(this.#directory, { mode: 0o700 });
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
    }
    const stats = await lstat(this.#directory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('unsafe log directory');
    if ((await realpath(this.#directory)) !== this.#directory) {
      throw new Error('log directory identity changed');
    }
    assertOwnerPrivate(stats, 0o700);
    if (process.platform !== 'win32') await chmod(this.#directory, 0o700);
    this.#directoryIdentity = identity(stats);
  }

  async #assertDirectoryIdentity(): Promise<void> {
    const expected = this.#directoryIdentity;
    if (!expected) throw new Error('operational log directory is not pinned');
    const stats = await lstat(this.#directory);
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      stats.dev !== expected.device ||
      stats.ino !== expected.inode ||
      (await realpath(this.#directory)) !== this.#directory
    ) {
      throw new Error('operational log directory identity changed');
    }
    assertOwnerPrivate(stats, 0o700);
  }

  async #openActive(): Promise<void> {
    await this.#assertDirectoryIdentity();
    const handle = await open(
      this.#activePath,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      const stats = await handle.stat();
      const pathStats = await lstat(this.#activePath);
      if (
        !isSafeSegment(stats) ||
        !isSafeSegment(pathStats) ||
        stats.dev !== pathStats.dev ||
        stats.ino !== pathStats.ino
      ) {
        throw new Error('unsafe active operational log');
      }
      assertOwnerPrivate(stats, 0o600);
      if (process.platform !== 'win32') await handle.chmod(0o600);
      this.#activeHandle = handle;
      this.#activeIdentity = identity(stats);
      this.#activeBytes = stats.size;
      this.#activeOpenedAt = this.#now().getTime();
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async #rotatePriorActive(): Promise<void> {
    let stats;
    try {
      stats = await lstat(this.#activePath);
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return;
      throw error;
    }
    if (!isSafeSegment(stats)) throw new Error('unsafe prior active operational log');
    assertOwnerPrivate(stats, 0o600);
    if (stats.size === 0) return;
    await this.#rotatePath(identity(stats));
  }

  async #rotateActive(): Promise<void> {
    const expected = this.#activeIdentity;
    if (!expected) throw new Error('active operational log is not pinned');
    await this.#closeActive();
    await this.#rotatePath(expected);
    await this.#openActive();
  }

  async #rotatePath(expected: SegmentIdentity): Promise<void> {
    await this.#assertDirectoryIdentity();
    const stats = await lstat(this.#activePath);
    if (!isSafeSegment(stats) || stats.dev !== expected.device || stats.ino !== expected.inode) {
      throw new Error('active operational log identity changed before rotation');
    }
    assertOwnerPrivate(stats, 0o600);
    const archives = await this.#listArchives();
    while (archives.length >= OPERATIONAL_MAX_SEGMENTS - 1) {
      const oldest = archives.shift();
      if (!oldest) break;
      await this.#removeArchive(oldest.name);
    }
    const lastGeneration = archives.at(-1)?.generation ?? 0;
    const generation = lastGeneration + 1;
    if (!Number.isSafeInteger(generation) || generation > 999_999_999_999) {
      throw new Error('operational log generation exhausted');
    }
    const archivePath = path.join(
      this.#directory,
      `operations-${String(generation).padStart(12, '0')}.jsonl`,
    );
    await rename(this.#activePath, archivePath);
    const archived = await lstat(archivePath);
    if (!isSafeSegment(archived)) throw new Error('unsafe rotated operational log');
    assertOwnerPrivate(archived, 0o600);
  }

  async #pruneArchives(force: boolean): Promise<void> {
    const now = this.#now().getTime();
    if (!force && now - this.#lastPruneAt < PRUNE_INTERVAL_MS) return;
    const archives = await this.#listArchives();
    const cutoff = now - OPERATIONAL_RETENTION_MS;
    for (const archive of archives) {
      if (archive.modifiedAt < cutoff) await this.#removeArchive(archive.name);
    }
    const retained = await this.#listArchives();
    while (retained.length > OPERATIONAL_MAX_SEGMENTS - 1) {
      const oldest = retained.shift();
      if (!oldest) break;
      await this.#removeArchive(oldest.name);
    }
    this.#lastPruneAt = now;
  }

  async #listArchives(): Promise<Array<{ name: string; generation: number; modifiedAt: number }>> {
    await this.#assertDirectoryIdentity();
    const entries = await readdir(this.#directory, { withFileTypes: true });
    const archives: Array<{ name: string; generation: number; modifiedAt: number }> = [];
    for (const entry of entries) {
      const match = ARCHIVE_PATTERN.exec(entry.name);
      if (!match) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('unsafe operational archive');
      const generation = Number(match[1]);
      if (!Number.isSafeInteger(generation)) throw new Error('invalid operational generation');
      const stats = await lstat(path.join(this.#directory, entry.name));
      if (!isSafeSegment(stats)) throw new Error('unsafe operational archive');
      assertOwnerPrivate(stats, 0o600);
      archives.push({ name: entry.name, generation, modifiedAt: stats.mtimeMs });
    }
    return archives.sort((left, right) => left.generation - right.generation);
  }

  async #removeArchive(name: string): Promise<void> {
    if (!ARCHIVE_PATTERN.test(name)) throw new Error('refused non-operational archive');
    await this.#assertDirectoryIdentity();
    const archivePath = path.join(this.#directory, name);
    const stats = await lstat(archivePath);
    if (!isSafeSegment(stats)) throw new Error('unsafe operational archive');
    assertOwnerPrivate(stats, 0o600);
    await unlink(archivePath);
  }

  async #closeActive(): Promise<void> {
    const handle = this.#activeHandle;
    this.#activeHandle = null;
    this.#activeIdentity = null;
    if (handle) await handle.close();
  }

  async #disable(): Promise<void> {
    if (this.#state !== 'closed') this.#state = 'disabled';
    try {
      await this.#closeActive();
    } catch {
      // The original storage failure remains the reason the sink is disabled.
    }
    for (const item of this.#queue.splice(0)) item.resolve(false);
    if (!this.#warned) {
      this.#warned = true;
      try {
        this.#onWarning(OPERATIONAL_LOG_FAILURE_WARNING);
      } catch {
        // Logging diagnostics must not widen the runtime failure domain.
      }
    }
  }
}

function identity(stats: { readonly dev: number; readonly ino: number }): SegmentIdentity {
  return {
    device: stats.dev,
    inode: stats.ino,
  };
}

function isSafeSegment(stats: {
  readonly isFile: () => boolean;
  readonly isSymbolicLink: () => boolean;
  readonly nlink: number;
}): boolean {
  return stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1;
}

function assertOwnerPrivate(
  stats: { readonly uid: number; readonly mode: number },
  expectedMode: number,
): void {
  if (process.platform === 'win32') return;
  if ((stats.mode & 0o777) !== expectedMode) throw new Error('unsafe operational log mode');
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) throw new Error('unsafe operational log owner');
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}
