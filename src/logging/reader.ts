import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

import {
  MAX_OPERATIONAL_RECORD_BYTES,
  tryParseOperationalEvent,
  type OperationalEvent,
} from './events.js';
import {
  OPERATIONAL_ACTIVE_FILE,
  OPERATIONAL_LOG_DIRECTORY,
  OPERATIONAL_MAX_SEGMENTS,
  OPERATIONAL_SEGMENT_BYTES,
} from './store.js';

export const OPERATIONAL_FOLLOW_INITIAL_RECORDS = 100;
export const OPERATIONAL_FOLLOW_POLL_MS = 1_000;
export const OPERATIONAL_LOG_UNSAFE_ERROR = 'Operational log storage is unsafe (LOGS_UNSAFE).';

const ARCHIVE_PATTERN = /^operations-(\d{12})\.jsonl$/u;
const READ_CHUNK_BYTES = MAX_OPERATIONAL_RECORD_BYTES;

interface Segment {
  readonly path: string;
  readonly kind: 'archive' | 'active';
  readonly generation: number;
  readonly identity: string;
  readonly size: number;
}

interface Cursor {
  offset: number;
  readonly eventIds: Set<string>;
}

interface SeenEvent {
  readonly identities: Set<string>;
}

interface ReaderState {
  readonly cursors: Map<string, Cursor>;
  readonly seen: Map<string, SeenEvent>;
}

interface ScanResult {
  readonly events: OperationalEvent[];
  readonly skipped: number;
}

export interface OperationalLogSnapshot {
  readonly events: OperationalEvent[];
  readonly warnings: string[];
}

export type OperationalLogFollowItem =
  | { readonly kind: 'event'; readonly event: OperationalEvent }
  | { readonly kind: 'warning'; readonly message: string };

export class OperationalLogReadError extends Error {
  constructor() {
    super(OPERATIONAL_LOG_UNSAFE_ERROR);
    this.name = 'OperationalLogReadError';
  }
}

/** Read retained history without creating, chmodding, pruning, or rotating state. */
export async function readOperationalLogs(stateDirectory: string): Promise<OperationalLogSnapshot> {
  const state = createReaderState();
  const result = await scan(path.resolve(stateDirectory), state, false);
  return { events: result.events, warnings: warningsFor(result.skipped) };
}

/**
 * Emit the most recent retained tail and then each complete writer-produced
 * record once. Polling is deliberately the correctness path across rotation.
 */
export async function* followOperationalLogs(options: {
  readonly stateDirectory: string;
  readonly signal?: AbortSignal;
  readonly pollIntervalMs?: number;
}): AsyncGenerator<OperationalLogFollowItem> {
  const state = createReaderState();
  const directory = path.resolve(options.stateDirectory);
  const initial = await scan(directory, state, true, OPERATIONAL_FOLLOW_INITIAL_RECORDS);
  for (const warning of warningsFor(initial.skipped)) yield { kind: 'warning', message: warning };
  for (const event of initial.events) {
    yield { kind: 'event', event };
  }

  const interval = options.pollIntervalMs ?? OPERATIONAL_FOLLOW_POLL_MS;
  if (!Number.isSafeInteger(interval) || interval < 1) {
    throw new Error('Operational log follow interval must be a positive integer');
  }
  while (!options.signal?.aborted) {
    if (!(await waitForPoll(interval, options.signal))) break;
    const result = await scan(directory, state, true);
    for (const warning of warningsFor(result.skipped)) yield { kind: 'warning', message: warning };
    for (const event of result.events) yield { kind: 'event', event };
  }
}

export function formatOperationalEvent(event: OperationalEvent): string {
  const prefix = `${event.timestamp} ${event.severity.toUpperCase()} ${event.type} runtime=${event.runtimeId}`;
  switch (event.type) {
    case 'runtime.started':
      return `${prefix} mode=${event.mode}`;
    case 'runtime.stopped':
      return `${prefix} mode=${event.mode} outcome=${event.outcome}`;
    case 'reconciliation.completed':
      return `${prefix} claimed=${event.claimedJobs} launched=${event.launchedJobs} waiting=${event.waitingJobs} projected=${event.projected} blocked=${event.blockedProjections}`;
    case 'reconciliation.failed':
      return `${prefix} reason=${event.reason}`;
    case 'job.claimed':
      return `${prefix} job=${event.jobId} provider=${event.provider}`;
    case 'dispatch.waiting':
      return `${prefix} job=${event.jobId} reason=${event.reason}`;
    case 'workspace.acquired':
    case 'workspace.released':
      return `${prefix} job=${event.jobId} attempt=${event.attemptId}`;
    case 'workspace.quarantined':
      return `${prefix} job=${event.jobId} attempt=${event.attemptId} reason=${event.reason}`;
    case 'provider.launched':
      return `${prefix} job=${event.jobId} attempt=${event.attemptId} provider=${event.provider}`;
    case 'provider.terminal':
      return `${prefix} job=${event.jobId} attempt=${event.attemptId} provider=${event.provider} outcome=${event.outcome}`;
    case 'logging.records_dropped':
      return `${prefix} count=${event.count} reason=${event.reason}`;
  }
}

