import type Database from 'better-sqlite3';

export const CURRENT_SCHEMA_VERSION = 1;
export const MDSPOOL_APPLICATION_ID = 0x4d445350;

export class SchemaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaValidationError';
  }
}

const schemaV1 = `
CREATE TABLE jobs (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  source_marker TEXT NOT NULL UNIQUE,
  source_path TEXT NOT NULL,
  provider TEXT NOT NULL,
  directive TEXT NOT NULL,
  context TEXT NOT NULL,
  repository TEXT,
  state TEXT NOT NULL CHECK (state IN ('Queued','Working','NeedsInput','Completed','Failed','Cancelled')),
  cancellation_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancellation_requested IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_at TEXT
);

CREATE INDEX jobs_dispatch_fifo ON jobs(state, cancellation_requested, sequence);

CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('Prepared','Launching','Running','Uncertain','Terminal')),
  log_path TEXT NOT NULL,
  provider TEXT,
  session_id TEXT,
  observation_cursor TEXT,
  observation_hash TEXT,
  uncertainty_reason TEXT,
  process_id INTEGER,
  process_start_identity TEXT,
  latest_output TEXT,
  launch_metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_at TEXT,
  UNIQUE(job_id, attempt_number),
  CHECK ((provider IS NULL AND session_id IS NULL) OR (provider IS NOT NULL AND session_id IS NOT NULL)),
  CHECK ((process_id IS NULL AND process_start_identity IS NULL) OR (process_id IS NOT NULL AND process_start_identity IS NOT NULL))
);

CREATE UNIQUE INDEX attempts_one_active_per_job ON attempts(job_id) WHERE state <> 'Terminal';
CREATE UNIQUE INDEX attempts_provider_session ON attempts(provider, session_id) WHERE session_id IS NOT NULL;

CREATE TABLE provider_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE RESTRICT,
  event_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('session','state','output','terminal')),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(attempt_id, event_key)
);

CREATE INDEX provider_events_attempt_sequence ON provider_events(attempt_id, sequence);

CREATE TABLE intervention_events (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  event_key TEXT NOT NULL,
  prompt TEXT NOT NULL,
  created_at TEXT NOT NULL,
  closed_at TEXT,
  response TEXT,
  UNIQUE(job_id, event_key)
);

CREATE TABLE follow_up_actions (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  event_key TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(job_id, event_key)
);

CREATE TABLE workspace_leases (
  canonical_workspace TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN ('Held','ReleasePending','Released','Quarantined')),
  disposition TEXT,
  lease_metadata_json TEXT,
  held_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  released_at TEXT
);

CREATE INDEX workspace_leases_job ON workspace_leases(job_id);

CREATE TABLE projections (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  semantic_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('Pending','Applied','Blocked')),
  blocked_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE outbox (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  semantic_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  claim_owner TEXT,
  claim_expires_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  acknowledged_at TEXT
);

CREATE INDEX outbox_delivery ON outbox(acknowledged_at, claim_expires_at, sequence);

CREATE TABLE daemon_owner (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  nonce TEXT NOT NULL,
  pid INTEGER NOT NULL,
  process_start_identity TEXT NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
`;

const requiredV1Tables = [
  'jobs',
  'attempts',
  'provider_events',
  'intervention_events',
  'follow_up_actions',
  'workspace_leases',
  'projections',
  'outbox',
  'daemon_owner',
] as const;

export function initializeOrValidateSchema(database: Database.Database): void {
  const version = database.pragma('user_version', { simple: true }) as number;
  const tableCount = (
    database
      .prepare(
        `SELECT COUNT(*) AS count
           FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      )
      .get() as { count: number }
  ).count;

  if (version === 0 && tableCount === 0) {
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec(schemaV1);
      database.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
      database.pragma(`application_id = ${MDSPOOL_APPLICATION_ID}`);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  } else if (version !== CURRENT_SCHEMA_VERSION) {
    const description =
      version > CURRENT_SCHEMA_VERSION ? 'newer than this MDSpool build' : 'unknown or unversioned';
    throw new SchemaValidationError(
      `Ledger schema version ${String(version)} is ${description}; expected ${String(CURRENT_SCHEMA_VERSION)}`,
    );
  }

  const presentTables = new Set(
    (
      database
        .prepare(
          `SELECT name FROM sqlite_master
            WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
        )
        .all() as Array<{ name: string }>
    ).map(({ name }) => name),
  );
  const missingTables = requiredV1Tables.filter((table) => !presentTables.has(table));
  if (missingTables.length > 0) {
    throw new SchemaValidationError(
      `Ledger schema is missing required v1 tables: ${missingTables.join(', ')}`,
    );
  }

  const applicationId = database.pragma('application_id', { simple: true }) as number;
  if (applicationId !== MDSPOOL_APPLICATION_ID) {
    throw new SchemaValidationError(
      `Ledger application id ${String(applicationId)} does not identify an MDSpool database`,
    );
  }

  checkSingleResult(database, 'quick_check');
  checkSingleResult(database, 'integrity_check');
  const foreignKeyFailures = database.pragma('foreign_key_check') as unknown[];
  if (foreignKeyFailures.length > 0) {
    throw new SchemaValidationError('Ledger foreign key check failed; dispatch is disabled');
  }
}

function checkSingleResult(database: Database.Database, pragma: string): void {
  const rows = database.pragma(pragma) as Array<Record<string, unknown>>;
  const first = rows[0];
  if (rows.length !== 1 || !first || Object.values(first)[0] !== 'ok') {
    throw new SchemaValidationError(
      `Ledger ${pragma.replace('_', ' ')} failed; dispatch is disabled`,
    );
  }
}
