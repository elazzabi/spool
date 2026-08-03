import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { initializeOrValidateSchema } from './schema.js';

export class LedgerOpenError extends Error {
  override readonly cause: unknown;

  constructor(databasePath: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Cannot safely open MDSpool ledger at ${databasePath}: ${detail}`);
    this.name = 'LedgerOpenError';
    this.cause = cause;
  }
}

export class LedgerDatabase {
  readonly raw: Database.Database;
  readonly stateDirectory: string;
  readonly databasePath: string;
  #closed = false;

  constructor(stateDirectory: string, database: Database.Database) {
    this.stateDirectory = stateDirectory;
    this.databasePath = path.join(stateDirectory, 'mdspool.sqlite');
    this.raw = database;
  }

  immediate<T>(operation: () => T): T {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.raw.exec('COMMIT');
      enforceStatePermissions(this.stateDirectory);
      return result;
    } catch (error) {
      if (this.raw.inTransaction) this.raw.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    if (this.#closed) return;
    enforceStatePermissions(this.stateDirectory);
    this.raw.close();
    this.#closed = true;
  }
}

export function openLedgerDatabase(stateDirectory: string): LedgerDatabase {
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  chmodSync(stateDirectory, 0o700);
  const databasePath = path.join(stateDirectory, 'mdspool.sqlite');
  for (const child of ['logs', 'tmp']) {
    const directory = path.join(stateDirectory, child);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }

  let database: Database.Database | undefined;
  try {
    database = new Database(databasePath);
    database.pragma('busy_timeout = 2500');
    database.pragma('foreign_keys = ON');
    initializeOrValidateSchema(database);
    database.pragma('journal_mode = WAL');
    database.pragma('synchronous = FULL');
    enforceStatePermissions(stateDirectory);
    return new LedgerDatabase(stateDirectory, database);
  } catch (error) {
    try {
      database?.close();
    } catch {
      // Preserve the validation/opening failure that made the ledger unsafe.
    }
    throw new LedgerOpenError(databasePath, error);
  }
}

function enforceStatePermissions(stateDirectory: string): void {
  chmodSync(stateDirectory, 0o700);
  for (const child of ['logs', 'tmp']) {
    const directory = path.join(stateDirectory, child);
    if (existsSync(directory)) chmodSync(directory, 0o700);
  }
  for (const suffix of ['', '-wal', '-shm']) {
    const file = path.join(stateDirectory, `mdspool.sqlite${suffix}`);
    if (existsSync(file)) chmodSync(file, 0o600);
  }
}
