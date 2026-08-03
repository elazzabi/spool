import type { LedgerDatabase } from './database.js';
import { readProcessStartIdentity } from '../process-identity.js';

export { currentProcessStartIdentity, readProcessStartIdentity } from '../process-identity.js';

export interface DaemonOwnershipIdentity {
  nonce: string;
  pid: number;
  processStartIdentity: string;
}

export interface DaemonOwnership extends DaemonOwnershipIdentity {
  heartbeatAt: number;
  expiresAt: number;
}

interface DaemonOwnerRow {
  nonce: string;
  pid: number;
  process_start_identity: string;
  heartbeat_at: number;
  expires_at: number;
}

export interface DaemonLockEnvironment {
  now?: () => number;
  processIdentity?: (pid: number) => string | null;
}

export class DaemonLockConflictError extends Error {
  readonly owner: DaemonOwnership;

  constructor(owner: DaemonOwnership) {
    super(`Another spool daemon owns this state store (pid ${String(owner.pid)})`);
    this.name = 'DaemonLockConflictError';
    this.owner = owner;
  }
}

export class DaemonLock {
  readonly #database: LedgerDatabase;
  readonly #now: () => number;
  readonly #processIdentity: (pid: number) => string | null;

  constructor(database: LedgerDatabase, environment: DaemonLockEnvironment = {}) {
    this.#database = database;
    this.#now = environment.now ?? (() => Date.now());
    this.#processIdentity = environment.processIdentity ?? defaultProcessIdentity;
  }

  acquire(identity: DaemonOwnershipIdentity, durationMs: number): DaemonOwnership {
    if (durationMs <= 0) throw new Error('Daemon ownership duration must be positive');
    return this.#database.immediate(() => {
      const now = this.#now();
      const current = this.#current();
      const sameOwner = current && ownershipMatches(current, identity);
      const currentProcessStillMatches =
        current !== null &&
        this.#processIdentity(current.pid) === current.processStartIdentity &&
        current.expiresAt > now;
      if (currentProcessStillMatches && !sameOwner) throw new DaemonLockConflictError(current);

      const owner: DaemonOwnership = {
        ...identity,
        heartbeatAt: now,
        expiresAt: now + durationMs,
      };
      this.#database.raw
        .prepare(
          `INSERT INTO daemon_owner
             (singleton, nonce, pid, process_start_identity, heartbeat_at, expires_at)
           VALUES (1, ?, ?, ?, ?, ?)
           ON CONFLICT(singleton) DO UPDATE SET
             nonce = excluded.nonce,
             pid = excluded.pid,
             process_start_identity = excluded.process_start_identity,
             heartbeat_at = excluded.heartbeat_at,
             expires_at = excluded.expires_at`,
        )
        .run(
          owner.nonce,
          owner.pid,
          owner.processStartIdentity,
          owner.heartbeatAt,
          owner.expiresAt,
        );
      return owner;
    });
  }

  heartbeat(owner: DaemonOwnershipIdentity, durationMs: number): boolean {
    if (durationMs <= 0) throw new Error('Daemon ownership duration must be positive');
    return this.#database.immediate(() => {
      const now = this.#now();
      const result = this.#database.raw
        .prepare(
          `UPDATE daemon_owner SET heartbeat_at = ?, expires_at = ?
            WHERE singleton = 1 AND nonce = ? AND pid = ? AND process_start_identity = ?`,
        )
        .run(now, now + durationMs, owner.nonce, owner.pid, owner.processStartIdentity);
      return result.changes === 1;
    });
  }

  release(owner: DaemonOwnershipIdentity): boolean {
    return this.#database.immediate(() => {
      const result = this.#database.raw
        .prepare(
          `DELETE FROM daemon_owner
            WHERE singleton = 1 AND nonce = ? AND pid = ? AND process_start_identity = ?`,
        )
        .run(owner.nonce, owner.pid, owner.processStartIdentity);
      return result.changes === 1;
    });
  }

  current(): DaemonOwnership | null {
    return this.#current();
  }

  #current(): DaemonOwnership | null {
    const row = this.#database.raw
      .prepare('SELECT * FROM daemon_owner WHERE singleton = 1')
      .get() as DaemonOwnerRow | undefined;
    return row ? mapOwner(row) : null;
  }
}

function mapOwner(row: DaemonOwnerRow): DaemonOwnership {
  return {
    nonce: row.nonce,
    pid: row.pid,
    processStartIdentity: row.process_start_identity,
    heartbeatAt: row.heartbeat_at,
    expiresAt: row.expires_at,
  };
}

function ownershipMatches(left: DaemonOwnershipIdentity, right: DaemonOwnershipIdentity): boolean {
  return (
    left.nonce === right.nonce &&
    left.pid === right.pid &&
    left.processStartIdentity === right.processStartIdentity
  );
}

const defaultProcessIdentity = readProcessStartIdentity;
