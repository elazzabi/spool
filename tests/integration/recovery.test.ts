import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openLedgerDatabase, type LedgerDatabase } from '../../src/ledger/database.js';
import { DaemonLock, DaemonLockConflictError } from '../../src/ledger/daemon-lock.js';
import { OutboxRepository } from '../../src/ledger/outbox.js';
import { LedgerRepository } from '../../src/ledger/repositories.js';
import {
  parseWorkspaceAcknowledgmentDisposition,
  workspaceAcknowledgmentEventKey,
} from '../../src/workspaces/acknowledgment.js';

const databases: LedgerDatabase[] = [];

function openFixture(): {
  database: LedgerDatabase;
  ledger: LedgerRepository;
  stateDirectory: string;
} {
  const stateDirectory = mkdtempSync(path.join(tmpdir(), 'mdspool-recovery-'));
  const database = openLedgerDatabase(stateDirectory);
  databases.push(database);
  return { database, ledger: new LedgerRepository(database), stateDirectory };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('crash recovery protocols', () => {
  it('recovers prepared, launching, uncertain, and session-persisted boundaries idempotently', () => {
    const { database, ledger, stateDirectory } = openFixture();
    const jobs = ['prepared', 'launching', 'uncertain', 'session'].map((marker) =>
      ledger.claimJob({
        sourceMarker: marker,
        sourcePath: '/week.md',
        provider: 'claude',
        directive: marker,
        context: '',
      }),
    );
    const attempts = jobs.map((job) => ledger.prepareAttempt(job.id, `/logs/${job.id}.log`));
    ledger.transitionAttempt(attempts[1]!.id, 'Launching');
    ledger.transitionAttempt(attempts[2]!.id, 'Launching');
    ledger.markAttemptUncertain(attempts[2]!.id, 'lost launch acknowledgement');
    ledger.transitionAttempt(attempts[3]!.id, 'Launching');
    ledger.recordAttemptSession(attempts[3]!.id, 'claude', 'durable-session');

    database.close();
    databases.splice(databases.indexOf(database), 1);
    const reopened = openLedgerDatabase(stateDirectory);
    databases.push(reopened);
    const recovered = new LedgerRepository(reopened);

    expect(recovered.listRecoverableAttempts().map(({ state }) => state)).toEqual([
      'Prepared',
      'Launching',
      'Uncertain',
      'Launching',
    ]);
    expect(recovered.getAttempt(attempts[3]!.id)?.sessionId).toBe('durable-session');
    expect(recovered.listDispatchableJobs()).toEqual([]);
    expect(() => recovered.prepareAttempt(jobs[2]!.id, '/logs/duplicate.log')).toThrow(
      /active attempt/i,
    );
  });

  it('keeps one working attempt active while an independent queued job remains dispatchable', () => {
    const { database, ledger, stateDirectory } = openFixture();
    const working = ledger.claimJob({
      sourceMarker: 'working-on-restart',
      sourcePath: '/week.md',
      provider: 'claude',
      directive: 'working',
      context: '',
    });
    const queued = ledger.claimJob({
      sourceMarker: 'queued-on-restart',
      sourcePath: '/week.md',
      provider: 'claude',
      directive: 'queued',
      context: '',
    });
    const attempt = ledger.prepareAttempt(working.id, '/logs/working.log');
    ledger.transitionAttempt(attempt.id, 'Launching');
    ledger.transitionAttempt(attempt.id, 'Running');
    ledger.transitionJob(working.id, 'Working');

    database.close();
    databases.splice(databases.indexOf(database), 1);
    const reopened = openLedgerDatabase(stateDirectory);
    databases.push(reopened);
    const recovered = new LedgerRepository(reopened);

    expect(recovered.listRecoverableAttempts()).toHaveLength(1);
    expect(recovered.listDispatchableJobs().map(({ id }) => id)).toEqual([queued.id]);
    expect(() => recovered.prepareAttempt(working.id, '/logs/duplicate.log')).toThrow(
      /active attempt/i,
    );
  });

  it('retains an undelivered current-note follow-up across restart and delivers once', () => {
    const { database, ledger, stateDirectory } = openFixture();
    const job = ledger.claimJob({
      sourceMarker: 'follow-up',
      sourcePath: '/old-week.md',
      provider: 'claude',
      directive: 'finish',
      context: '',
    });
    ledger.recordFollowUp(job.id, 'completion:1', 'Check agent output using claude attach s1');
    const outbox = new OutboxRepository(database);
    outbox.enqueue({
      semanticKey: `follow-up:${job.id}:completion:1`,
      kind: 'current-week-follow-up',
      payload: { jobId: job.id, eventKey: 'completion:1' },
    });

    database.close();
    databases.splice(databases.indexOf(database), 1);
    const reopened = openLedgerDatabase(stateDirectory);
    databases.push(reopened);
    const recovered = new OutboxRepository(reopened);
    const claimed = recovered.claimNext('writer-1', 1_000, new Date('2026-07-18T10:00:00Z'));
    expect(claimed?.semanticKey).toContain('follow-up');
    recovered.acknowledge(claimed!.id, 'writer-1', new Date('2026-07-18T10:00:00.999Z'));
    expect(recovered.claimNext('writer-2', 1_000, new Date('2026-07-18T10:00:02Z'))).toBeNull();
    const duplicate = recovered.enqueue({
      semanticKey: `follow-up:${job.id}:completion:1`,
      kind: 'current-week-follow-up',
      payload: { jobId: job.id, eventKey: 'completion:1' },
    });
    expect(duplicate.acknowledgedAt).not.toBeNull();
  });

  it('persists distinct pre-inspection and post-inspection acknowledgment recovery phases', () => {
    const { database, ledger, stateDirectory } = openFixture();
    const job = ledger.claimJob({
      sourceMarker: 'workspace-ack-recovery',
      sourcePath: '/week.md',
      provider: 'codex',
      directive: 'work',
      context: '',
    });
    const attempt = ledger.prepareAttempt(job.id, '/logs/workspace-ack-recovery.log');
    const workspace = '/repos/workspace-ack-recovery';
    const eventKey = workspaceAcknowledgmentEventKey(attempt.id, 0);
    const successorEventKey = workspaceAcknowledgmentEventKey(attempt.id, 1);
    ledger.holdLease(workspace, job.id, attempt.id);
    ledger.transitionLease(workspace, 'Quarantined', 'changed');
    ledger.recordFollowUp(job.id, eventKey, 'Inspect quarantined workspace');
    const claim = ledger.claimWorkspaceAcknowledgment({
      jobId: job.id,
      attemptId: attempt.id,
      canonicalWorkspace: workspace,
      eventKey,
      successorEventKey,
      successorText: 'Inspect quarantined workspace again',
    });
    expect(claim.kind).toBe('claimed');

    database.close();
    databases.splice(databases.indexOf(database), 1);
    const reopened = openLedgerDatabase(stateDirectory);
    databases.push(reopened);
    const recovered = new LedgerRepository(reopened);
    const beforeInspection = parseWorkspaceAcknowledgmentDisposition(
      recovered.getLease(workspace)?.disposition ?? null,
    );
    expect(beforeInspection?.phase).toBe('awaiting-inspection');
    recovered.markWorkspaceAcknowledgmentInspected(beforeInspection!);

    reopened.close();
    databases.splice(databases.indexOf(reopened), 1);
    const reopenedAgain = openLedgerDatabase(stateDirectory);
    databases.push(reopenedAgain);
    const recoveredAgain = new LedgerRepository(reopenedAgain);
    expect(
      parseWorkspaceAcknowledgmentDisposition(
        recoveredAgain.getLease(workspace)?.disposition ?? null,
      )?.phase,
    ).toBe('inspected-safe');
    recoveredAgain.markWorkspaceAcknowledgmentRestored(beforeInspection!);
    expect(
      parseWorkspaceAcknowledgmentDisposition(
        recoveredAgain.getLease(workspace)?.disposition ?? null,
      )?.phase,
    ).toBe('restored-safe');
    const followUps = recoveredAgain.listFollowUps(job.id);
    expect(followUps.map(({ eventKey: key }) => key)).toEqual([eventKey, successorEventKey]);
    expect(followUps.every(({ completedAt }) => completedAt !== null)).toBe(true);
  });

  it('expires outbox claims, rejects the old owner, and supports explicit retry release', () => {
    const { database } = openFixture();
    const outbox = new OutboxRepository(database);
    const item = outbox.enqueue({ semanticKey: 'projection:1', kind: 'note-patch', payload: {} });
    expect(outbox.claimNext('owner-a', 1_000, new Date('2026-07-18T10:00:00Z'))?.id).toBe(item.id);
    expect(outbox.claimNext('owner-b', 1_000, new Date('2026-07-18T10:00:00.500Z'))).toBeNull();
    expect(outbox.claimNext('owner-b', 1_000, new Date('2026-07-18T10:00:02Z'))?.id).toBe(item.id);
    expect(() => outbox.acknowledge(item.id, 'owner-a')).toThrow(/owner/i);
    outbox.release(
      item.id,
      'owner-b',
      'temporary write failure',
      new Date('2026-07-18T10:00:02.500Z'),
    );
    expect(outbox.claimNext('owner-c', 1_000, new Date('2026-07-18T10:00:03Z'))?.id).toBe(item.id);
  });

  it('rejects acknowledgement after ownership expiry and mismatched semantic-key reuse', () => {
    const { database } = openFixture();
    const outbox = new OutboxRepository(database);
    const item = outbox.enqueue({
      semanticKey: 'projection:strict',
      kind: 'note-patch',
      payload: { version: 1 },
    });
    outbox.claimNext('expired-owner', 1_000, new Date('2026-07-18T10:00:00Z'));

    expect(() =>
      outbox.acknowledge(item.id, 'expired-owner', new Date('2026-07-18T10:00:02Z')),
    ).toThrow(/expired/i);
    expect(() =>
      outbox.enqueue({
        semanticKey: 'projection:strict',
        kind: 'note-patch',
        payload: { version: 2 },
      }),
    ).toThrow(/different.*payload/i);
  });

  it('arbitrates daemon ownership using expiry, process identity, and compare-before-release', () => {
    const { database } = openFixture();
    let now = 1_000;
    const identities = new Map<number, string | null>([
      [10, 'start-a'],
      [11, 'start-b'],
    ]);
    const lock = new DaemonLock(database, {
      now: () => now,
      processIdentity: (pid) => identities.get(pid) ?? null,
    });
    const first = lock.acquire({ nonce: 'nonce-a', pid: 10, processStartIdentity: 'start-a' }, 500);
    expect(() =>
      lock.acquire({ nonce: 'nonce-b', pid: 11, processStartIdentity: 'start-b' }, 500),
    ).toThrow(DaemonLockConflictError);

    identities.set(10, 'reused-pid-start');
    const recoveredFromPidReuse = lock.acquire(
      { nonce: 'nonce-b', pid: 11, processStartIdentity: 'start-b' },
      500,
    );
    expect(recoveredFromPidReuse.nonce).toBe('nonce-b');
    expect(lock.release(first)).toBe(false);
    expect(lock.release(recoveredFromPidReuse)).toBe(true);

    const live = lock.acquire(
      { nonce: 'nonce-c', pid: 10, processStartIdentity: 'reused-pid-start' },
      500,
    );
    now = 2_000;
    const staleRecovery = lock.acquire(
      { nonce: 'nonce-d', pid: 11, processStartIdentity: 'start-b' },
      500,
    );
    expect(staleRecovery.nonce).toBe('nonce-d');
    expect(lock.heartbeat(live, 500)).toBe(false);
    expect(lock.heartbeat(staleRecovery, 500)).toBe(true);
  });
});