function createReaderState(): ReaderState {
  return { cursors: new Map(), seen: new Map() };
}

async function scan(
  stateDirectory: string,
  state: ReaderState,
  deferActivePartial: boolean,
  tailLimit?: number,
): Promise<ScanResult> {
  const segments = await inventory(stateDirectory);
  const currentIdentities = new Set(segments.map((segment) => segment.identity));
  forgetRemovedSegments(state, currentIdentities);
  const events: OperationalEvent[] = [];
  let skipped = 0;
  for (const segment of segments) {
    const cursor = state.cursors.get(segment.identity);
    if (segment.kind === 'archive' && cursor?.offset === segment.size) continue;
    const result = await readSegment(segment, state, deferActivePartial, tailLimit);
    events.push(...result.events);
    if (tailLimit !== undefined && events.length > tailLimit) {
      events.splice(0, events.length - tailLimit);
    }
    skipped += result.skipped;
  }
  return { events, skipped };
}

async function inventory(stateDirectory: string): Promise<Segment[]> {
  const directory = path.join(stateDirectory, OPERATIONAL_LOG_DIRECTORY);
  let directoryStats;
  try {
    directoryStats = await lstat(directory);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return [];
    throw new OperationalLogReadError();
  }
  if (
    !directoryStats.isDirectory() ||
    directoryStats.isSymbolicLink() ||
    (await safeRealpath(directory)) !== directory
  ) {
    throw new OperationalLogReadError();
  }
  assertOwnerPrivate(directoryStats, 0o700);

  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    throw new OperationalLogReadError();
  }
  const segments: Segment[] = [];
  for (const entry of entries) {
    const archive = ARCHIVE_PATTERN.exec(entry.name);
    const active = entry.name === OPERATIONAL_ACTIVE_FILE;
    if (!archive && !active) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) throw new OperationalLogReadError();
    const segmentPath = path.join(directory, entry.name);
    let stats;
    try {
      stats = await lstat(segmentPath);
    } catch (error) {
      if (hasCode(error, 'ENOENT')) continue;
      throw new OperationalLogReadError();
    }
    if (!isSafeSegment(stats) || stats.size > OPERATIONAL_SEGMENT_BYTES) {
      throw new OperationalLogReadError();
    }
    assertOwnerPrivate(stats, 0o600);
    segments.push({
      path: segmentPath,
      kind: active ? 'active' : 'archive',
      generation: active ? Number.MAX_SAFE_INTEGER : Number(archive?.[1]),
      identity: segmentIdentity(stats),
      size: stats.size,
    });
  }
  if (segments.length > OPERATIONAL_MAX_SEGMENTS) throw new OperationalLogReadError();
  return segments.sort((left, right) => left.generation - right.generation);
}

