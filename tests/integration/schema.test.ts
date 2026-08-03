import { closeSync, mkdtempSync, openSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { LedgerOpenError, openLedgerDatabase } from '../../src/ledger/database.js';
import { MDSPOOL_APPLICATION_ID, CURRENT_SCHEMA_VERSION } from '../../src/ledger/schema.js';

function stateDirectory(): string {
  return mkdtempSync(path.join(tmpdir(), 'mdspool-schema-'));
}

describe('ledger schema validation', () => {
  it('creates explicit schema v1 and reopens it', () => {
    const state = stateDirectory();
    const first = openLedgerDatabase(state);
    expect(first.raw.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    expect(first.raw.pragma('application_id', { simple: true })).toBe(MDSPOOL_APPLICATION_ID);
    first.close();
    expect(() => openLedgerDatabase(state).close()).not.toThrow();
  });

  it('rejects a versioned schema with another application identity', () => {
    const state = stateDirectory();
    const database = openLedgerDatabase(state);
    database.close();
    const raw = new Database(path.join(state, 'mdspool.sqlite'));
    raw.pragma('application_id = 0');
    raw.close();

    expect(() => openLedgerDatabase(state)).toThrow(/application id/i);
  });

  it('rejects newer and unversioned non-empty schemas', () => {
    for (const version of [0, CURRENT_SCHEMA_VERSION + 1]) {
      const state = stateDirectory();
      const raw = new Database(path.join(state, 'mdspool.sqlite'));
      raw.exec('CREATE TABLE unexpected (id INTEGER PRIMARY KEY)');
      raw.pragma(`user_version = ${version}`);
      raw.close();
      expect(() => openLedgerDatabase(state)).toThrow(LedgerOpenError);
    }
  });

  it('rejects a versioned database that does not contain the v1 schema', () => {
    const state = stateDirectory();
    const raw = new Database(path.join(state, 'mdspool.sqlite'));
    raw.exec('CREATE TABLE unexpected (id INTEGER PRIMARY KEY)');
    raw.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
    raw.close();

    expect(() => openLedgerDatabase(state)).toThrow(/schema.*missing/i);
  });

  it('fails closed for corrupt databases', () => {
    const state = stateDirectory();
    writeFileSync(path.join(state, 'mdspool.sqlite'), 'not a sqlite database');
    expect(() => openLedgerDatabase(state)).toThrow(LedgerOpenError);
  });

  it('fails closed when persisted foreign keys are invalid', () => {
    const state = stateDirectory();
    const database = openLedgerDatabase(state);
    database.close();
    const raw = new Database(path.join(state, 'mdspool.sqlite'));
    raw.pragma('foreign_keys = OFF');
    raw
      .prepare(
        `INSERT INTO attempts
         (id, job_id, attempt_number, state, log_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'orphan',
        'missing-job',
        1,
        'Prepared',
        '/tmp/orphan',
        new Date().toISOString(),
        new Date().toISOString(),
      );
    raw.close();

    expect(() => openLedgerDatabase(state)).toThrow(/foreign key/i);
  });

  it('fails closed when SQLite cannot read the database file', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const state = stateDirectory();
    const file = path.join(state, 'mdspool.sqlite');
    const descriptor = openSync(file, 'w', 0o000);
    closeSync(descriptor);
    expect(() => openLedgerDatabase(state)).toThrow(LedgerOpenError);
  });
});
