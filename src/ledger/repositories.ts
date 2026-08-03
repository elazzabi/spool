import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import type { FollowUpAction, InterventionEvent } from '../domain/events.js';
import type {
  Attempt,
  AttemptState,
  Job,
  JobState,
  LeaseState,
  Projection,
  ProjectionState,
  TerminalJobState,
  WorkspaceLease,
} from '../domain/job.js';
import { isTerminalJobState, terminalJobStates } from '../domain/job.js';
import type { ProcessIdentity, ProviderEvidence } from '../providers/types.js';
import {
  assertAttemptTransition,
  assertJobTransition,
  assertLeaseTransition,
  assertProjectionTransition,
} from '../domain/lifecycle.js';
import type { LedgerDatabase } from './database.js';
import { canonicalJson } from './json.js';
import {
  matchesWorkspaceAcknowledgmentIdentity,
  isWorkspaceAcknowledgmentEventKey,
  nextWorkspaceAcknowledgmentEventKey,
  parseWorkspaceCliAcknowledgmentDisposition,
  parseWorkspaceCliAcknowledgmentRequest,
  parseWorkspaceAcknowledgmentDisposition,
  serializeWorkspaceCliAcknowledgmentDisposition,
  serializeWorkspaceCliAcknowledgmentRequest,
  serializeWorkspaceAcknowledgmentDisposition,
  workspaceCliAcknowledgmentRefusal,
  workspaceCliAcknowledgmentRequest,
  workspaceCliAcknowledgmentRestored,
  workspaceAcknowledgmentDisposition,
  type ClaimWorkspaceAcknowledgmentInput,
  type RefuseWorkspaceAcknowledgmentInput,
  type WorkspaceAcknowledgmentClaimResult,
  type WorkspaceAcknowledgmentIdentity,
  type WorkspaceCliAcknowledgmentDisposition,
} from '../workspaces/acknowledgment.js';

export interface ClaimJobInput {
  sourceMarker: string;
  sourcePath: string;
  provider: string;
  directive: string;
  context: string;
  repository?: string | null;
}

export interface WatchRemovalReference {
  sourcePath: string;
  kind: 'job' | 'projection';
}

interface JobRow {
  id: string;
  sequence: number;
  source_marker: string;
  source_path: string;
  provider: string;
  directive: string;
  context: string;
  repository: string | null;
  state: JobState;
  cancellation_requested: number;
  created_at: string;
  updated_at: string;
  terminal_at: string | null;
}

interface AttemptRow {
  id: string;
  job_id: string;
  attempt_number: number;
  state: AttemptState;
  log_path: string;
  provider: string | null;
  session_id: string | null;
  observation_cursor: string | null;
  observation_hash: string | null;
  uncertainty_reason: string | null;
  process_id: number | null;
  process_start_identity: string | null;
  latest_output: string | null;
  launch_metadata_json: string | null;
  created_at: string;
  updated_at: string;
  terminal_at: string | null;
}

interface InterventionRow {
  id: string;
  job_id: string;
  event_key: string;
  prompt: string;
  created_at: string;
  closed_at: string | null;
  response: string | null;
}

interface FollowUpRow {
  id: string;
  job_id: string;
  event_key: string;
  text: string;
  created_at: string;
  completed_at: string | null;
}

interface LeaseRow {
  canonical_workspace: string;
  job_id: string;
  attempt_id: string;
  state: LeaseState;
  disposition: string | null;
  lease_metadata_json: string | null;
  held_at: string;
  updated_at: string;
  released_at: string | null;
}

interface ProjectionRow {
  id: string;
  job_id: string;
  semantic_key: string;
  state: ProjectionState;
  blocked_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface ProviderEventRow {
  sequence: number;
  attempt_id: string;
  event_key: string;
  kind: ProviderEvidence['kind'];
  payload_json: string;
  created_at: string;
}

export class LedgerRepository {
  readonly #database: LedgerDatabase;
  readonly #now: () => Date;

  constructor(database: LedgerDatabase, options: { now?: () => Date } = {}) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
  }