async function readSegment(
  segment: Segment,
  state: ReaderState,
  deferActivePartial: boolean,
  tailLimit?: number,
): Promise<ScanResult> {
  let handle: FileHandle;
  try {
    handle = await open(segment.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return { events: [], skipped: 0 };
    throw new OperationalLogReadError();
  }
  try {
    const descriptorStats = await handle.stat();
    let pathStats;
    try {
      pathStats = await lstat(segment.path);
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return { events: [], skipped: 0 };
      throw new OperationalLogReadError();
    }
    if (
      !isSafeSegment(descriptorStats) ||
      !isSafeSegment(pathStats) ||
      descriptorStats.size > OPERATIONAL_SEGMENT_BYTES
    ) {
      throw new OperationalLogReadError();
    }
    assertOwnerPrivate(descriptorStats, 0o600);
    assertOwnerPrivate(pathStats, 0o600);
    if (
      descriptorStats.dev !== pathStats.dev ||
      descriptorStats.ino !== pathStats.ino ||
      segmentIdentity(descriptorStats) !== segment.identity
    ) {
      // The writer may have renamed active and recreated it after inventory.
      // A later reinventory observes both safe identities in physical order.
      return { events: [], skipped: 0 };
    }
    return await readLines(
      handle,
      descriptorStats.size,
      segment,
      state,
      deferActivePartial,
      tailLimit,
    );
  } finally {
    await handle.close();
  }
}

async function readLines(
  handle: FileHandle,
  fileSize: number,
  segment: Segment,
  state: ReaderState,
  deferActivePartial: boolean,
  tailLimit?: number,
): Promise<ScanResult> {
  const cursor = state.cursors.get(segment.identity) ?? { offset: 0, eventIds: new Set<string>() };
  state.cursors.set(segment.identity, cursor);
  if (fileSize < cursor.offset) cursor.offset = 0;
  let readOffset = cursor.offset;
  let committedOffset = cursor.offset;
  let pending = Buffer.alloc(0);
  let oversized = false;
  let skipped = 0;
  const events: OperationalEvent[] = [];

  while (readOffset < fileSize) {
    const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, fileSize - readOffset));
    const result = await handle.read(chunk, 0, chunk.byteLength, readOffset);
    if (result.bytesRead === 0) break;
    const content = chunk.subarray(0, result.bytesRead);
    let start = 0;
    for (let index = 0; index < content.length; index += 1) {
      if (content[index] !== 0x0a) continue;
      const piece = content.subarray(start, index);
      if (!oversized) {
        if (pending.byteLength + piece.byteLength + 1 > MAX_OPERATIONAL_RECORD_BYTES) {
          oversized = true;
          pending = Buffer.alloc(0);
        } else {
          pending = Buffer.concat([pending, piece]);
        }
      }
      if (oversized) skipped += 1;
      else skipped += acceptLine(pending, segment.identity, cursor, state, events);
      trimToTail(events, tailLimit);
      committedOffset = readOffset + index + 1;
      pending = Buffer.alloc(0);
      oversized = false;
      start = index + 1;
    }
    const remainder = content.subarray(start);
    if (!oversized) {
      if (pending.byteLength + remainder.byteLength + 1 > MAX_OPERATIONAL_RECORD_BYTES) {
        oversized = true;
        pending = Buffer.alloc(0);
      } else {
        pending = Buffer.concat([pending, remainder]);
      }
    }
    readOffset += result.bytesRead;
  }

  if (pending.byteLength > 0 || oversized) {
    if (!(deferActivePartial && segment.kind === 'active')) {
      skipped += 1;
      committedOffset = readOffset;
    }
  }
  cursor.offset = committedOffset;
  return { events, skipped };
}

function acceptLine(
  encoded: Buffer,
  identity: string,
  cursor: Cursor,
  state: ReaderState,
  events: OperationalEvent[],
): number {
  let value: unknown;
  try {
    value = JSON.parse(encoded.toString('utf8')) as unknown;
  } catch {
    return 1;
  }
  const event = tryParseOperationalEvent(value);
  if (!event) return 1;
  const existing = state.seen.get(event.eventId);
  cursor.eventIds.add(event.eventId);
  if (existing) {
    existing.identities.add(identity);
    return 1;
  }
  state.seen.set(event.eventId, { identities: new Set([identity]) });
  events.push(event);
  return 0;
}

function trimToTail(events: OperationalEvent[], tailLimit: number | undefined): void {
  if (tailLimit !== undefined && events.length > tailLimit) {
    events.splice(0, events.length - tailLimit);
  }
}

function forgetRemovedSegments(state: ReaderState, currentIdentities: Set<string>): void {
  for (const [identity, cursor] of state.cursors) {
    if (currentIdentities.has(identity)) continue;
    state.cursors.delete(identity);
    for (const eventId of cursor.eventIds) {
      const seen = state.seen.get(eventId);
      seen?.identities.delete(identity);
      if (seen?.identities.size === 0) state.seen.delete(eventId);
    }
  }
}

function warningsFor(skipped: number): string[] {
  return skipped === 0
    ? []
    : [`Operational logs skipped ${String(skipped)} invalid or duplicate records (LOGS_INVALID).`];
}

function waitForPoll(milliseconds: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function safeRealpath(target: string): Promise<string | null> {
  try {
    return await realpath(target);
  } catch {
    return null;
  }
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
  const uid = process.getuid?.();
  if ((stats.mode & 0o777) !== expectedMode || (uid !== undefined && stats.uid !== uid)) {
    throw new OperationalLogReadError();
  }
}

function segmentIdentity(stats: {
  readonly dev: number;
  readonly ino: number;
  readonly birthtimeMs: number;
}): string {
  const created =
    Number.isFinite(stats.birthtimeMs) && stats.birthtimeMs > 0
      ? `:${String(stats.birthtimeMs)}`
      : '';
  return `${String(stats.dev)}:${String(stats.ino)}${created}`;
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}
