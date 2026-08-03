import { chmodSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openLedgerDatabase, type LedgerDatabase } from '../../src/ledger/database.js';
import { LedgerRepository } from '../../src/ledger/repositories.js';
import {
  parseWorkspaceAcknowledgmentDisposition,
  workspaceAcknowledgmentEventKey,
} from '../../src/workspaces/acknowledgment.js';

const openDatabases: LedgerDatabase[] = [];

function fixture(): { stateDirectory: string; ledger: LedgerRepository; database: LedgerDatabase } {
  const stateDirectory = mkdtempSync(path.join(tmpdir(), 'mdspool-ledger-'));
  const database = openLedgerDatabase(stateDirectory);
  openDatabases.push(database);
  return { stateDirectory, database, ledger: new LedgerRepository(database) };
}

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

describe('ledger repository', () => {
  it('claims one job per source marker while preserving identical separate directives and FIFO', () => {
    const { stateDirectory, database, ledger } = fixture();
    const first = ledger.claimJob({
      sourceMarker: 'marker-1',
      sourcePath: '/vault/week.md',
      provider: 'claude',
      directive: 'review this PR',
      context: 'PR https://github.com/acme/app/pull/1',
    });
    const duplicate = ledger.claimJob({
      sourceMarker: 'marker-1',
      sourcePath: '/vault/week.md',
      provider: 'claude',
      directive: 'review this PR',
      context: 'changed scanner context must not create a second job',
    });
    const second = ledger.claimJob({
      sourceMarker: 'marker-2',
      sourcePath: '/vault/week.md',
      provider: 'claude',
      directive: 'review this PR',
      context: 'PR https://github.com/acme/app/pull/1',
    });

    expect(duplicate).toEqual(first);
    expect(second.id).not.toBe(first.id);
    expect(ledger.listDispatchableJobs().map((job) => job.id)).toEqual([first.id, second.id]);

    database.close();
    openDatabases.splice(openDatabases.indexOf(database), 1);
    const reopened = openLedgerDatabase(stateDirectory);
    openDatabases.push(reopened);
    expect(new LedgerRepository(reopened).listDispatchableJobs().map((job) => job.id)).toEqual([
      first.id,
      second.id,
    ]);
  });

  it('persists attempts and enforces one active attempt and unique provider sessions', () => {
    const { ledger } = fixture();
    const firstJob = ledger.claimJob({
      sourceMarker: 'one',
      sourcePath: '/week.md',
      provider: 'claude',
      directive: 'one',
      context: '',
    });
    const secondJob = ledger.claimJob({
      sourceMarker: 'two',
      sourcePath: '/week.md',
      provider: 'claude',
      directive: 'two',
      context: '',
    });
    const prepared = ledger.prepareAttempt(firstJob.id, '/private/logs/first.log');
    expect(prepared.state).toBe('Prepared');
    expect(() => ledger.prepareAttempt(firstJob.id, '/private/logs/again.log')).toThrow(
      /active attempt/i,
    );
    ledger.transitionAttempt(prepared.id, 'Launching');
    ledger.markAttemptUncertain(prepared.id, 'spawn returned without durable session evidence');
    expect(ledger.getAttempt(prepared.id)?.state).toBe('Uncertain');
    expect(() => ledger.prepareAttempt(firstJob.id, '/private/logs/relaunch.log')).toThrow(
      /active attempt/i,
    );

    ledger.recordAttemptSession(prepared.id, 'claude', 'session-1');
    ledger.transitionAttempt(prepared.id, 'Running');
    ledger.updateAttemptObservation(prepared.id, 'cursor-7', 'hash-7');
    const secondAttempt = ledger.prepareAttempt(secondJob.id, '/private/logs/second.log');
    expect(() => ledger.recordAttemptSession(secondAttempt.id, 'claude', 'session-1')).toThrow();
    expect(ledger.getAttempt(prepared.id)).toMatchObject({
      provider: 'claude',
      sessionId: 'session-1',
      observationCursor: 'cursor-7',
      observationHash: 'hash-7',
    });
  });

  it('stores multiple intervention events and closes each by its own key', () => {
    const { ledger } = fixture();
    const job = ledger.claimJob({
      sourceMarker: 'events',
      sourcePath: '/week.md',
      provider: 'claude',
      directive: 'ask me twice',
      context: '',
    });
    const first = ledger.recordIntervention(job.id, 'question-1', 'Which branch?');
    const second = ledger.recordIntervention(job.id, 'question-2', 'Which API?');
    expect(ledger.recordIntervention(job.id, 'question-1', 'changed text')).toEqual(first);

    ledger.closeIntervention(job.id, 'question-1', 'main');
    const interventions = ledger.listInterventions(job.id);
    expect(interventions[0]?.id).toBe(first.id);
    expect(interventions[0]?.closedAt).not.toBeNull();
    expect(interventions[0]?.response).toBe('main');
    expect(interventions[1]?.id).toBe(second.id);
    expect(interventions[1]?.closedAt).toBeNull();
  });

  it('keeps a successful job independent from a quarantined workspace lease', () => {
    const { ledger } = fixture();
    const job = ledger.claimJob({
      sourceMarker: 'lease',
      sourcePath: '/week.md',
      provider: 'codex',
      directive: 'work',
      context: '',
    });
    const attempt = ledger.prepareAttempt(job.id, '/logs/work.log');
    ledger.transitionAttempt(attempt.id, 'Launching');
    ledger.transitionAttempt(attempt.id, 'Running');
    const lease = ledger.holdLease('/repos/app-a', job.id, attempt.id);
    ledger.transitionJob(job.id, 'Working');
    ledger.transitionJob(job.id, 'Completed');
    ledger.transitionAttempt(attempt.id, 'Terminal');
    ledger.transitionLease(lease.canonicalWorkspace, 'Quarantined', 'dirty repository');

    expect(ledger.getJob(job.id)?.state).toBe('Completed');
    expect(ledger.getLease(lease.canonicalWorkspace)).toMatchObject({
      state: 'Quarantined',
      disposition: 'dirty repository',
    });
  });

  it('claims one exact quarantine action and stages its successor atomically', () => {
    const { ledger } = fixture();
    const job = ledger.claimJob({
      sourceMarker: 'workspace-ack-ledger',
      sourcePath: '/week.md',
      provider: 'codex',
      directive: 'work',
      context: '',
    });
    const attempt = ledger.prepareAttempt(job.id, '/logs/workspace-ack.log');
    const workspace = '/repos/workspace-ack';
    ledger.holdLease(workspace, job.id, attempt.id);
    ledger.transitionLease(workspace, 'Quarantined', 'changed');
    const eventKey = workspaceAcknowledgmentEventKey(attempt.id, 0);
    const successorEventKey = workspaceAcknowledgmentEventKey(attempt.id, 1);
    ledger.recordFollowUp(job.id, eventKey, 'Inspect quarantined workspace');

    const claimed = ledger.claimWorkspaceAcknowledgment({
      jobId: job.id,
      attemptId: attempt.id,
      canonicalWorkspace: workspace,
      eventKey,
      successorEventKey,
      successorText: 'Inspect quarantined workspace again',
    });

    expect(claimed.kind).toBe('claimed');
    const followUps = ledger.listFollowUps(job.id);
    expect(followUps.map(({ eventKey: key }) => key)).toEqual([eventKey, successorEventKey]);
    expect(followUps.every(({ completedAt }) => completedAt !== null)).toBe(true);
    const pending = ledger.getLease(workspace);
    expect(pending?.state).toBe('ReleasePending');
    expect(parseWorkspaceAcknowledgmentDisposition(pending?.disposition ?? null)).toMatchObject({
      phase: 'awaiting-inspection',
      jobId: job.id,
      attemptId: attempt.id,
      canonicalWorkspace: path.resolve(workspace),
      eventKey,
      successorEventKey,
    });

    expect(
      ledger.claimWorkspaceAcknowledgment({
        jobId: job.id,
        attemptId: attempt.id,
        canonicalWorkspace: workspace,
        eventKey,
        successorEventKey,
        successorText: 'duplicate',
      }),
    ).toMatchObject({ kind: 'refused' });
    expect(ledger.listFollowUps(job.id)).toHaveLength(2);
  });

  it('fails closed on stale action identity and activates one successor after refusal', () => {
    const { ledger } = fixture();
    const job = ledger.claimJob({
      sourceMarker: 'workspace-ack-stale',
      sourcePath: '/week.md',
      provider: 'codex',
      directive: 'work',
      context: '',
    });
    const attempt = ledger.prepareAttempt(job.id, '/logs/workspace-ack-stale.log');
    const workspace = '/repos/workspace-ack-stale';
    ledger.holdLease(workspace, job.id, attempt.id);
    ledger.transitionLease(workspace, 'Quarantined', 'changed');
    const eventKey = workspaceAcknowledgmentEventKey(attempt.id, 0);
    const successorEventKey = workspaceAcknowledgmentEventKey(attempt.id, 1);
    ledger.recordFollowUp(job.id, eventKey, 'Inspect quarantined workspace');

    expect(
      ledger.claimWorkspaceAcknowledgment({
        jobId: job.id,
        attemptId: 'stale-attempt',
        canonicalWorkspace: workspace,
        eventKey,
        successorEventKey,
        successorText: 'Inspect again',
      }),
    ).toMatchObject({ kind: 'refused' });
    expect(ledger.getLease(workspace)?.state).toBe('Quarantined');
    expect(ledger.listFollowUps(job.id)).toMatchObject([{ eventKey, completedAt: null }]);

    expect(
      ledger.claimWorkspaceAcknowledgment({
        jobId: job.id,
        attemptId: attempt.id,
        canonicalWorkspace: workspace,
        eventKey,
        successorEventKey,
        successorText: 'Inspect again',
      }),
    ).toMatchObject({ kind: 'claimed' });
    ledger.refuseWorkspaceAcknowledgment({
      canonicalWorkspace: workspace,
      jobId: job.id,
      attemptId: attempt.id,
      eventKey,
      successorEventKey,
      reason: 'Workspace is still unsafe',
      successorText: 'Inspect again: Workspace is still unsafe',
    });

    expect(ledger.getLease(workspace)?.state).toBe('Quarantined');
    const followUps = ledger.listFollowUps(job.id);
    expect(followUps[0]?.eventKey).toBe(eventKey);
    expect(followUps[0]?.completedAt).not.toBeNull();
    expect(followUps[1]).toMatchObject({
      eventKey: successorEventKey,
      completedAt: null,
      text: 'Inspect again: Workspace is still unsafe',
    });
  });

  it('applies queued cancellation immediately but waits for running terminal evidence', () => {
    const { ledger } = fixture();
    const queued = ledger.claimJob({
      sourceMarker: 'cancel-queued',
      sourcePath: '/week.md',
      provider: 'codex',
      directive: 'cancel',
      context: '',
    });
    expect(ledger.requestCancellation(queued.id).state).toBe('Cancelled');

    const running = ledger.claimJob({
      sourceMarker: 'cancel-running',
      sourcePath: '/week.md',
      provider: 'codex',
      directive: 'cancel later',
      context: '',
    });
    const attempt = ledger.prepareAttempt(running.id, '/logs/cancel.log');
    ledger.transitionAttempt(attempt.id, 'Launching');
    ledger.transitionAttempt(attempt.id, 'Running');
    ledger.transitionJob(running.id, 'Working');
    expect(() => ledger.transitionJob(running.id, 'Cancelled')).toThrow(/terminal evidence/i);
    expect(ledger.requestCancellation(running.id)).toMatchObject({
      state: 'Working',
      cancellationRequested: true,
    });
    expect(ledger.confirmCancellation(running.id, attempt.id).state).toBe('Cancelled');
  });

  it('finalizes an attempt and its job in one ledger transaction', () => {
    const { ledger } = fixture();
    const job = ledger.claimJob({
      sourceMarker: 'atomic-terminal',
      sourcePath: '/week.md',
      provider: 'codex',
      directive: 'finish atomically',
      context: '',
    });
    const attempt = ledger.prepareAttempt(job.id, '/logs/atomic.log');
    ledger.transitionAttempt(attempt.id, 'Launching');
    ledger.transitionAttempt(attempt.id, 'Running');

    const completed = ledger.finalizeAttemptAndJob(attempt.id, 'Completed');

    expect(completed.state).toBe('Completed');
    expect(ledger.getAttempt(attempt.id)?.state).toBe('Terminal');
    expect(() => ledger.finalizeAttemptAndJob(attempt.id, 'Failed')).toThrow(/already terminal/i);
  });

  it('keeps projection state and semantic idempotency independent from job state', () => {
    const { ledger } = fixture();
    const job = ledger.claimJob({
      sourceMarker: 'projection',
      sourcePath: '/week.md',
      provider: 'codex',
      directive: 'project me',
      context: '',
    });
    const pending = ledger.recordProjection(job.id, `receipt:${job.id}`);
    expect(ledger.recordProjection(job.id, `receipt:${job.id}`)).toEqual(pending);
    expect(
      ledger.transitionProjection(`receipt:${job.id}`, 'Blocked', 'note changed during patch'),
    ).toMatchObject({ state: 'Blocked', blockedReason: 'note changed during patch' });
    expect(ledger.transitionProjection(`receipt:${job.id}`, 'Pending')).toMatchObject({
      state: 'Pending',
    });
    expect(ledger.transitionProjection(`receipt:${job.id}`, 'Applied')).toMatchObject({
      state: 'Applied',
    });
    expect(ledger.getJob(job.id)?.state).toBe('Queued');
  });

  it('creates owner-only state files and directories', () => {
    const { stateDirectory, database } = fixture();
    database.immediate(() => undefined);
    for (const item of [
      stateDirectory,
      path.join(stateDirectory, 'logs'),
      path.join(stateDirectory, 'tmp'),
    ]) {
      expect(statSync(item).mode & 0o777).toBe(0o700);
    }
    expect(statSync(path.join(stateDirectory, 'mdspool.sqlite')).mode & 0o777).toBe(0o600);

    // The opener restores restrictive permissions if an existing DB was loosened.
    chmodSync(path.join(stateDirectory, 'mdspool.sqlite'), 0o644);
    database.close();
    openDatabases.splice(openDatabases.indexOf(database), 1);
    const reopened = openLedgerDatabase(stateDirectory);
    openDatabases.push(reopened);
    expect(statSync(path.join(stateDirectory, 'mdspool.sqlite')).mode & 0o777).toBe(0o600);
  });
});