  claimJob(input: ClaimJobInput): Job {
    return this.#database.immediate(() => {
      const timestamp = this.#timestamp();
      this.#database.raw
        .prepare(
          `INSERT INTO jobs
             (id, source_marker, source_path, provider, directive, context, repository, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'Queued', ?, ?)
           ON CONFLICT(source_marker) DO NOTHING`,
        )
        .run(
          randomUUID(),
          input.sourceMarker,
          input.sourcePath,
          input.provider,
          input.directive,
          input.context,
          input.repository ?? null,
          timestamp,
          timestamp,
        );
      return this.#requiredJobByMarker(input.sourceMarker);
    });
  }

  refreshQueuedJobContext(
    jobId: string,
    input: Pick<ClaimJobInput, 'directive' | 'context' | 'repository'>,
  ): Job {
    return this.#database.immediate(() => {
      const job = this.#requiredJob(jobId);
      const repository = input.repository ?? null;
      if (job.state !== 'Queued') return job;
      const activeAttempt = this.#database.raw
        .prepare("SELECT 1 FROM attempts WHERE job_id = ? AND state <> 'Terminal' LIMIT 1")
        .get(jobId);
      if (activeAttempt) return job;
      if (
        job.directive === input.directive &&
        job.context === input.context &&
        job.repository === repository
      ) {
        return job;
      }

      this.#database.raw
        .prepare(
          `UPDATE jobs
              SET directive = ?, context = ?, repository = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(input.directive, input.context, repository, this.#timestamp(), jobId);
      return this.#requiredJob(jobId);
    });
  }

  getJob(jobId: string): Job | null {
    const row = this.#database.raw.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as
      JobRow | undefined;
    return row ? mapJob(row) : null;
  }

  getJobByMarker(sourceMarker: string): Job | null {
    const row = this.#database.raw
      .prepare('SELECT * FROM jobs WHERE source_marker = ?')
      .get(sourceMarker) as JobRow | undefined;
    return row ? mapJob(row) : null;
  }

  listJobs(): Job[] {
    const rows = this.#database.raw
      .prepare('SELECT * FROM jobs ORDER BY sequence')
      .all() as JobRow[];
    return rows.map(mapJob);
  }

  listDispatchableJobs(): Job[] {
    const rows = this.#database.raw
      .prepare(
        `SELECT jobs.*
           FROM jobs
          WHERE jobs.state = 'Queued'
            AND jobs.cancellation_requested = 0
            AND NOT EXISTS (
              SELECT 1 FROM attempts
               WHERE attempts.job_id = jobs.id AND attempts.state <> 'Terminal'
            )
          ORDER BY jobs.sequence ASC`,
      )
      .all() as JobRow[];
    return rows.map(mapJob);
  }

  *watchRemovalReferences(): IterableIterator<WatchRemovalReference> {
    const rows = this.#database.raw
      .prepare(
        `SELECT jobs.source_path AS source_path, 'job' AS reference_kind
           FROM jobs
          WHERE jobs.state NOT IN (?, ?, ?)
          UNION ALL
         SELECT jobs.source_path AS source_path, 'projection' AS reference_kind
           FROM projections
           JOIN jobs ON jobs.id = projections.job_id
          WHERE projections.state <> 'Applied'`,
      )
      .iterate(...terminalJobStates) as IterableIterator<{
      source_path: string;
      reference_kind: 'job' | 'projection';
    }>;
    for (const row of rows) yield { sourcePath: row.source_path, kind: row.reference_kind };
  }

  transitionJob(jobId: string, nextState: JobState): Job {
    return this.#database.immediate(() => {
      const current = this.#requiredJob(jobId);
      assertJobTransition(current.state, nextState);
      if (nextState === 'Cancelled' && current.state !== nextState) {
        const activeAttempt = this.#database.raw
          .prepare("SELECT 1 FROM attempts WHERE job_id = ? AND state <> 'Terminal' LIMIT 1")
          .get(jobId);
        if (activeAttempt) {
          throw new Error(
            `Job ${jobId} has an active attempt; cancellation requires provider terminal evidence`,
          );
        }
      }
      if (current.state !== nextState) {
        const timestamp = this.#timestamp();
        const terminalAt = isTerminalJobState(nextState) ? timestamp : null;
        this.#database.raw
          .prepare('UPDATE jobs SET state = ?, updated_at = ?, terminal_at = ? WHERE id = ?')
          .run(nextState, timestamp, terminalAt, jobId);
      }
      return this.#requiredJob(jobId);
    });
  }

  requestCancellation(jobId: string): Job {
    return this.#database.immediate(() => {
      const job = this.#requiredJob(jobId);
      if (isTerminalJobState(job.state)) return job;
      const active = this.#database.raw
        .prepare("SELECT 1 FROM attempts WHERE job_id = ? AND state <> 'Terminal' LIMIT 1")
        .get(jobId);
      const timestamp = this.#timestamp();
      if (!active && job.state === 'Queued') {
        this.#database.raw
          .prepare(
            `UPDATE jobs
                SET state = 'Cancelled', cancellation_requested = 1,
                    updated_at = ?, terminal_at = ?
              WHERE id = ?`,
          )
          .run(timestamp, timestamp, jobId);
      } else {
        this.#database.raw
          .prepare('UPDATE jobs SET cancellation_requested = 1, updated_at = ? WHERE id = ?')
          .run(timestamp, jobId);
      }
      return this.#requiredJob(jobId);
    });
  }

  confirmCancellation(jobId: string, attemptId: string): Job {
    return this.#database.immediate(() => {
      const attempt = this.#requiredAttempt(attemptId);
      if (attempt.jobId !== jobId) throw new Error('Attempt does not belong to the cancelled job');
      if (attempt.state !== 'Terminal') this.#updateAttemptState(attempt, 'Terminal');
      const job = this.#requiredJob(jobId);
      if (!job.cancellationRequested)
        throw new Error('Cancellation was not requested for this job');
      assertJobTransition(job.state, 'Cancelled');
      const timestamp = this.#timestamp();
      this.#database.raw
        .prepare(
          "UPDATE jobs SET state = 'Cancelled', updated_at = ?, terminal_at = ? WHERE id = ?",
        )
        .run(timestamp, timestamp, jobId);
      return this.#requiredJob(jobId);
    });
  }

  prepareAttempt(jobId: string, logPath: string): Attempt {
    return this.#database.immediate(() => {
      const job = this.#requiredJob(jobId);
      if (isTerminalJobState(job.state)) throw new Error(`Cannot attempt terminal job ${jobId}`);
      const active = this.#database.raw
        .prepare("SELECT id FROM attempts WHERE job_id = ? AND state <> 'Terminal' LIMIT 1")
        .get(jobId);
      if (active) throw new Error(`Job ${jobId} already has an active attempt`);
      const result = this.#database.raw
        .prepare(
          'SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next FROM attempts WHERE job_id = ?',
        )
        .get(jobId) as { next: number };
      const timestamp = this.#timestamp();
      const id = randomUUID();
      this.#database.raw
        .prepare(
          `INSERT INTO attempts
             (id, job_id, attempt_number, state, log_path, created_at, updated_at)
           VALUES (?, ?, ?, 'Prepared', ?, ?, ?)`,
        )
        .run(id, jobId, result.next, logPath, timestamp, timestamp);
      return this.#requiredAttempt(id);
    });
  }

  getAttempt(attemptId: string): Attempt | null {
    const row = this.#database.raw.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId) as
      AttemptRow | undefined;
    return row ? mapAttempt(row) : null;
  }

  listAttempts(jobId: string): Attempt[] {
    const rows = this.#database.raw
      .prepare('SELECT * FROM attempts WHERE job_id = ? ORDER BY attempt_number')
      .all(jobId) as AttemptRow[];
    return rows.map(mapAttempt);
  }

  listRecoverableAttempts(): Attempt[] {
    const rows = this.#database.raw
      .prepare(
        `SELECT attempts.*
           FROM attempts
           JOIN jobs ON jobs.id = attempts.job_id
          WHERE attempts.state <> 'Terminal'
          ORDER BY jobs.sequence, attempts.attempt_number`,
      )
      .all() as AttemptRow[];
    return rows.map(mapAttempt);
  }

  listAllAttempts(): Attempt[] {
    const rows = this.#database.raw
      .prepare(
        `SELECT attempts.* FROM attempts
          JOIN jobs ON jobs.id = attempts.job_id
         ORDER BY jobs.sequence, attempts.attempt_number`,
      )
      .all() as AttemptRow[];
    return rows.map(mapAttempt);
  }

  transitionAttempt(attemptId: string, nextState: AttemptState): Attempt {
    return this.#database.immediate(() => {
      const attempt = this.#requiredAttempt(attemptId);
      this.#updateAttemptState(attempt, nextState);
      return this.#requiredAttempt(attemptId);
    });
  }

  finalizeAttemptAndJob(attemptId: string, nextJobState: TerminalJobState): Job {
    return this.#database.immediate(() => {
      const attempt = this.#requiredAttempt(attemptId);
      const currentJob = this.#requiredJob(attempt.jobId);
      if (attempt.state !== 'Terminal') this.#updateAttemptState(attempt, 'Terminal');
      if (currentJob.state === nextJobState) return this.#requiredJob(currentJob.id);
      if (isTerminalJobState(currentJob.state)) {
        throw new Error(
          `Job ${currentJob.id} is already terminal as ${currentJob.state}, not ${nextJobState}`,
        );
      }

      let fromState = currentJob.state;
      const timestamp = this.#timestamp();
      if (fromState === 'Queued' && nextJobState !== 'Cancelled') {
        assertJobTransition(fromState, 'Working');
        this.#database.raw
          .prepare("UPDATE jobs SET state = 'Working', updated_at = ? WHERE id = ?")
          .run(timestamp, currentJob.id);
        fromState = 'Working';
      }
      assertJobTransition(fromState, nextJobState);
      this.#database.raw
        .prepare('UPDATE jobs SET state = ?, updated_at = ?, terminal_at = ? WHERE id = ?')
        .run(nextJobState, timestamp, timestamp, currentJob.id);
      return this.#requiredJob(currentJob.id);
    });
  }

  markAttemptUncertain(attemptId: string, reason: string): Attempt {
    return this.#database.immediate(() => {
      const attempt = this.#requiredAttempt(attemptId);
      assertAttemptTransition(attempt.state, 'Uncertain');
      const timestamp = this.#timestamp();
      this.#database.raw
        .prepare(
          "UPDATE attempts SET state = 'Uncertain', uncertainty_reason = ?, updated_at = ? WHERE id = ?",
        )
        .run(reason, timestamp, attemptId);
      return this.#requiredAttempt(attemptId);
    });
  }

  recordAttemptSession(attemptId: string, provider: string, sessionId: string): Attempt {
    return this.#database.immediate(() => {
      const attempt = this.#requiredAttempt(attemptId);
      if (attempt.provider !== null || attempt.sessionId !== null) {
        if (attempt.provider !== provider || attempt.sessionId !== sessionId) {
          throw new Error(`Attempt ${attemptId} already has a different provider session`);
        }
        return attempt;
      }
      this.#database.raw
        .prepare('UPDATE attempts SET provider = ?, session_id = ?, updated_at = ? WHERE id = ?')
        .run(provider, sessionId, this.#timestamp(), attemptId);
      return this.#requiredAttempt(attemptId);
    });
  }

  recordAttemptProcess(attemptId: string, identity: ProcessIdentity): Attempt {
    return this.#database.immediate(() => {
      const attempt = this.#requiredAttempt(attemptId);
      if (attempt.processId !== null || attempt.processStartIdentity !== null) {
        if (
          attempt.processId !== identity.pid ||
          attempt.processStartIdentity !== identity.processStartIdentity
        ) {
          throw new Error(`Attempt ${attemptId} already has a different process identity`);
        }
        return attempt;
      }
      this.#database.raw
        .prepare(
          'UPDATE attempts SET process_id = ?, process_start_identity = ?, updated_at = ? WHERE id = ?',
        )
        .run(identity.pid, identity.processStartIdentity, this.#timestamp(), attemptId);
      return this.#requiredAttempt(attemptId);
    });
  }

  recordAttemptLaunchMetadata(attemptId: string, metadata: Record<string, unknown>): Attempt {
    return this.#database.immediate(() => {
      const attempt = this.#requiredAttempt(attemptId);
      const encoded = canonicalJson(metadata);
      if (attempt.launchMetadata !== null) {
        if (canonicalJson(attempt.launchMetadata) !== encoded) {
          throw new Error(`Attempt ${attemptId} already has different launch metadata`);
        }
        return attempt;
      }
      this.#database.raw
        .prepare('UPDATE attempts SET launch_metadata_json = ?, updated_at = ? WHERE id = ?')
        .run(encoded, this.#timestamp(), attemptId);
      return this.#requiredAttempt(attemptId);
    });
  }

  recordProviderEvidence(attemptId: string, evidence: ProviderEvidence): boolean {
    return this.#database.immediate(() => {
      this.#requiredAttempt(attemptId);
      const encoded = canonicalJson(evidence);
      const existing = this.#database.raw
        .prepare('SELECT payload_json FROM provider_events WHERE attempt_id = ? AND event_key = ?')
        .get(attemptId, evidence.eventKey) as { payload_json: string } | undefined;
      if (existing) {
        if (existing.payload_json !== encoded) {
          throw new Error(
            `Provider event ${evidence.eventKey} for attempt ${attemptId} has conflicting evidence`,
          );
        }
        return false;
      }
      this.#database.raw
        .prepare(
          `INSERT INTO provider_events
             (attempt_id, event_key, kind, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(attemptId, evidence.eventKey, evidence.kind, encoded, this.#timestamp());
      const output = evidence.kind === 'output' ? evidence.text.slice(0, 16_000) : null;
      const outputHash =
        evidence.kind === 'output'
          ? createHash('sha256').update(evidence.text, 'utf8').digest('hex')
          : null;
      this.#database.raw
        .prepare(
          `UPDATE attempts
              SET observation_cursor = ?,
                  observation_hash = COALESCE(?, observation_hash),
                  latest_output = COALESCE(?, latest_output),
                  updated_at = ?
            WHERE id = ?`,
        )
        .run(evidence.eventKey, outputHash, output, this.#timestamp(), attemptId);
      return true;
    });
  }

  listProviderEvidence(attemptId: string): ProviderEvidence[] {
    this.#requiredAttempt(attemptId);
    const rows = this.#database.raw
      .prepare('SELECT * FROM provider_events WHERE attempt_id = ? ORDER BY sequence')
      .all(attemptId) as ProviderEventRow[];
    return rows.map((row) => parseProviderEvidence(row.payload_json, row));
  }

  updateAttemptObservation(
    attemptId: string,
    observationCursor: string | null,
    observationHash: string | null,
  ): Attempt {
    return this.#database.immediate(() => {
      this.#requiredAttempt(attemptId);
      this.#database.raw
        .prepare(
          'UPDATE attempts SET observation_cursor = ?, observation_hash = ?, updated_at = ? WHERE id = ?',
        )
        .run(observationCursor, observationHash, this.#timestamp(), attemptId);
      return this.#requiredAttempt(attemptId);
    });
  }

  recordIntervention(jobId: string, eventKey: string, prompt: string): InterventionEvent {
    return this.#database.immediate(() => {
      this.#requiredJob(jobId);
      this.#database.raw
        .prepare(
          `INSERT INTO intervention_events (id, job_id, event_key, prompt, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(job_id, event_key) DO NOTHING`,
        )
        .run(randomUUID(), jobId, eventKey, prompt, this.#timestamp());
      return this.#requiredIntervention(jobId, eventKey);
    });
  }

  closeIntervention(jobId: string, eventKey: string, response: string): InterventionEvent {
    return this.#database.immediate(() => {
      const intervention = this.#requiredIntervention(jobId, eventKey);
      if (intervention.closedAt === null) {
        this.#database.raw
          .prepare(
            `UPDATE intervention_events SET closed_at = ?, response = ?
              WHERE job_id = ? AND event_key = ? AND closed_at IS NULL`,
          )
          .run(this.#timestamp(), response, jobId, eventKey);
      }
      return this.#requiredIntervention(jobId, eventKey);
    });
  }

  listInterventions(jobId: string): InterventionEvent[] {
    const rows = this.#database.raw
      .prepare('SELECT * FROM intervention_events WHERE job_id = ? ORDER BY created_at, rowid')
      .all(jobId) as InterventionRow[];
    return rows.map(mapIntervention);
  }

  recordFollowUp(jobId: string, eventKey: string, text: string): FollowUpAction {
    return this.#database.immediate(() => {
      this.#requiredJob(jobId);
      this.#database.raw
        .prepare(
          `INSERT INTO follow_up_actions (id, job_id, event_key, text, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(job_id, event_key) DO NOTHING`,
        )
        .run(randomUUID(), jobId, eventKey, text, this.#timestamp());
      return this.#requiredFollowUp(jobId, eventKey);
    });
  }

  completeFollowUp(jobId: string, eventKey: string): FollowUpAction {
    return this.#database.immediate(() => {
      this.#requiredFollowUp(jobId, eventKey);
      this.#database.raw
        .prepare(
          `UPDATE follow_up_actions SET completed_at = COALESCE(completed_at, ?)
            WHERE job_id = ? AND event_key = ?`,
        )
        .run(this.#timestamp(), jobId, eventKey);
      return this.#requiredFollowUp(jobId, eventKey);
    });
  }

  listFollowUps(jobId: string): FollowUpAction[] {
    const rows = this.#database.raw
      .prepare('SELECT * FROM follow_up_actions WHERE job_id = ? ORDER BY created_at, rowid')
      .all(jobId) as FollowUpRow[];
    return rows.map(mapFollowUp);
  }

  claimWorkspaceAcknowledgment(
    input: ClaimWorkspaceAcknowledgmentInput,
  ): WorkspaceAcknowledgmentClaimResult {
    return this.#database.immediate(() => {
      const workspace = path.resolve(input.canonicalWorkspace);
      const action = this.#followUp(input.jobId, input.eventKey);
      if (!action || action.completedAt !== null) {
        return { kind: 'refused', reason: 'Workspace acknowledgment action is not open' };
      }
      if (
        !isWorkspaceAcknowledgmentEventKey(input.attemptId, input.eventKey) ||
        input.successorEventKey !==
          nextWorkspaceAcknowledgmentEventKey(input.attemptId, input.eventKey)
      ) {
        return { kind: 'refused', reason: 'Workspace acknowledgment generation is invalid' };
      }
      const lease = this.#lease(workspace);
      if (
        !lease ||
        lease.state !== 'Quarantined' ||
        lease.jobId !== input.jobId ||
        lease.attemptId !== input.attemptId
      ) {
        return {
          kind: 'refused',
          reason: 'Workspace acknowledgment does not match the exact quarantined lease',
        };
      }
      if (this.#followUp(input.jobId, input.successorEventKey)) {
        return { kind: 'refused', reason: 'Workspace acknowledgment successor already exists' };
      }

      const timestamp = this.#timestamp();
      const identity = { ...input, canonicalWorkspace: workspace };
      const disposition = workspaceAcknowledgmentDisposition(identity, 'awaiting-inspection');
      this.#database.raw
        .prepare(
          `UPDATE follow_up_actions SET completed_at = ?
            WHERE job_id = ? AND event_key = ? AND completed_at IS NULL`,
        )
        .run(timestamp, input.jobId, input.eventKey);
      this.#database.raw
        .prepare(
          `INSERT INTO follow_up_actions
             (id, job_id, event_key, text, created_at, completed_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          input.jobId,
          input.successorEventKey,
          input.successorText,
          timestamp,
          timestamp,
        );
      assertLeaseTransition(lease.state, 'ReleasePending');
      this.#database.raw
        .prepare(
          `UPDATE workspace_leases
              SET state = 'ReleasePending', disposition = ?, updated_at = ?, released_at = NULL
            WHERE canonical_workspace = ?`,
        )
        .run(serializeWorkspaceAcknowledgmentDisposition(disposition), timestamp, workspace);
      return {
        kind: 'claimed',
        action: this.#requiredFollowUp(input.jobId, input.eventKey),
        successor: this.#requiredFollowUp(input.jobId, input.successorEventKey),
        lease: this.#requiredLease(workspace),
        disposition,
      };
    });
  }

  markWorkspaceAcknowledgmentInspected(identity: WorkspaceAcknowledgmentIdentity): WorkspaceLease {
    return this.#database.immediate(() => {
      const { workspace } = this.#requiredPendingWorkspaceAcknowledgment(
        identity,
        'awaiting-inspection',
      );
      const inspected = workspaceAcknowledgmentDisposition(identity, 'inspected-safe');
      this.#database.raw
        .prepare(
          'UPDATE workspace_leases SET disposition = ?, updated_at = ? WHERE canonical_workspace = ?',
        )
        .run(serializeWorkspaceAcknowledgmentDisposition(inspected), this.#timestamp(), workspace);
      return this.#requiredLease(workspace);
    });
  }

  markWorkspaceAcknowledgmentRestored(identity: WorkspaceAcknowledgmentIdentity): WorkspaceLease {
    return this.#database.immediate(() => {
      const { workspace } = this.#requiredPendingWorkspaceAcknowledgment(
        identity,
        'inspected-safe',
      );
      const restored = workspaceAcknowledgmentDisposition(identity, 'restored-safe');
      this.#database.raw
        .prepare(
          'UPDATE workspace_leases SET disposition = ?, updated_at = ? WHERE canonical_workspace = ?',
        )
        .run(serializeWorkspaceAcknowledgmentDisposition(restored), this.#timestamp(), workspace);
      return this.#requiredLease(workspace);
    });
  }

  markWorkspaceCliAcknowledgmentRestored(
    identity: WorkspaceCliAcknowledgmentDisposition,
  ): WorkspaceLease {
    return this.#database.immediate(() => {
      const workspace = path.resolve(identity.canonicalWorkspace);
      const lease = this.#requiredLease(workspace);
      const current = parseWorkspaceCliAcknowledgmentDisposition(lease.disposition);
      if (
        lease.state !== 'ReleasePending' ||
        !current ||
        current.phase !== 'inspected-safe' ||
        current.jobId !== identity.jobId ||
        current.attemptId !== identity.attemptId ||
        current.canonicalWorkspace !== workspace
      ) {
        throw new Error('Workspace lease is not the exact pending CLI acknowledgment operation');
      }
      const restored = workspaceCliAcknowledgmentRestored(current);
      this.#database.raw
        .prepare(
          'UPDATE workspace_leases SET disposition = ?, updated_at = ? WHERE canonical_workspace = ?',
        )
        .run(
          serializeWorkspaceCliAcknowledgmentDisposition(restored),
          this.#timestamp(),
          workspace,
        );
      return this.#requiredLease(workspace);
    });
  }

  refuseWorkspaceAcknowledgment(input: RefuseWorkspaceAcknowledgmentInput): WorkspaceLease {
    return this.#database.immediate(() => {
      const { workspace, lease } = this.#requiredPendingWorkspaceAcknowledgment(input);
      const successor = this.#requiredFollowUp(input.jobId, input.successorEventKey);
      if (successor.completedAt === null) {
        throw new Error('Workspace acknowledgment successor is already open');
      }
      const timestamp = this.#timestamp();
      const refused = workspaceAcknowledgmentDisposition(input, 'refused', input.reason);
      this.#database.raw
        .prepare(
          `UPDATE follow_up_actions SET text = ?, completed_at = NULL
            WHERE job_id = ? AND event_key = ? AND completed_at IS NOT NULL`,
        )
        .run(input.successorText, input.jobId, input.successorEventKey);
      assertLeaseTransition(lease.state, 'Quarantined');
      this.#database.raw
        .prepare(
          `UPDATE workspace_leases
              SET state = 'Quarantined', disposition = ?, updated_at = ?, released_at = NULL
            WHERE canonical_workspace = ?`,
        )
        .run(serializeWorkspaceAcknowledgmentDisposition(refused), timestamp, workspace);
      return this.#requiredLease(workspace);
    });
  }

  completeWorkspaceAcknowledgment(identity: WorkspaceAcknowledgmentIdentity): WorkspaceLease {
    return this.#database.immediate(() => {
      const { workspace, lease } = this.#requiredPendingWorkspaceAcknowledgment(
        identity,
        'restored-safe',
      );
      assertLeaseTransition(lease.state, 'Released');
      const timestamp = this.#timestamp();
      this.#database.raw
        .prepare(
          `UPDATE workspace_leases
              SET state = 'Released', disposition = ?, updated_at = ?, released_at = ?
            WHERE canonical_workspace = ?`,
        )
        .run(lease.disposition, timestamp, timestamp, workspace);
      return this.#requiredLease(workspace);
    });
  }

  holdLease(
    canonicalWorkspace: string,
    jobId: string,
    attemptId: string,
    metadata: Record<string, unknown> | null = null,
  ): WorkspaceLease {
    return this.#database.immediate(() => {
      this.#requiredJob(jobId);
      const attempt = this.#requiredAttempt(attemptId);
      if (attempt.jobId !== jobId) throw new Error('Lease attempt does not belong to its job');
      const workspace = path.resolve(canonicalWorkspace);
      const existing = this.#lease(workspace);
      if (existing && existing.state !== 'Released') {
        if (existing.jobId === jobId && existing.attemptId === attemptId) return existing;
        throw new Error(`Workspace ${workspace} already has an active or quarantined lease`);
      }
      const timestamp = this.#timestamp();
      this.#database.raw
        .prepare(
          `INSERT INTO workspace_leases
             (canonical_workspace, job_id, attempt_id, state, lease_metadata_json, held_at, updated_at)
           VALUES (?, ?, ?, 'Held', ?, ?, ?)
           ON CONFLICT(canonical_workspace) DO UPDATE SET
             job_id = excluded.job_id,
             attempt_id = excluded.attempt_id,
             state = 'Held',
             disposition = NULL,
             lease_metadata_json = excluded.lease_metadata_json,
             held_at = excluded.held_at,
             updated_at = excluded.updated_at,
             released_at = NULL
           WHERE workspace_leases.state = 'Released'`,
        )
        .run(
          workspace,
          jobId,
          attemptId,
          metadata ? canonicalJson(metadata) : null,
          timestamp,
          timestamp,
        );
      return this.#requiredLease(workspace);
    });
  }

  getLease(canonicalWorkspace: string): WorkspaceLease | null {
    return this.#lease(path.resolve(canonicalWorkspace));
  }

  listLeases(): WorkspaceLease[] {
    const rows = this.#database.raw
      .prepare('SELECT * FROM workspace_leases ORDER BY held_at, canonical_workspace')
      .all() as LeaseRow[];
    return rows.map(mapLease);
  }

  requestWorkspaceCliAcknowledgment(canonicalWorkspace: string): WorkspaceLease {
    return this.#database.immediate(() => {
      const workspace = path.resolve(canonicalWorkspace);
      const lease = this.#requiredLease(workspace);
      if (lease.state !== 'Quarantined') {
        throw new Error('Workspace does not have a quarantined lease');
      }
      const existing = parseWorkspaceCliAcknowledgmentRequest(lease.disposition);
      if (existing?.phase === 'requested') return lease;
      const request = workspaceCliAcknowledgmentRequest({
        jobId: lease.jobId,
        attemptId: lease.attemptId,
        canonicalWorkspace: workspace,
        previousDisposition: existing?.previousDisposition ?? lease.disposition,
      });
      this.#database.raw
        .prepare(
          'UPDATE workspace_leases SET disposition = ?, updated_at = ? WHERE canonical_workspace = ?',
        )
        .run(serializeWorkspaceCliAcknowledgmentRequest(request), this.#timestamp(), workspace);
      return this.#requiredLease(workspace);
    });
  }

  refuseWorkspaceCliAcknowledgment(canonicalWorkspace: string, reason: string): WorkspaceLease {
    return this.#database.immediate(() => {
      const workspace = path.resolve(canonicalWorkspace);
      const lease = this.#requiredLease(workspace);
      const request = parseWorkspaceCliAcknowledgmentRequest(lease.disposition);
      if (lease.state !== 'Quarantined' || !request || request.phase !== 'requested') {
        return lease;
      }
      const refused = workspaceCliAcknowledgmentRefusal(request, reason);
      this.#database.raw
        .prepare(
          'UPDATE workspace_leases SET disposition = ?, updated_at = ? WHERE canonical_workspace = ?',
        )
        .run(serializeWorkspaceCliAcknowledgmentRequest(refused), this.#timestamp(), workspace);
      return this.#requiredLease(workspace);
    });
  }

  refusePendingWorkspaceCliAcknowledgment(
    disposition: WorkspaceCliAcknowledgmentDisposition,
    reason: string,
  ): WorkspaceLease {
    return this.#database.immediate(() => {
      const workspace = path.resolve(disposition.canonicalWorkspace);
      const lease = this.#requiredLease(workspace);
      const current = parseWorkspaceCliAcknowledgmentDisposition(lease.disposition);
      if (
        lease.state !== 'ReleasePending' ||
        !current ||
        current.jobId !== disposition.jobId ||
        current.attemptId !== disposition.attemptId ||
        path.resolve(current.canonicalWorkspace) !== workspace
      ) {
        return lease;
      }
      assertLeaseTransition(lease.state, 'Quarantined');
      const refused = workspaceCliAcknowledgmentRefusal(
        {
          jobId: current.jobId,
          attemptId: current.attemptId,
          canonicalWorkspace: workspace,
          previousDisposition: current.previousDisposition,
        },
        reason,
      );
      this.#database.raw
        .prepare(
          `UPDATE workspace_leases
              SET state = 'Quarantined', disposition = ?, updated_at = ?, released_at = NULL
            WHERE canonical_workspace = ?`,
        )
        .run(serializeWorkspaceCliAcknowledgmentRequest(refused), this.#timestamp(), workspace);
      return this.#requiredLease(workspace);
    });
  }

  transitionLease(
    canonicalWorkspace: string,
    nextState: LeaseState,
    disposition: string | null = null,
  ): WorkspaceLease {
    return this.#database.immediate(() => {
      const workspace = path.resolve(canonicalWorkspace);
      const lease = this.#requiredLease(workspace);
      assertLeaseTransition(lease.state, nextState);
      if (lease.state !== nextState) {
        const timestamp = this.#timestamp();
        this.#database.raw
          .prepare(
            `UPDATE workspace_leases
                SET state = ?, disposition = ?, updated_at = ?, released_at = ?
              WHERE canonical_workspace = ?`,
          )
          .run(
            nextState,
            disposition,
            timestamp,
            nextState === 'Released' ? timestamp : null,
            workspace,
          );
      }
      return this.#requiredLease(workspace);
    });
  }

  recordProjection(jobId: string, semanticKey: string): Projection {
    return this.#database.immediate(() => {
      this.#requiredJob(jobId);
      this.#database.raw
        .prepare(
          `INSERT INTO projections
             (id, job_id, semantic_key, state, created_at, updated_at)
           VALUES (?, ?, ?, 'Pending', ?, ?)
           ON CONFLICT(semantic_key) DO NOTHING`,
        )
        .run(randomUUID(), jobId, semanticKey, this.#timestamp(), this.#timestamp());
      const projection = this.#projection(semanticKey);
      if (!projection) throw new Error(`Projection ${semanticKey} was not persisted`);
      if (projection.jobId !== jobId)
        throw new Error(`Projection key ${semanticKey} belongs to another job`);
      return projection;
    });
  }

  getProjection(semanticKey: string): Projection | null {
    return this.#projection(semanticKey);
  }

  transitionProjection(
    semanticKey: string,
    nextState: ProjectionState,
    blockedReason: string | null = null,
  ): Projection {
    return this.#database.immediate(() => {
      const projection = this.#projection(semanticKey);
      if (!projection) throw new Error(`Unknown projection ${semanticKey}`);
      assertProjectionTransition(projection.state, nextState);
      if (
        projection.state !== nextState ||
        (nextState === 'Blocked' && projection.blockedReason !== blockedReason)
      ) {
        this.#database.raw
          .prepare(
            'UPDATE projections SET state = ?, blocked_reason = ?, updated_at = ? WHERE semantic_key = ?',
          )
          .run(nextState, blockedReason, this.#timestamp(), semanticKey);
      }
      const updated = this.#projection(semanticKey);
      if (!updated) throw new Error(`Projection ${semanticKey} disappeared`);
      return updated;
    });
  }

  #requiredJob(jobId: string): Job {
    const job = this.getJob(jobId);
    if (!job) throw new Error(`Unknown job ${jobId}`);
    return job;
  }

  #requiredJobByMarker(sourceMarker: string): Job {
    const row = this.#database.raw
      .prepare('SELECT * FROM jobs WHERE source_marker = ?')
      .get(sourceMarker) as JobRow | undefined;
    if (!row) throw new Error(`Job marker ${sourceMarker} was not persisted`);
    return mapJob(row);
  }

  #requiredAttempt(attemptId: string): Attempt {
    const attempt = this.getAttempt(attemptId);
    if (!attempt) throw new Error(`Unknown attempt ${attemptId}`);
    return attempt;
  }

  #updateAttemptState(attempt: Attempt, nextState: AttemptState): void {
    assertAttemptTransition(attempt.state, nextState);
    if (attempt.state === nextState) return;
    const timestamp = this.#timestamp();
    this.#database.raw
      .prepare('UPDATE attempts SET state = ?, updated_at = ?, terminal_at = ? WHERE id = ?')
      .run(nextState, timestamp, nextState === 'Terminal' ? timestamp : null, attempt.id);
  }

  #requiredIntervention(jobId: string, eventKey: string): InterventionEvent {
    const row = this.#database.raw
      .prepare('SELECT * FROM intervention_events WHERE job_id = ? AND event_key = ?')
      .get(jobId, eventKey) as InterventionRow | undefined;
    if (!row) throw new Error(`Unknown intervention ${eventKey} for job ${jobId}`);
    return mapIntervention(row);
  }

  #requiredFollowUp(jobId: string, eventKey: string): FollowUpAction {
    const followUp = this.#followUp(jobId, eventKey);
    if (!followUp) throw new Error(`Unknown follow-up ${eventKey} for job ${jobId}`);
    return followUp;
  }

  #followUp(jobId: string, eventKey: string): FollowUpAction | null {
    const row = this.#database.raw
      .prepare('SELECT * FROM follow_up_actions WHERE job_id = ? AND event_key = ?')
      .get(jobId, eventKey) as FollowUpRow | undefined;
    return row ? mapFollowUp(row) : null;
  }

  #requiredPendingWorkspaceAcknowledgment(
    identity: WorkspaceAcknowledgmentIdentity,
    phase?: 'awaiting-inspection' | 'inspected-safe' | 'restored-safe',
  ): {
    workspace: string;
    lease: WorkspaceLease;
    disposition: NonNullable<ReturnType<typeof parseWorkspaceAcknowledgmentDisposition>>;
  } {
    const workspace = path.resolve(identity.canonicalWorkspace);
    const lease = this.#requiredLease(workspace);
    const disposition = parseWorkspaceAcknowledgmentDisposition(lease.disposition);
    if (
      lease.state !== 'ReleasePending' ||
      !disposition ||
      disposition.phase === 'refused' ||
      (phase !== undefined && disposition.phase !== phase) ||
      !matchesWorkspaceAcknowledgmentIdentity(disposition, identity) ||
      lease.jobId !== identity.jobId ||
      lease.attemptId !== identity.attemptId
    ) {
      throw new Error('Workspace lease is not the exact pending acknowledgment operation');
    }
    const action = this.#requiredFollowUp(identity.jobId, identity.eventKey);
    const successor = this.#requiredFollowUp(identity.jobId, identity.successorEventKey);
    if (action.completedAt === null || successor.completedAt === null) {
      throw new Error('Workspace acknowledgment is not durably consumed and staged');
    }
    return { workspace, lease, disposition };
  }

  #lease(canonicalWorkspace: string): WorkspaceLease | null {
    const row = this.#database.raw
      .prepare('SELECT * FROM workspace_leases WHERE canonical_workspace = ?')
      .get(canonicalWorkspace) as LeaseRow | undefined;
    return row ? mapLease(row) : null;
  }

  #requiredLease(canonicalWorkspace: string): WorkspaceLease {
    const lease = this.#lease(canonicalWorkspace);
    if (!lease) throw new Error(`Unknown workspace lease ${canonicalWorkspace}`);
    return lease;
  }

  #projection(semanticKey: string): Projection | null {
    const row = this.#database.raw
      .prepare('SELECT * FROM projections WHERE semantic_key = ?')
      .get(semanticKey) as ProjectionRow | undefined;
    return row ? mapProjection(row) : null;
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }
}

function mapJob(row: JobRow): Job {
  return {
    id: row.id,
    sequence: row.sequence,
    sourceMarker: row.source_marker,
    sourcePath: row.source_path,
    provider: row.provider,
    directive: row.directive,
    context: row.context,
    repository: row.repository,
    state: row.state,
    cancellationRequested: row.cancellation_requested === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    terminalAt: row.terminal_at,
  };
}

function mapAttempt(row: AttemptRow): Attempt {
  return {
    id: row.id,
    jobId: row.job_id,
    attemptNumber: row.attempt_number,
    state: row.state,
    logPath: row.log_path,
    provider: row.provider,
    sessionId: row.session_id,
    observationCursor: row.observation_cursor,
    observationHash: row.observation_hash,
    uncertaintyReason: row.uncertainty_reason,
    processId: row.process_id,
    processStartIdentity: row.process_start_identity,
    latestOutput: row.latest_output,
    launchMetadata: parseObject(row.launch_metadata_json, `attempt ${row.id} launch metadata`),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    terminalAt: row.terminal_at,
  };
}

function parseObject(value: string | null, label: string): Record<string, unknown> | null {
  if (value === null) return null;
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid ${label}`);
  }
  return parsed as Record<string, unknown>;
}

