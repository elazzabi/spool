import { randomUUID } from 'node:crypto';

import type { LedgerDatabase } from './database.js';
import { canonicalJson } from './json.js';

export interface EnqueueOutboxInput {
  semanticKey: string;
  kind: string;
  payload: Record<string, unknown>;
}

export interface OutboxItem {
  id: string;
  sequence: number;
  semanticKey: string;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  claimOwner: string | null;
  claimExpiresAt: string | null;
  attempts: number;
  lastError: string | null;
  acknowledgedAt: string | null;
}

interface OutboxRow {
  id: string;
  sequence: number;
  semantic_key: string;
  kind: string;
  payload_json: string;
  created_at: string;
  updated_at: string;
  claim_owner: string | null;
  claim_expires_at: string | null;
  attempts: number;
  last_error: string | null;
  acknowledged_at: string | null;
}

export class OutboxRepository {
  readonly #database: LedgerDatabase;
  readonly #now: () => Date;

  constructor(database: LedgerDatabase, options: { now?: () => Date } = {}) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
  }

  enqueue(input: EnqueueOutboxInput): OutboxItem {
    return this.#database.immediate(() => {
      const timestamp = this.#now().toISOString();
      this.#database.raw
        .prepare(
          `INSERT INTO outbox
             (id, semantic_key, kind, payload_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(semantic_key) DO NOTHING`,
        )
        .run(
          randomUUID(),
          input.semanticKey,
          input.kind,
          canonicalJson(input.payload),
          timestamp,
          timestamp,
        );
      const persisted = this.#requiredBySemanticKey(input.semanticKey);
      if (
        persisted.kind !== input.kind ||
        canonicalJson(persisted.payload) !== canonicalJson(input.payload)
      ) {
        throw new Error(
          `Outbox semantic key ${input.semanticKey} already has a different kind or payload`,
        );
      }
      return persisted;
    });
  }

  get(id: string): OutboxItem | null {
    const row = this.#database.raw.prepare('SELECT * FROM outbox WHERE id = ?').get(id) as
      OutboxRow | undefined;
    return row ? mapOutbox(row) : null;
  }

  getBySemanticKey(semanticKey: string): OutboxItem | null {
    const row = this.#database.raw
      .prepare('SELECT * FROM outbox WHERE semantic_key = ?')
      .get(semanticKey) as OutboxRow | undefined;
    return row ? mapOutbox(row) : null;
  }

  claimNext(ownerToken: string, claimDurationMs: number, now = this.#now()): OutboxItem | null {
    if (claimDurationMs <= 0) throw new Error('Outbox claim duration must be positive');
    return this.#database.immediate(() => {
      const nowIso = now.toISOString();
      const candidate = this.#database.raw
        .prepare(
          `SELECT id FROM outbox
            WHERE acknowledged_at IS NULL
              AND (claim_owner IS NULL OR claim_expires_at <= ?)
            ORDER BY sequence ASC
            LIMIT 1`,
        )
        .get(nowIso) as { id: string } | undefined;
      if (!candidate) return null;
      const expiresAt = new Date(now.getTime() + claimDurationMs).toISOString();
      const result = this.#database.raw
        .prepare(
          `UPDATE outbox
              SET claim_owner = ?, claim_expires_at = ?, attempts = attempts + 1,
                  updated_at = ?, last_error = NULL
            WHERE id = ? AND acknowledged_at IS NULL
              AND (claim_owner IS NULL OR claim_expires_at <= ?)`,
        )
        .run(ownerToken, expiresAt, nowIso, candidate.id, nowIso);
      if (result.changes !== 1) return null;
      return this.#required(candidate.id);
    });
  }

  acknowledge(id: string, ownerToken: string, now = this.#now()): OutboxItem {
    return this.#database.immediate(() => {
      const item = this.#required(id);
      if (item.acknowledgedAt !== null) return item;
      assertCurrentClaim(item, ownerToken, now);
      const timestamp = now.toISOString();
      this.#database.raw
        .prepare(
          `UPDATE outbox
              SET acknowledged_at = ?, updated_at = ?, claim_owner = NULL, claim_expires_at = NULL
            WHERE id = ? AND claim_owner = ? AND acknowledged_at IS NULL`,
        )
        .run(timestamp, timestamp, id, ownerToken);
      return this.#required(id);
    });
  }

  release(id: string, ownerToken: string, error: string, now = this.#now()): OutboxItem {
    return this.#database.immediate(() => {
      const item = this.#required(id);
      if (item.acknowledgedAt !== null) return item;
      assertCurrentClaim(item, ownerToken, now);
      this.#database.raw
        .prepare(
          `UPDATE outbox
              SET claim_owner = NULL, claim_expires_at = NULL, last_error = ?, updated_at = ?
            WHERE id = ? AND claim_owner = ? AND acknowledged_at IS NULL`,
        )
        .run(error, now.toISOString(), id, ownerToken);
      return this.#required(id);
    });
  }

  #required(id: string): OutboxItem {
    const item = this.get(id);
    if (!item) throw new Error(`Unknown outbox item ${id}`);
    return item;
  }

  #requiredBySemanticKey(semanticKey: string): OutboxItem {
    const row = this.#database.raw
      .prepare('SELECT * FROM outbox WHERE semantic_key = ?')
      .get(semanticKey) as OutboxRow | undefined;
    if (!row) throw new Error(`Outbox intent ${semanticKey} was not persisted`);
    return mapOutbox(row);
  }
}

function mapOutbox(row: OutboxRow): OutboxItem {
  const parsed = JSON.parse(row.payload_json) as unknown;
  if (!isObject(parsed)) throw new Error(`Outbox payload for ${row.id} is not an object`);
  return {
    id: row.id,
    sequence: row.sequence,
    semanticKey: row.semantic_key,
    kind: row.kind,
    payload: parsed,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    claimOwner: row.claim_owner,
    claimExpiresAt: row.claim_expires_at,
    attempts: row.attempts,
    lastError: row.last_error,
    acknowledgedAt: row.acknowledged_at,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertCurrentClaim(item: OutboxItem, ownerToken: string, now: Date): void {
  if (item.claimOwner !== ownerToken) throw new Error(`Outbox owner mismatch for ${item.id}`);
  if (item.claimExpiresAt === null || item.claimExpiresAt <= now.toISOString()) {
    throw new Error(`Outbox claim expired for ${item.id}`);
  }
}
