import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { openLedgerDatabase, type LedgerDatabase } from '../../src/ledger/database.js';
import { LedgerRepository } from '../../src/ledger/repositories.js';
import {
  GitCommandError,
  inspectGitWorkspace,
  NodeGitRunner,
  type GitRunner,
} from '../../src/workspaces/git.js';
import {
  WORKSPACE_SENTINEL_NAME,
  WorkspaceSentinelManager,
  type ProcessBirthIdentity,
  type ProcessIdentityProvider,
  type ProcessMatch,
} from '../../src/workspaces/lease.js';
import { WorkspacePool, type WorkspaceLeaseHandle } from '../../src/workspaces/pool.js';
import { parseQuarantineDetail } from '../../src/workspaces/quarantine.js';
import { parseWorkspaceLeaseHandle } from '../../src/workspaces/persisted-lease.js';
import {
  parseWorkspaceCliAcknowledgmentRequest,
  serializeWorkspaceCliAcknowledgmentDisposition,
  workspaceCliAcknowledgmentDisposition,
  workspaceAcknowledgmentEventKey,
  type ClaimedWorkspaceAcknowledgment,
} from '../../src/workspaces/acknowledgment.js';

const databases: LedgerDatabase[] = [];
const roots: string[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('workspace pool', () => {
  it('reports no configured pool for another repository and never borrows a wrong-origin clone', async () => {
    const root = fixtureRoot();
    const clone = createRepository(root, 'clone', 'other/repository');
    const ledger = createLedger(root, 'state').ledger;
    const pool = new WorkspacePool({
      repositories: [{ repository: 'example/widget', clones: [clone] }],
      ledger,
    });

    await expect(
      pool.acquire({ repository: 'example/other', jobId: 'job', attemptId: 'attempt' }),
    ).resolves.toEqual({
      kind: 'unconfigured',
      repository: 'example/other',
      inspected: [],
    });
    const before = repositorySnapshot(clone);
    const result = await pool.acquire({
      repository: 'example/widget',
      jobId: 'not-needed',
      attemptId: 'not-needed',
    });
    expect(result).toMatchObject({
      kind: 'capacity-unavailable',
      inspected: [{ code: 'unsafe' }],
    });
    expect(result.inspected[0]?.inspection?.reasons).toContainEqual(
      expect.objectContaining({ code: 'origin-mismatch' }),
    );
    expect(repositorySnapshot(clone)).toEqual(before);
  });

  it('leases clones in configured order, reports capacity, and reuses a safely released clone', async () => {
    const root = fixtureRoot();
    const cloneA = createRepository(root, 'clone-a');
    const cloneB = createRepository(root, 'clone-b');
    const { ledger } = createLedger(root, 'state');
    const pool = poolFor(ledger, [cloneA, cloneB]);
    const first = createAttempt(ledger, 'first');
    const second = createAttempt(ledger, 'second');
    const third = createAttempt(ledger, 'third');

    const acquiredFirst = await pool.acquire({ repository: 'example/widget', ...first });
    const acquiredSecond = await pool.acquire({ repository: 'example/widget', ...second });
    const unavailable = await pool.acquire({ repository: 'example/widget', ...third });
    expect(acquiredFirst).toMatchObject({
      kind: 'acquired',
      handle: { canonicalWorkspace: cloneA },
    });
    expect(acquiredSecond).toMatchObject({
      kind: 'acquired',
      handle: { canonicalWorkspace: cloneB },
    });
    expect(unavailable).toMatchObject({
      kind: 'capacity-unavailable',
      inspected: [{ code: 'leased' }, { code: 'leased' }],
    });
    const persistedLease = ledger.getLease(cloneA);
    expect(persistedLease?.metadata).toMatchObject({ version: 1 });
    expect(
      persistedLease && parseWorkspaceLeaseHandle(persistedLease.metadata, persistedLease),
    ).toMatchObject({ canonicalWorkspace: cloneA });
    expect(() => parseWorkspaceLeaseHandle({ version: 2 }, persistedLease!)).toThrow(
      /unsupported version/i,
    );

    const released = await pool.reconcileDisposition(acquiredHandle(acquiredFirst));
    expect(released).toMatchObject({ kind: 'released', lease: { state: 'Released' } });
    await expect(pool.reconcileDisposition(acquiredHandle(acquiredFirst))).resolves.toMatchObject({
      kind: 'released',
      lease: { state: 'Released' },
    });
    const retried = await pool.acquire({ repository: 'example/widget', ...third });
    expect(retried).toMatchObject({
      kind: 'acquired',
      handle: { canonicalWorkspace: cloneA },
    });
  });

  it('finishes a release-pending disposition after its sentinel was already removed', async () => {
    const root = fixtureRoot();
    const clone = createRepository(root, 'clone');
    const { ledger } = createLedger(root, 'state');
    const pool = poolFor(ledger, [clone]);
    const attempt = createAttempt(ledger, 'release-after-unlink');
    const acquired = await pool.acquire({ repository: 'example/widget', ...attempt });
    const handle = acquiredHandle(acquired);
    ledger.transitionLease(handle.canonicalWorkspace, 'ReleasePending');
    unlinkSync(path.join(handle.baseline.gitCommonDirectory, WORKSPACE_SENTINEL_NAME));

    await expect(pool.reconcileDisposition(handle)).resolves.toMatchObject({
      kind: 'released',
      lease: { state: 'Released' },
    });
  });

  it.each(['modified', 'staged', 'untracked', 'conflicted'] as const)(
    'skips a %s repository without changing it',
    async (kind) => {
      const root = fixtureRoot();
      const clone = createRepository(root, 'clone');
      makeDirty(clone, kind);
      const before = repositorySnapshot(clone);
      const { ledger } = createLedger(root, 'state');
      const pool = poolFor(ledger, [clone]);

      const result = await pool.acquire({
        repository: 'example/widget',
        jobId: 'unused',
        attemptId: 'unused',
      });
      expect(result).toMatchObject({ kind: 'capacity-unavailable' });
      expect(result.inspected[0]?.inspection?.reasons).toContainEqual(
        expect.objectContaining({ code: 'worktree-dirty' }),
      );
      expect(repositorySnapshot(clone)).toEqual(before);
    },
  );

  it.each([
    ['rebase-merge', 'rebase'],
    ['rebase-apply', 'rebase'],
    ['MERGE_HEAD', 'merge'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['REVERT_HEAD', 'revert'],
    ['BISECT_LOG', 'bisect'],
    ['BISECT_START', 'bisect'],
    ['sequencer', 'sequencer'],
    ['index.lock', 'index-lock'],
    ['HEAD.lock', 'head-lock'],
    ['config.lock', 'config-lock'],
    ['packed-refs.lock', 'packed-refs-lock'],
  ] as const)('detects %s as an active %s marker', async (marker, expectedKind) => {
    const root = fixtureRoot();
    const clone = createRepository(root, 'clone');
    const gitDirectory = git(clone, ['rev-parse', '--git-dir']);
    const markerPath = path.join(clone, gitDirectory, marker);
    if (marker === 'sequencer' || marker.startsWith('rebase-')) mkdirSync(markerPath);
    else writeFileSync(markerPath, 'test marker');

    const before = repositorySnapshot(clone);
    const inspection = await inspectGitWorkspace(clone, 'example/widget');
    expect(inspection.eligible).toBe(false);
    expect(inspection.fingerprint?.operations).toContainEqual(
      expect.objectContaining({ kind: expectedKind }),
    );
    expect(repositorySnapshot(clone)).toEqual(before);
  });

  it('quarantines a clone changed before spawn and lets a retry advance to the next clone', async () => {
    const root = fixtureRoot();
    const cloneA = createRepository(root, 'clone-a');
    const cloneB = createRepository(root, 'clone-b');
    const { ledger } = createLedger(root, 'state');
    const pool = poolFor(ledger, [cloneA, cloneB]);
    const attempt = createAttempt(ledger, 'race');
    const first = await pool.acquire({ repository: 'example/widget', ...attempt });
    const firstHandle = acquiredHandle(first);
    writeFileSync(path.join(cloneA, 'manual.txt'), 'manual work');

    const verification = await pool.verifyBeforeSpawn(firstHandle);
    expect(verification.kind).toBe('quarantined');
    if (verification.kind !== 'quarantined') throw new Error('Expected quarantine');
    expect(verification.detail.differences.map((difference) => difference.field)).toContain(
      'status',
    );
    expect(ledger.getLease(cloneA)?.state).toBe('Quarantined');
    expect(readFileSync(path.join(cloneA, 'manual.txt'), 'utf8')).toBe('manual work');

    const retry = await pool.acquire({ repository: 'example/widget', ...attempt });
    expect(retry).toMatchObject({
      kind: 'acquired',
      handle: { canonicalWorkspace: cloneB },
    });
  });

  it('keeps a clean lease valid after filesystem device IDs change', async () => {
    const root = fixtureRoot();
    const clone = createRepository(root, 'clone');
    const { ledger } = createLedger(root, 'state');
    const pool = poolFor(ledger, [clone]);
    const attempt = createAttempt(ledger, 'device-drift-before-spawn');
    const handle = acquiredHandle(await pool.acquire({ repository: 'example/widget', ...attempt }));
    handle.baseline.workspaceIdentity.device = 'previous-device';
    handle.baseline.gitDirectoryIdentity.device = 'previous-device';
    handle.baseline.gitCommonDirectoryIdentity.device = 'previous-device';

    await expect(pool.verifyBeforeSpawn(handle)).resolves.toMatchObject({ kind: 'verified' });
  });

  it('quarantines terminal branch, HEAD, remote, and file changes with human action data', async () => {
    const root = fixtureRoot();
    const clone = createRepository(root, 'clone');
    const { ledger } = createLedger(root, 'state');
    const pool = poolFor(ledger, [clone]);
    const attempt = createAttempt(ledger, 'terminal-change');
    const acquired = await pool.acquire({ repository: 'example/widget', ...attempt });
    const handle = acquiredHandle(acquired);

    git(clone, ['checkout', '-b', 'agent-review']);
    writeFileSync(path.join(clone, 'tracked.txt'), 'agent changed it\n');
    git(clone, ['add', 'tracked.txt']);
    git(clone, ['commit', '-m', 'agent change']);
    git(clone, ['remote', 'set-url', 'origin', 'git@github.com:example/changed.git']);
    git(clone, [
      'remote',
      'set-url',
      '--add',
      '--push',
      'origin',
      'git@github.com:example/push-only-change.git',
    ]);
    writeFileSync(path.join(clone, 'left-behind.txt'), 'preserve me');

    const result = await pool.reconcileDisposition(handle);
    expect(result.kind).toBe('quarantined');
    if (result.kind !== 'quarantined') throw new Error('Expected quarantine');
    expect(result.detail.differences.map((difference) => difference.field)).toEqual(
      expect.arrayContaining(['branch', 'head', 'remotes', 'status', 'originRepository']),
    );
    expect(result.detail.humanAction).toContain(clone);
    expect(readFileSync(path.join(clone, 'left-behind.txt'), 'utf8')).toBe('preserve me');
    expect(parseQuarantineDetail(ledger.getLease(clone)?.disposition ?? null)).toMatchObject({
      version: 1,
      workspace: clone,
    });
  });

  it('detects configured path identity replacement before spawn and preserves the old sentinel', async () => {
    const root = fixtureRoot();
    const clone = createRepository(root, 'clone');
    const { ledger } = createLedger(root, 'state');
    const pool = poolFor(ledger, [clone]);
    const attempt = createAttempt(ledger, 'path-swap');
    const acquired = await pool.acquire({ repository: 'example/widget', ...attempt });
    const handle = acquiredHandle(acquired);
    const moved = path.join(root, 'moved-clone');
    renameSync(clone, moved);
    mkdirSync(clone);
    createRepositoryAt(clone);

    const result = await pool.verifyBeforeSpawn(handle);
    expect(result.kind).toBe('quarantined');
    expect(statSync(path.join(moved, '.git', WORKSPACE_SENTINEL_NAME)).isFile()).toBe(true);
    expect(git(clone, ['status', '--porcelain'])).toBe('');
  });

  it('persists quarantine across ledger restart and acknowledges only a currently safe clone', async () => {
    const root = fixtureRoot();
    const clone = createRepository(root, 'clone');
    const stateName = 'state';
    const firstLedger = createLedger(root, stateName);
    const identities = new FakeProcessRegistry();
    identities.register(100, 'birth-a');
    const firstPool = poolFor(firstLedger.ledger, [clone], {
      ownerNonce: 'owner-a',
      processIdentity: identities.provider(100),
    });
    const attempt = createAttempt(firstLedger.ledger, 'persistent-quarantine');
    const acquired = await firstPool.acquire({ repository: 'example/widget', ...attempt });
    writeFileSync(path.join(clone, 'manual.txt'), 'do not delete');
    await firstPool.verifyBeforeSpawn(acquiredHandle(acquired));
    const dirtyStatus = gitBuffer(clone, ['status', '--porcelain=v2', '-z']);
    const refused = await firstPool.acknowledge(clone);
    expect(refused).toMatchObject({ kind: 'refused' });
    expect(gitBuffer(clone, ['status', '--porcelain=v2', '-z'])).toEqual(dirtyStatus);
    expect(readFileSync(path.join(clone, 'manual.txt'), 'utf8')).toBe('do not delete');

    firstLedger.database.close();
    databases.splice(databases.indexOf(firstLedger.database), 1);
    identities.unregister(100);
    identities.register(101, 'birth-b');
    unlinkSync(path.join(clone, 'manual.txt'));
    const reopenedDatabase = openLedgerDatabase(path.join(root, stateName));
    databases.push(reopenedDatabase);
    const reopenedLedger = new LedgerRepository(reopenedDatabase);
    expect(reopenedLedger.getLease(clone)?.state).toBe('Quarantined');
    const restartedPool = poolFor(reopenedLedger, [clone], {
      ownerNonce: 'owner-b',
      processIdentity: identities.provider(101),
    });
    const acknowledged = await restartedPool.acknowledge(clone);
    expect(acknowledged).toMatchObject({ kind: 'released', lease: { state: 'Released' } });
    expect(git(clone, ['status', '--porcelain'])).toBe('');
  });

  it('finishes an approved CLI release after its irreversible sentinel-unlink boundary', async () => {
    const root = fixtureRoot();
    const clone = createRepository(root, 'clone');
    const { ledger } = createLedger(root, 'state');
    const pool = poolFor(ledger, [clone]);
    const attempt = createAttempt(ledger, 'cli-crash-after-unlink');
    const handle = acquiredHandle(await pool.acquire({ repository: 'example/widget', ...attempt }));
    git(clone, ['checkout', '-b', 'human-approved']);
    await pool.reconcileDisposition(handle);
    const quarantined = ledger.getLease(clone)!;
    const disposition = workspaceCliAcknowledgmentDisposition({
      jobId: attempt.jobId,
      attemptId: attempt.attemptId,
      canonicalWorkspace: clone,
      previousDisposition: quarantined.disposition,
    });
    ledger.transitionLease(
      clone,
      'ReleasePending',
      serializeWorkspaceCliAcknowledgmentDisposition(disposition),
    );
    git(clone, ['checkout', 'main']);
    ledger.markWorkspaceCliAcknowledgmentRestored(disposition);
    unlinkSync(path.join(clone, '.git', WORKSPACE_SENTINEL_NAME));
    writeFileSync(path.join(clone, 'after-approval.txt'), 'preserve');

    await expect(pool.reconcileDisposition(handle)).resolves.toMatchObject({
      kind: 'released',
      lease: { state: 'Released' },
    });
    expect(readFileSync(path.join(clone, 'after-approval.txt'), 'utf8')).toBe('preserve');
  });

  it('preserves a durable refusal when a CLI release fails after inspection', async () => {
    const root = fixtureRoot();
    const clone = createRepository(root, 'clone');
    const { ledger } = createLedger(root, 'state');
    const sentinels = new WorkspaceSentinelManager();
    const pool = poolFor(ledger, [clone], undefined, sentinels);
    const attempt = createAttempt(ledger, 'cli-release-refusal');
    const handle = acquiredHandle(await pool.acquire({ repository: 'example/widget', ...attempt }));
    writeFileSync(path.join(clone, 'temporary.txt'), 'unsafe');
    await pool.verifyBeforeSpawn(handle);
    unlinkSync(path.join(clone, 'temporary.txt'));
    ledger.requestWorkspaceCliAcknowledgment(clone);
    vi.spyOn(sentinels, 'releaseQuarantined').mockResolvedValue({
      valid: false,
      reason: 'fixture release failure',
      payload: handle.sentinel,
    });

    const result = await pool.acknowledge(clone);
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') throw new Error('Expected acknowledgment refusal');
    expect(result.reason).toContain('fixture release failure');
    expect(ledger.getLease(clone)?.state).toBe('Quarantined');
    const request = parseWorkspaceCliAcknowledgmentRequest(
      ledger.getLease(clone)?.disposition ?? null,
    );
    expect(request?.phase).toBe('refused');
    expect(request?.reason).toContain('fixture release failure');
  });

  it('acknowledges a clean quarantine through the CLI after origin changes', async () => {
    const root = fixtureRoot();
    const clone = createRepository(root, 'clone');
    const { ledger } = createLedger(root, 'state');
    const pool = poolFor(ledger, [clone]);
    const attempt = createAttempt(ledger, 'cli-origin-drift');
    const handle = acquiredHandle(await pool.acquire({ repository: 'example/widget', ...attempt }));
    git(clone, ['checkout', '-b', 'human-reviewed']);
    await pool.reconcileDisposition(handle);
    git(clone, ['remote', 'remove', 'origin']);

    await expect(pool.acknowledge(clone)).resolves.toMatchObject({ kind: 'released' });
    expect(git(clone, ['branch', '--show-current'])).toBe('main');
  });

  it('refuses a CLI acknowledgment when its sentinel was missing before approval', async () => {
    const root = fixtureRoot();
    const clone = createRepository(root, 'clone');
    const { ledger } = createLedger(root, 'state');
    const pool = poolFor(ledger, [clone]);
    const attempt = createAttempt(ledger, 'cli-missing-before-approval');
    const handle = acquiredHandle(await pool.acquire({ repository: 'example/widget', ...attempt }));
    writeFileSync(path.join(clone, 'temporary.txt'), 'unsafe');
    await pool.verifyBeforeSpawn(handle);
    unlinkSync(path.join(clone, 'temporary.txt'));
    unlinkSync(path.join(handle.baseline.gitCommonDirectory, WORKSPACE_SENTINEL_NAME));

    const result = await pool.acknowledge(clone);
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') throw new Error('Expected acknowledgment refusal');
    expect(result.reason).toMatch(/sentinel verification failed/i);
    expect(ledger.getLease(clone)?.state).toBe('Quarantined');
  });

  it('consumes a checked action before releasing an exact now-safe quarantine', async () => {
    const root = fixtureRoot();
    const clone = createRepository(root, 'clone');
    const { ledger } = createLedger(root, 'state');
    const pool = poolFor(ledger, [clone]);
    const attempt = createAttempt(ledger, 'checked-safe');
    const acquired = await pool.acquire({ repository: 'example/widget', ...attempt });
    const handle = acquiredHandle(acquired);
    writeFileSync(path.join(clone, 'temporary.txt'), 'unsafe');
    await pool.verifyBeforeSpawn(handle);
    unlinkSync(path.join(clone, 'temporary.txt'));
    const claim = claimWorkspaceAction(ledger, handle);

    await expect(pool.acknowledgeClaim(claim)).resolves.toMatchObject({
      kind: 'released',
      lease: { state: 'Released' },
    });
    expect(
      ledger.listFollowUps(attempt.jobId).every(({ completedAt }) => completedAt !== null),
    ).toBe(true);
    expect(() => statSync(path.join(clone, '.git', WORKSPACE_SENTINEL_NAME))).toThrow();
  });

  it('restores the captured branch after approval and preserves the reviewed task branch', async () => {
    const root = fixtureRoot();
    const clone = createRepository(root, 'clone');
    const { ledger } = createLedger(root, 'state');
    const pool = poolFor(ledger, [clone]);
    const attempt = createAttempt(ledger, 'checked-current-branch');
    const acquired = await pool.acquire({ repository: 'example/widget', ...attempt });
    const handle = acquiredHandle(acquired);
    git(clone, ['checkout', '-b', 'human-reviewed']);
    writeFileSync(path.join(clone, 'reviewed.txt'), 'reviewed\n');
    git(clone, ['add', 'reviewed.txt']);
    git(clone, ['commit', '-m', 'reviewed work']);
    await pool.reconcileDisposition(handle);
    const reviewedHead = git(clone, ['rev-parse', 'HEAD']);
    const claim = claimWorkspaceAction(ledger, handle);

    await expect(pool.acknowledgeClaim(claim)).resolves.toMatchObject({ kind: 'released' });
    expect(git(clone, ['branch', '--show-current'])).toBe('main');
    expect(git(clone, ['rev-parse', 'human-reviewed'])).toBe(reviewedHead);
    expect(() => statSync(path.join(clone, 'reviewed.txt'))).toThrow();
  });

  it('restores a clean workspace after filesystem device IDs change', async () => {
    const root = fixtureRoot();
    const clone = createRepository(root, 'clone');
    const { database, ledger } = createLedger(root, 'state');
    const pool = poolFor(ledger, [clone]);
    const attempt = createAttempt(ledger, 'checked-device-drift');
    const handle = acquiredHandle(await pool.acquire({ repository: 'example/widget', ...attempt }));
    git(clone, ['checkout', '-b', 'human-reviewed']);
    await pool.reconcileDisposition(handle);

    const lease = ledger.getLease(clone);
    if (!lease?.metadata) throw new Error('Expected persisted workspace lease metadata');
    const metadata = structuredClone(lease.metadata);
    const persisted = parseWorkspaceLeaseHandle(metadata, lease);
    if (!persisted) throw new Error('Expected persisted workspace lease handle');
    persisted.baseline.workspaceIdentity.device = 'previous-device';
    persisted.baseline.gitDirectoryIdentity.device = 'previous-device';
    persisted.baseline.gitCommonDirectoryIdentity.device = 'previous-device';
    database.raw
      .prepare('UPDATE workspace_leases SET lease_metadata_json = ? WHERE canonical_workspace = ?')
      .run(JSON.stringify(metadata), clone);

    const claim = claimWorkspaceAction(ledger, handle);
    await expect(pool.acknowledgeClaim(claim)).resolves.toMatchObject({ kind: 'released' });
    expect(git(clone, ['branch', '--show-current'])).toBe('main');
  });

  it('restores the captured non-main branch without running checkout hooks', async () => {
    const root = fixtureRoot();
    const clone = createRepository(root, 'clone');
    git(clone, ['branch', '-m', 'develop']);
    const hook = path.join(clone, '.git', 'hooks', 'post-checkout');
    writeFileSync(hook, '#!/bin/sh\nexit 97\n');
    chmodSync(hook, 0o755);
    const { ledger } = createLedger(root, 'state');
    const pool = poolFor(ledger, [clone]);
    const attempt = createAttempt(ledger, 'checked-develop-branch');
    const handle = acquiredHandle(await pool.acquire({ repository: 'example/widget', ...attempt }));
    git(clone, ['-c', 'core.hooksPath=/dev/null', 'checkout', '-b', 'human-reviewed']);
    await pool.reconcileDisposition(handle);
    const claim = claimWorkspaceAction(ledger, handle);

    await expect(pool.acknowledgeClaim(claim)).resolves.toMatchObject({ kind: 'released' });
    expect(git(clone, ['branch', '--show-current'])).toBe('develop');
  });

  it('keeps a clean detached commit quarantined during acknowledgment', async () => {
    const root = fixtureRoot();
    const clone = createRepository(root, 'clone');
    const { ledger } = createLedger(root, 'state');
    const pool = poolFor(ledger, [clone]);
    const attempt = createAttempt(ledger, 'checked-detached-head');
    const handle = acquiredHandle(await pool.acquire({ repository: 'example/widget', ...attempt }));
    git(clone, ['checkout', '--detach']);
    writeFileSync(path.join(clone, 'detached.txt'), 'preserve this commit\n');
    git(clone, ['add', 'detached.txt']);
    git(clone, ['commit', '-m', 'detached work']);
    const detachedHead = git(clone, ['rev-parse', 'HEAD']);
    await pool.reconcileDisposition(handle);
    const claim = claimWorkspaceAction(ledger, handle);

    await expect(pool.acknowledgeClaim(claim)).resolves.toMatchObject({ kind: 'refused' });
    expect(git(clone, ['branch', '--show-current'])).toBe('');
    expect(git(clone, ['rev-parse', 'HEAD'])).toBe(detachedHead);
    expect(ledger.getLease(clone)?.state).toBe('Quarantined');
  });

  it('keeps quarantine when the captured branch ref moved', async () => {
    const root = fixtureRoot();
    const clone = createRepository(root, 'clone');
    const { ledger } = createLedger(root, 'state');
    const pool = poolFor(ledger, [clone]);
    const attempt = createAttempt(ledger, 'checked-moved-baseline');
    const handle = acquiredHandle(await pool.acquire({ repository: 'example/widget', ...attempt }));
    git(clone, ['checkout', '-b', 'human-reviewed']);
    writeFileSync(path.join(clone, 'reviewed.txt'), 'reviewed\n');
    git(clone, ['add', 'reviewed.txt']);
    git(clone, ['commit', '-m', 'reviewed work']);
    git(clone, ['branch', '-f', 'main', 'HEAD']);
    await pool.reconcileDisposition(handle);
    const claim = claimWorkspaceAction(ledger, handle);

    const outcome = await pool.acknowledgeClaim(claim);
    expect(outcome).toMatchObject({ kind: 'refused' });
    expect(git(clone, ['branch', '--show-current'])).toBe('human-reviewed');
    expect(ledger.getLease(clone)?.state).toBe('Quarantined');
    expect(ledger.listFollowUps(attempt.jobId).at(-1)?.text).toMatch(/captured commit/i);
  });

  it('preserves an ignored local file that conflicts with the captured branch', async () => {
    const root = fixtureRoot();
    const clone = createRepository(root, 'clone');
    writeFileSync(path.join(clone, 'generated.txt'), 'captured\n');
    git(clone, ['add', 'generated.txt']);
    git(clone, ['commit', '-m', 'track generated file']);
    const { ledger } = createLedger(root, 'state');
    const pool = poolFor(ledger, [clone]);
    const attempt = createAttempt(ledger, 'ignored-collision');
    const handle = acquiredHandle(await pool.acquire({ repository: 'example/widget', ...attempt }));
    git(clone, ['checkout', '-b', 'human-reviewed']);
    git(clone, ['rm', 'generated.txt']);
    writeFileSync(path.join(clone, '.gitignore'), 'generated.txt\n');
    git(clone, ['add', '.gitignore']);
    git(clone, ['commit', '-m', 'ignore generated file']);
    writeFileSync(path.join(clone, 'generated.txt'), 'local-only\n');
    expect(git(clone, ['status', '--porcelain'])).toBe('');
    await pool.reconcileDisposition(handle);
    const claim = claimWorkspaceAction(ledger, handle);

    await expect(pool.acknowledgeClaim(claim)).resolves.toMatchObject({ kind: 'refused' });
    expect(git(clone, ['branch', '--show-current'])).toBe('human-reviewed');
    expect(readFileSync(path.join(clone, 'generated.txt'), 'utf8')).toBe('local-only\n');
    expect(ledger.getLease(clone)?.state).toBe('Quarantined');
  });

  it('turns baseline-ref verification errors into a retryable refusal', async () => {
    const root = fixtureRoot();
    const clone = createRepository(root, 'clone');
    const { ledger } = createLedger(root, 'state');
    const delegate = new NodeGitRunner();
    const gitRunner: GitRunner = {
      run: (cwd, args, options) => {
        if (args[0] === 'rev-parse' && args.includes('--verify')) {
          return Promise.reject(new GitCommandError('fixture verification failure', args));
        }
        return delegate.run(cwd, args, options);
      },
    };
    const pool = new WorkspacePool({
      repositories: [{ repository: 'example/widget', clones: [clone] }],
      ledger,
      gitRunner,
    });
    const attempt = createAttempt(ledger, 'verification-error');
    const handle = acquiredHandle(await pool.acquire({ repository: 'example/widget', ...attempt }));
    git(clone, ['checkout', '-b', 'human-reviewed']);
    await pool.reconcileDisposition(handle);
    const claim = claimWorkspaceAction(ledger, handle);

    const outcome = await pool.acknowledgeClaim(claim);
    expect(outcome.kind).toBe('refused');
    if (outcome.kind !== 'refused') throw new Error('Expected acknowledgment refusal');
    expect(outcome.reason).toMatch(/could not be verified/i);
    expect(ledger.getLease(clone)?.state).toBe('Quarantined');
    expect(ledger.listFollowUps(attempt.jobId).at(-1)?.completedAt).toBeNull();
    expect(statSync(path.join(clone, '.git', WORKSPACE_SENTINEL_NAME)).isFile()).toBe(true);
  });

  it('releases a clean workspace after remote metadata changes', async () => {
    const root = fixtureRoot();
    const clone = createRepository(root, 'clone');
    const { ledger } = createLedger(root, 'state');
    const pool = poolFor(ledger, [clone]);
    const attempt = createAttempt(ledger, 'same-branch-remote-drift');
    const handle = acquiredHandle(await pool.acquire({ repository: 'example/widget', ...attempt }));
    git(clone, ['remote', 'add', 'upstream', 'https://github.com/example/widget.git']);
    await pool.reconcileDisposition(handle);
    const claim = claimWorkspaceAction(ledger, handle);

    await expect(pool.acknowledgeClaim(claim)).resolves.toMatchObject({ kind: 'released' });
  });

  it('acknowledges a canonical lease through its configured symlink path', async () => {
    const root = fixtureRoot();
    const clone = createRepository(root, 'clone');
    const configuredAlias = path.join(root, 'configured-clone');
    symlinkSync(clone, configuredAlias, 'dir');
    const { ledger } = createLedger(root, 'state');
    const pool = poolFor(ledger, [configuredAlias]);
    const attempt = createAttempt(ledger, 'configured-symlink');
    const handle = acquiredHandle(await pool.acquire({ repository: 'example/widget', ...attempt }));
    git(clone, ['checkout', '-b', 'human-reviewed']);
    await pool.reconcileDisposition(handle);
    const claim = claimWorkspaceAction(ledger, handle);

    await expect(pool.acknowledgeClaim(claim)).resolves.toMatchObject({
      kind: 'released',
      lease: { state: 'Released' },
    });
  });

  it('consumes an unsafe check and requires a fresh unchecked successor', async () => {
    const root = fixtureRoot();
    const clone = createRepository(root, 'clone');
    const { ledger } = createLedger(root, 'state');
    const pool = poolFor(ledger, [clone]);
    const attempt = createAttempt(ledger, 'checked-unsafe');
    const acquired = await pool.acquire({ repository: 'example/widget', ...attempt });
    const handle = acquiredHandle(acquired);
    writeFileSync(path.join(clone, 'manual.txt'), 'keep');
    await pool.verifyBeforeSpawn(handle);
    const claim = claimWorkspaceAction(ledger, handle);

    await expect(pool.acknowledgeClaim(claim)).resolves.toMatchObject({ kind: 'refused' });
    expect(ledger.getLease(clone)?.state).toBe('Quarantined');
    const followUps = ledger.listFollowUps(attempt.jobId);
    expect(followUps[0]?.completedAt).not.toBeNull();
    expect(followUps[1]?.completedAt).toBeNull();
    expect(followUps[1]?.text).toMatch(/unsafe/i);
    expect(statSync(path.join(clone, '.git', WORKSPACE_SENTINEL_NAME)).isFile()).toBe(true);

    unlinkSync(path.join(clone, 'manual.txt'));
    await expect(pool.recoverAcknowledgment(clone)).resolves.toMatchObject({ kind: 'refused' });
    expect(ledger.getLease(clone)?.state).toBe('Quarantined');
    expect(ledger.listFollowUps(attempt.jobId)).toHaveLength(2);
  });

  it('fails closed on restart before inspection but completes an exact post-unlink release', async () => {
    const root = fixtureRoot();
    const cloneA = createRepository(root, 'clone-a');
    const cloneB = createRepository(root, 'clone-b');
    const { ledger } = createLedger(root, 'state');
    const pool = poolFor(ledger, [cloneA, cloneB]);

    const beforeInspectionAttempt = createAttempt(ledger, 'crash-before-inspection');
    const first = acquiredHandle(
      await pool.acquire({ repository: 'example/widget', ...beforeInspectionAttempt }),
    );
    writeFileSync(path.join(cloneA, 'dirty.txt'), 'unsafe');
    await pool.verifyBeforeSpawn(first);
    const beforeInspection = claimWorkspaceAction(ledger, first);
    await expect(pool.recoverAcknowledgment(cloneA)).resolves.toMatchObject({ kind: 'refused' });
    expect(ledger.getLease(cloneA)?.state).toBe('Quarantined');
    expect(
      ledger
        .listFollowUps(beforeInspectionAttempt.jobId)
        .find(({ eventKey }) => eventKey === beforeInspection.successor.eventKey)?.completedAt,
    ).toBeNull();
    expect(statSync(path.join(cloneA, '.git', WORKSPACE_SENTINEL_NAME)).isFile()).toBe(true);

    const afterUnlinkAttempt = createAttempt(ledger, 'crash-after-unlink');
    const second = acquiredHandle(
      await pool.acquire({ repository: 'example/widget', ...afterUnlinkAttempt }),
    );
    writeFileSync(path.join(cloneB, 'dirty.txt'), 'unsafe');
    await pool.verifyBeforeSpawn(second);
    unlinkSync(path.join(cloneB, 'dirty.txt'));
    const afterUnlink = claimWorkspaceAction(ledger, second);
    ledger.markWorkspaceAcknowledgmentInspected(afterUnlink.disposition);
    ledger.markWorkspaceAcknowledgmentRestored(afterUnlink.disposition);
    unlinkSync(path.join(cloneB, '.git', WORKSPACE_SENTINEL_NAME));
    writeFileSync(path.join(cloneB, 'after-unlink.txt'), 'preserve');

    await expect(pool.recoverAcknowledgment(cloneB)).resolves.toMatchObject({
      kind: 'released',
      lease: { state: 'Released' },
    });
    expect(readFileSync(path.join(cloneB, 'after-unlink.txt'), 'utf8')).toBe('preserve');
  });

  it('refuses a missing sentinel before restoration is durably complete', async () => {
    const root = fixtureRoot();
    const clone = createRepository(root, 'clone');
    const { ledger } = createLedger(root, 'state');
    const pool = poolFor(ledger, [clone]);
    const attempt = createAttempt(ledger, 'missing-before-restoration');
    const handle = acquiredHandle(await pool.acquire({ repository: 'example/widget', ...attempt }));
    git(clone, ['checkout', '-b', 'human-reviewed']);
    await pool.reconcileDisposition(handle);
    const claim = claimWorkspaceAction(ledger, handle);
    ledger.markWorkspaceAcknowledgmentInspected(claim.disposition);
    unlinkSync(path.join(clone, '.git', WORKSPACE_SENTINEL_NAME));

    await expect(pool.recoverAcknowledgment(clone)).resolves.toMatchObject({ kind: 'refused' });
    expect(git(clone, ['branch', '--show-current'])).toBe('human-reviewed');
    expect(ledger.getLease(clone)?.state).toBe('Quarantined');
  });

  it('refuses an inspected acknowledgment when a present sentinel belongs to another lease', async () => {
    const root = fixtureRoot();
    const clone = createRepository(root, 'clone');
    const { ledger } = createLedger(root, 'state');
    const pool = poolFor(ledger, [clone]);
    const attempt = createAttempt(ledger, 'mismatched-sentinel');
    const handle = acquiredHandle(await pool.acquire({ repository: 'example/widget', ...attempt }));
    git(clone, ['checkout', '-b', 'human-reviewed']);
    await pool.reconcileDisposition(handle);
    const claim = claimWorkspaceAction(ledger, handle);
    ledger.markWorkspaceAcknowledgmentInspected(claim.disposition);
    const sentinelPath = path.join(clone, '.git', WORKSPACE_SENTINEL_NAME);
    const sentinel = JSON.parse(readFileSync(sentinelPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(
      sentinelPath,
      `${JSON.stringify({ ...sentinel, attemptId: 'another-attempt' })}\n`,
    );

    await expect(pool.recoverAcknowledgment(clone)).resolves.toMatchObject({ kind: 'refused' });
    expect(ledger.getLease(clone)?.state).toBe('Quarantined');
    expect(statSync(sentinelPath).isFile()).toBe(true);
  });

  it('coordinates two independent state databases and never lets the wrong owner release', async () => {
    const root = fixtureRoot();
    const clone = createRepository(root, 'clone');
    const firstLedger = createLedger(root, 'state-a').ledger;
    const secondLedger = createLedger(root, 'state-b').ledger;
    const firstAttempt = createAttempt(firstLedger, 'first-state');
    const secondAttempt = createAttempt(secondLedger, 'second-state');
    const firstManager = new WorkspaceSentinelManager({ ownerNonce: 'first-owner' });
    const secondManager = new WorkspaceSentinelManager({ ownerNonce: 'second-owner' });
    const firstPool = poolFor(firstLedger, [clone], undefined, firstManager);
    const secondPool = poolFor(secondLedger, [clone], undefined, secondManager);

    const [first, second] = await Promise.all([
      firstPool.acquire({ repository: 'example/widget', ...firstAttempt }),
      secondPool.acquire({ repository: 'example/widget', ...secondAttempt }),
    ]);
    const winners = [first, second].filter((result) => result.kind === 'acquired');
    const losers = [first, second].filter((result) => result.kind === 'capacity-unavailable');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const winner = acquiredHandle(winners[0]);
    const losingPool = winner.sentinel.ownerNonce === 'first-owner' ? secondPool : firstPool;
    await expect(losingPool.potentialCapacity('example/widget')).resolves.toBe(
      'capacity-unavailable',
    );
    const wrongManager =
      winner.sentinel.ownerNonce === 'first-owner' ? secondManager : firstManager;
    const wrongRelease = await wrongManager.releaseOwned(
      winner.baseline.gitCommonDirectory,
      winner.sentinel,
    );
    expect(wrongRelease.valid).toBe(false);
    expect(statSync(path.join(clone, '.git', WORKSPACE_SENTINEL_NAME)).isFile()).toBe(true);
  });

  it('recovers a dead or PID-reused sentinel but never steals a live one', async () => {
    const root = fixtureRoot();
    const clone = createRepository(root, 'clone');
    const identities = new FakeProcessRegistry();
    identities.register(700, 'old-birth');
    identities.register(800, 'new-birth');
    const firstLedger = createLedger(root, 'state-a').ledger;
    const secondLedger = createLedger(root, 'state-b').ledger;
    const firstPool = poolFor(firstLedger, [clone], {
      ownerNonce: 'old-owner',
      processIdentity: identities.provider(700),
    });
    const secondPool = poolFor(secondLedger, [clone], {
      ownerNonce: 'new-owner',
      processIdentity: identities.provider(800),
    });
    const firstAttempt = createAttempt(firstLedger, 'old-job');
    const secondAttempt = createAttempt(secondLedger, 'new-job');
    expect(
      await firstPool.acquire({ repository: 'example/widget', ...firstAttempt }),
    ).toMatchObject({ kind: 'acquired' });
    expect(
      await secondPool.acquire({ repository: 'example/widget', ...secondAttempt }),
    ).toMatchObject({ kind: 'capacity-unavailable' });

    identities.register(700, 'reused-birth');
    const recovered = await secondPool.acquire({ repository: 'example/widget', ...secondAttempt });
    expect(recovered.kind).toBe('acquired');
    expect(recovered.inspected[0]?.message).toMatch(/stale-sentinel recovery/i);
  });
});

function fixtureRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'spool-workspace-'));
  roots.push(root);
  return root;
}

function createRepository(root: string, name: string, repository = 'example/widget'): string {
  const clone = path.join(root, name);
  mkdirSync(clone);
  createRepositoryAt(clone, repository);
  return realpathSync(clone);
}

function createRepositoryAt(clone: string, repository = 'example/widget'): void {
  git(clone, ['init', '-b', 'main']);
  git(clone, ['config', 'user.name', 'spool Test']);
  git(clone, ['config', 'user.email', 'spool@example.test']);
  writeFileSync(path.join(clone, 'tracked.txt'), 'baseline\n');
  git(clone, ['add', 'tracked.txt']);
  git(clone, ['commit', '-m', 'baseline']);
  git(clone, ['remote', 'add', 'origin', `git@github.com:${repository}.git`]);
}

function createLedger(
  root: string,
  name: string,
): { database: LedgerDatabase; ledger: LedgerRepository } {
  const database = openLedgerDatabase(path.join(root, name));
  databases.push(database);
  return { database, ledger: new LedgerRepository(database) };
}

function createAttempt(
  ledger: LedgerRepository,
  marker: string,
): { jobId: string; attemptId: string } {
  const job = ledger.claimJob({
    sourceMarker: marker,
    sourcePath: '/vault/week.md',
    provider: 'fake',
    directive: 'review',
    context: 'https://github.com/example/widget/pull/1',
  });
  const attempt = ledger.prepareAttempt(job.id, `/logs/${marker}.log`);
  return { jobId: job.id, attemptId: attempt.id };
}

function claimWorkspaceAction(
  ledger: LedgerRepository,
  handle: WorkspaceLeaseHandle,
): ClaimedWorkspaceAcknowledgment {
  const eventKey = workspaceAcknowledgmentEventKey(handle.ledgerLease.attemptId, 0);
  const successorEventKey = workspaceAcknowledgmentEventKey(handle.ledgerLease.attemptId, 1);
  ledger.recordFollowUp(handle.ledgerLease.jobId, eventKey, 'Inspect quarantined workspace');
  const claim = ledger.claimWorkspaceAcknowledgment({
    jobId: handle.ledgerLease.jobId,
    attemptId: handle.ledgerLease.attemptId,
    canonicalWorkspace: handle.canonicalWorkspace,
    eventKey,
    successorEventKey,
    successorText: 'Inspect quarantined workspace again',
  });
  if (claim.kind !== 'claimed') throw new Error(`Expected claim: ${claim.reason}`);
  return claim;
}

function poolFor(
  ledger: LedgerRepository,
  clones: string[],
  sentinelOptions?: ConstructorParameters<typeof WorkspaceSentinelManager>[0],
  sentinels?: WorkspaceSentinelManager,
): WorkspacePool {
  return new WorkspacePool({
    repositories: [{ repository: 'example/widget', clones }],
    ledger,
    ...(sentinels ? { sentinels } : sentinelOptions ? { sentinelOptions } : {}),
  });
}

function acquiredHandle(
  result: Awaited<ReturnType<WorkspacePool['acquire']>> | undefined,
): WorkspaceLeaseHandle {
  if (!result || result.kind !== 'acquired') throw new Error('Expected an acquired workspace');
  return result.handle;
}

function makeDirty(clone: string, kind: 'modified' | 'staged' | 'untracked' | 'conflicted'): void {
  if (kind === 'modified') {
    writeFileSync(path.join(clone, 'tracked.txt'), 'modified\n');
  } else if (kind === 'staged') {
    writeFileSync(path.join(clone, 'tracked.txt'), 'staged\n');
    git(clone, ['add', 'tracked.txt']);
  } else if (kind === 'untracked') {
    writeFileSync(path.join(clone, 'untracked.txt'), 'untracked\n');
  } else {
    git(clone, ['checkout', '-b', 'left']);
    writeFileSync(path.join(clone, 'tracked.txt'), 'left\n');
    git(clone, ['add', 'tracked.txt']);
    git(clone, ['commit', '-m', 'left']);
    git(clone, ['checkout', 'main']);
    git(clone, ['checkout', '-b', 'right']);
    writeFileSync(path.join(clone, 'tracked.txt'), 'right\n');
    git(clone, ['add', 'tracked.txt']);
    git(clone, ['commit', '-m', 'right']);
    try {
      git(clone, ['merge', 'left']);
    } catch {
      // The conflict is the fixture state under test.
    }
  }
}

function repositorySnapshot(clone: string): {
  head: string;
  statusHash: string;
  trackedHash: string;
} {
  return {
    head: git(clone, ['rev-parse', 'HEAD']),
    statusHash: createHash('sha256')
      .update(gitBuffer(clone, ['status', '--porcelain=v2', '-z']))
      .digest('hex'),
    trackedHash: createHash('sha256')
      .update(readFileSync(path.join(clone, 'tracked.txt')))
      .digest('hex'),
  };
}

function git(cwd: string, args: string[]): string {
  return gitBuffer(cwd, args).toString('utf8').trim();
}

function gitBuffer(cwd: string, args: string[]): Buffer {
  return execFileSync('git', args, {
    cwd,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

class FakeProcessRegistry {
  readonly #births = new Map<number, string>();

  register(pid: number, birth: string): void {
    this.#births.set(pid, birth);
  }

  unregister(pid: number): void {
    this.#births.delete(pid);
  }

  provider(pid: number): ProcessIdentityProvider {
    return {
      current: (): Promise<ProcessBirthIdentity> => {
        const startIdentity = this.#births.get(pid);
        if (!startIdentity) throw new Error(`Missing fake process ${pid}`);
        return Promise.resolve({ pid, startIdentity });
      },
      compare: (candidatePid: number, startIdentity: string): Promise<ProcessMatch> => {
        const current = this.#births.get(candidatePid);
        if (!current) return Promise.resolve('not-running');
        return Promise.resolve(current === startIdentity ? 'match' : 'different');
      },
    };
  }
}