function parseProviderEvidence(value: string, row: ProviderEventRow): ProviderEvidence {
  const parsed = JSON.parse(value) as unknown;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('kind' in parsed) ||
    !('eventKey' in parsed) ||
    parsed.kind !== row.kind ||
    parsed.eventKey !== row.event_key
  ) {
    throw new Error(`Invalid provider event ${row.event_key} for attempt ${row.attempt_id}`);
  }
  return parsed as ProviderEvidence;
}

function mapIntervention(row: InterventionRow): InterventionEvent {
  return {
    id: row.id,
    jobId: row.job_id,
    eventKey: row.event_key,
    prompt: row.prompt,
    createdAt: row.created_at,
    closedAt: row.closed_at,
    response: row.response,
  };
}

function mapFollowUp(row: FollowUpRow): FollowUpAction {
  return {
    id: row.id,
    jobId: row.job_id,
    eventKey: row.event_key,
    text: row.text,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

function mapLease(row: LeaseRow): WorkspaceLease {
  return {
    canonicalWorkspace: row.canonical_workspace,
    jobId: row.job_id,
    attemptId: row.attempt_id,
    state: row.state,
    disposition: row.disposition,
    metadata: parseObject(row.lease_metadata_json, `workspace ${row.canonical_workspace} metadata`),
    heldAt: row.held_at,
    updatedAt: row.updated_at,
    releasedAt: row.released_at,
  };
}

function mapProjection(row: ProjectionRow): Projection {
  return {
    id: row.id,
    jobId: row.job_id,
    semanticKey: row.semantic_key,
    state: row.state,
    blockedReason: row.blocked_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
