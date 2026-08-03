import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { spoolArgv } from '../cli/output.js';
import { samePath } from '../config/paths.js';
import type { MDSpoolConfig } from '../config/schema.js';
import { isTerminalJobState, type Attempt, type Job } from '../domain/job.js';
import {
  currentProcessStartIdentity,
  DaemonLock,
  type DaemonOwnershipIdentity,
} from '../ledger/daemon-lock.js';
import type { LedgerDatabase } from '../ledger/database.js';
import type { OutboxRepository } from '../ledger/outbox.js';
import type { LedgerRepository } from '../ledger/repositories.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { ProviderAdapter, ProviderEvidence, ProviderRunResult } from '../providers/types.js';
import { fireAndForgetOperational } from '../logging/events.js';
import type { OperationalLogStore } from '../logging/store.js';
import {
  isWorkspaceAcknowledgmentEventKey,
  nextWorkspaceAcknowledgmentEventKey,
  parseWorkspaceCliAcknowledgmentRequest,
  parseWorkspaceAcknowledgmentDisposition,
  workspaceAcknowledgmentText,
  type WorkspaceAcknowledgmentIdentity,
} from '../workspaces/acknowledgment.js';
import { WorkspacePool, type WorkspaceAcknowledgement } from '../workspaces/pool.js';
import { parseWorkspaceLeaseHandle } from '../workspaces/persisted-lease.js';
import { JobDispatcher, type DispatchResult } from './dispatcher.js';
import { AttemptObserver } from './observer.js';
import { NoteProjector, providerDirectives } from './projector.js';
import { MarkdownNoteScanner, type MarkdownNoteScanResult } from './scanner.js';

export type ProviderObservationRunner = (
  adapter: ProviderAdapter,
  sessionId: string,
) => Promise<readonly ProviderEvidence[]>;

export interface ReconciliationPassOptions {
  awaitLaunched?: boolean;
}

export interface ReconciliationPassResult {
  scan: MarkdownNoteScanResult;
  claimedJobIds: string[];
  dispatches: DispatchResult[];
  projected: number;
  blockedProjections: number;
  diagnostics: string[];
}

type ReconcilerOperationalLog = Pick<
  OperationalLogStore,
  | 'activate'
  | 'runtimeStarted'
  | 'runtimeStopped'
  | 'reconciliationCompleted'
  | 'reconciliationFailed'
  | 'jobClaimed'
  | 'dispatchWaiting'
  | 'workspaceAcquired'
  | 'workspaceReleased'
  | 'workspaceQuarantined'
  | 'providerLaunched'
  | 'providerTerminal'
  | 'close'
>;

export class Reconciler {
  readonly #config: MDSpoolConfig;
  readonly #ledger: LedgerRepository;
  readonly #outbox: OutboxRepository;
  readonly #providers: ProviderRegistry;
  readonly #workspaces: WorkspacePool;
  readonly #scanner: MarkdownNoteScanner;
  readonly #projector: NoteProjector;
  readonly #observer: AttemptObserver;
  readonly #dispatcher: JobDispatcher;
  readonly #daemonLock: DaemonLock;
  readonly #owner: DaemonOwnershipIdentity;
  readonly #observeProvider: ProviderObservationRunner;
  readonly #operationalLog: ReconcilerOperationalLog | null;
  readonly #now: () => Date;
  #ownsLock = false;
  #activationAttempted = false;
  #runtimeStarted = false;
  #lastQuietReconciliationAt: number | null = null;
  #shutdownPromise: Promise<void> | null = null;

  constructor(options: {
    config: MDSpoolConfig;
    database: LedgerDatabase;
    ledger: LedgerRepository;
    outbox: OutboxRepository;
    providers: ProviderRegistry;
    workspaces?: WorkspacePool;
    scanner?: MarkdownNoteScanner;
    projector?: NoteProjector;
    observer?: AttemptObserver;
    dispatcher?: JobDispatcher;
    daemonLock?: DaemonLock;
    owner?: DaemonOwnershipIdentity;
    observeProvider?: ProviderObservationRunner;
    operationalLog?: ReconcilerOperationalLog;
    now?: () => Date;
  }) {
    this.#config = options.config;
    this.#ledger = options.ledger;
    this.#outbox = options.outbox;
    this.#providers = options.providers;
    this.#workspaces =
      options.workspaces ??
      new WorkspacePool({ repositories: options.config.repositories, ledger: options.ledger });
    this.#scanner =
      options.scanner ??
      new MarkdownNoteScanner({
        vaults: options.config.vaults,
        providers: providerDirectives(options.config),
      });
    this.#projector =
      options.projector ??
      new NoteProjector({
        config: options.config,
        ledger: options.ledger,
        outbox: options.outbox,
        ...(options.now ? { now: options.now } : {}),
      });
    this.#observer =
      options.observer ??
      new AttemptObserver({
        config: options.config,
        ledger: options.ledger,
        projector: this.#projector,
        ...(options.operationalLog ? { operationalLog: options.operationalLog } : {}),
        ...(options.now ? { now: options.now } : {}),
      });
    this.#dispatcher =
      options.dispatcher ??
      new JobDispatcher({
        config: options.config,
        ledger: options.ledger,
        providers: options.providers,
        workspaces: this.#workspaces,
        observer: this.#observer,
        projector: this.#projector,
        ...(options.operationalLog ? { operationalLog: options.operationalLog } : {}),
      });
    this.#daemonLock = options.daemonLock ?? new DaemonLock(options.database);
    this.#owner = options.owner ?? {
      nonce: randomUUID(),
      pid: process.pid,
      processStartIdentity: currentProcessStartIdentity(),
    };
    this.#observeProvider = options.observeProvider ?? (() => Promise.resolve([]));
    this.#operationalLog = options.operationalLog ?? null;
    this.#now = options.now ?? (() => new Date());
  }

  async runPass(options: ReconciliationPassOptions = {}): Promise<ReconciliationPassResult> {
    this.#ensureOwnership();
    await this.#activateOperationalLog();
    try {
      return await this.#runOwnedPass(options);
    } catch (error) {
      fireAndForgetOperational(() => this.#operationalLog?.reconciliationFailed());
      throw error;
    }
  }

  async #runOwnedPass(options: ReconciliationPassOptions): Promise<ReconciliationPassResult> {
    await this.#recoverCrashBoundaries();
    const ownedMarkers = new Set(this.#ledger.listJobs().map((job) => job.sourceMarker));
    const scan = await this.#scanner.scan(ownedMarkers);
    const claimedJobIds: string[] = [];
    for (const candidate of scan.claimable) {
      const taskId = candidate.directive.taskId;
      if (!taskId) continue;
      const existing = this.#ledger.getJobByMarker(taskId);
      if (existing) {
        const repository = candidate.directive.context.repository?.repository ?? null;
        if (
          existing.state === 'Queued' &&
          (existing.directive !== candidate.directive.directiveText ||
            existing.context !== candidate.context ||
            existing.repository !== repository)
        ) {
          this.#ledger.refreshQueuedJobContext(existing.id, {
            directive: candidate.directive.directiveText,
            context: candidate.context,
            repository,
          });
        }
        continue;
      }
      const job = this.#ledger.claimJob({
        sourceMarker: taskId,
        sourcePath: candidate.notePath,
        provider: candidate.directive.provider,
        directive: candidate.directive.directiveText,
        context: candidate.context,
        repository: candidate.directive.context.repository?.repository ?? null,
      });
      claimedJobIds.push(job.id);
      fireAndForgetOperational(() => this.#operationalLog?.jobClaimed(job.id, job.provider));
    }

    await this.#reconcileWorkspaceActions(scan);
    this.#reassertWorkspaceAcknowledgmentProjections();

    // Job claim, projection, and outbox writes intentionally use independently idempotent
    // repositories. Reassert every missing initial receipt so a crash between those commits
    // converges before dispatch instead of stranding a durable queued job.
    for (const job of this.#ledger.listJobs().filter((item) => item.state === 'Queued')) {
      const semanticKey = `initial-receipt:${job.id}`;
      if (this.#ledger.getProjection(semanticKey) && this.#outbox.getBySemanticKey(semanticKey)) {
        continue;
      }
      this.#projector.enqueueSource(job, semanticKey, {
        kind: 'receipt',
        taskId: job.sourceMarker,
        receipt: {
          taskId: job.sourceMarker,
          sessionId: null,
          status: 'Queued',
          updatedAt: job.createdAt,
          context: job.context,
          cancelCommand: spoolArgv(this.#config, 'cancel', job.sourceMarker),
        },
      });
    }

    let projected = 0;
    let blockedProjections = 0;
    const projectionErrors: string[] = [];
    const before = await this.#projector.deliver(this.#owner.nonce);
    projected += before.applied;
    blockedProjections += before.blocked;
    projectionErrors.push(...before.errors);

    for (const job of this.#ledger.listJobs()) {
      if (job.cancellationRequested && !isTerminalJobState(job.state)) {
        await this.#dispatcher.cancel(job.id);
      }
      if (
        job.state === 'Cancelled' &&
        !this.#ledger.getProjection(`receipt:${job.id}:queued-cancelled`)
      ) {
        const adapter = this.#providers.get(job.provider);
        if (adapter) {
          this.#observer.enqueueReceipt(job.id, adapter, 'queued-cancelled');
        }
      }
    }

    await this.#observeRecoverableAttempts();
    const observed = await this.#projector.deliver(this.#owner.nonce);
    projected += observed.applied;
    blockedProjections += observed.blocked;
    projectionErrors.push(...observed.errors);

    const dispatches: DispatchResult[] = [];
    const maximumWaves = Math.max(1, this.#ledger.listDispatchableJobs().length + 1);
    for (let wave = 0; wave < maximumWaves; wave += 1) {
      const dispatch = await this.#dispatcher.dispatch();
      dispatches.push(dispatch);
      if (!options.awaitLaunched || dispatch.launched.length === 0) break;
      await this.#waitForIdleWithHeartbeat();
      const afterRuns = await this.#projector.deliver(this.#owner.nonce);
      projected += afterRuns.applied;
      blockedProjections += afterRuns.blocked;
      projectionErrors.push(...afterRuns.errors);
    }
    const after = await this.#projector.deliver(this.#owner.nonce);
    projected += after.applied;
    blockedProjections += after.blocked;
    projectionErrors.push(...after.errors);
    const result = {
      scan,
      claimedJobIds,
      dispatches,
      projected,
      blockedProjections,
      diagnostics: [
        ...scan.diagnostics.map((item) => `${item.notePath}: ${item.message}`),
        ...scan.orphanedMarkers.map(
          (item) => `${item.notePath}: task ${item.taskId}: ${item.reason}`,
        ),
        ...projectionErrors.map((message) => `Note projection failed: ${message}`),
      ],
    };
    this.#recordReconciliation(result);
    return result;
  }

  shutdown(outcome: 'clean' | 'failed' = 'clean'): Promise<void> {
    this.#shutdownPromise ??= this.#performShutdown(outcome);
    return this.#shutdownPromise;
  }

  async #performShutdown(outcome: 'clean' | 'failed'): Promise<void> {
    try {
      await this.#dispatcher.shutdown();
    } finally {
      if (this.#runtimeStarted) {
        await this.#safeOperationalWrite(() => this.#operationalLog?.runtimeStopped(outcome));
      }
      await this.#safeOperationalClose();
      if (this.#ownsLock) {
        this.#daemonLock.release(this.#owner);
        this.#ownsLock = false;
      }
    }
  }

  convergencePassLimit(): number {
    return Math.max(4, this.#ledger.listJobs().length + 3);
  }

  releaseOwnership(): Promise<void> {
    return this.shutdown();
  }

  #ensureOwnership(): void {
    const duration = this.#ownershipDuration();
    if (this.#ownsLock) {
      if (!this.#daemonLock.heartbeat(this.#owner, duration)) {
        throw new Error('MDSpool lost durable daemon ownership; dispatch is disabled');
      }
      return;
    }
    this.#daemonLock.acquire(this.#owner, duration);
    this.#ownsLock = true;
  }

  async #activateOperationalLog(): Promise<void> {
    if (this.#activationAttempted || !this.#operationalLog) return;
    this.#activationAttempted = true;
    const active = await this.#safeOperationalWrite(() => this.#operationalLog?.activate());
    if (!active) return;
    this.#runtimeStarted = true;
    await this.#safeOperationalWrite(() => this.#operationalLog?.runtimeStarted());
  }

  #recordReconciliation(result: ReconciliationPassResult): void {
    const launchedJobs = result.dispatches.reduce(
      (count, dispatch) => count + dispatch.launched.length,
      0,
    );
    const waitingJobIds = new Set<string>();
    for (const dispatch of result.dispatches) {
      for (const jobId of dispatch.queuedForCapacity) waitingJobIds.add(jobId);
      for (const unavailable of dispatch.unavailable) waitingJobIds.add(unavailable.jobId);
    }
    const waitingJobs = waitingJobIds.size;
    const quiet =
      result.claimedJobIds.length === 0 &&
      launchedJobs === 0 &&
      waitingJobs === 0 &&
      result.projected === 0 &&
      result.blockedProjections === 0;
    const now = this.#now().getTime();
    if (
      quiet &&
      this.#lastQuietReconciliationAt !== null &&
      now - this.#lastQuietReconciliationAt < 60 * 60 * 1_000
    ) {
      return;
    }
    this.#lastQuietReconciliationAt = quiet ? now : null;
    fireAndForgetOperational(() =>
      this.#operationalLog?.reconciliationCompleted({
        claimedJobs: result.claimedJobIds.length,
        launchedJobs,
        waitingJobs,
        projected: result.projected,
        blockedProjections: result.blockedProjections,
      }),
    );
  }

  async #safeOperationalWrite(operation: () => Promise<boolean> | undefined): Promise<boolean> {
    try {
      return (await operation()) ?? false;
    } catch {
      return false;
    }
  }

  async #safeOperationalClose(): Promise<void> {
    try {
      await this.#operationalLog?.close();
    } catch {
      // Operational logging never widens the scheduler failure domain.
    }
  }

  async #waitForIdleWithHeartbeat(): Promise<void> {
    let idle = false;
    const completion = this.#dispatcher.waitForIdle().then(() => {
      idle = true;
    });
    const heartbeatEvery = Math.min(
      30_000,
      Math.max(1_000, this.#config.pollIntervalSeconds * 500),
    );
    while (!idle) {
      await Promise.race([
        completion,
        new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, heartbeatEvery);
          timeout.unref();
        }),
      ]);
      if (!idle && !this.#daemonLock.heartbeat(this.#owner, this.#ownershipDuration())) {
        throw new Error('MDSpool lost durable daemon ownership while waiting for a provider');
      }
    }
    await completion;
  }

  #ownershipDuration(): number {
    return Math.max(60_000, this.#config.pollIntervalSeconds * 3_000);
  }

  async #recoverCrashBoundaries(): Promise<void> {
    const leases = this.#ledger.listLeases();
    for (const lease of leases.filter(
      (candidate) =>
        candidate.state === 'Quarantined' &&
        parseWorkspaceCliAcknowledgmentRequest(candidate.disposition)?.phase === 'requested',
    )) {
      const outcome = await this.#workspaces.acknowledge(lease.canonicalWorkspace);
      if (outcome.kind === 'released') {
        fireAndForgetOperational(() =>
          this.#operationalLog?.workspaceReleased(lease.jobId, lease.attemptId),
        );
      } else {
        fireAndForgetOperational(() =>
          this.#operationalLog?.workspaceQuarantined(lease.jobId, lease.attemptId, 'unsafe_state'),
        );
      }
    }
    for (const lease of leases.filter((candidate) => candidate.state === 'ReleasePending')) {
      const acknowledgment = parseWorkspaceAcknowledgmentDisposition(lease.disposition);
      if (acknowledgment) {
        const outcome = await this.#workspaces.recoverAcknowledgment(lease.canonicalWorkspace);
        this.#projectWorkspaceAcknowledgment(acknowledgment, outcome);
        continue;
      }
      const handle = parseWorkspaceLeaseHandle(lease.metadata, lease);
      if (!handle) {
        throw new Error(
          `Release-pending workspace ${lease.canonicalWorkspace} has no durable lease metadata`,
        );
      }
      const disposition = await this.#workspaces.reconcileDisposition(handle);
      this.#dispatcher.reportDisposition(lease.jobId, handle, disposition);
    }
    for (const attempt of this.#ledger.listRecoverableAttempts()) {
      if (attempt.state === 'Prepared') {
        const lease = this.#ledger.listLeases().find((item) => item.attemptId === attempt.id);
        const handle = lease
          ? parseWorkspaceLeaseHandle(attempt.launchMetadata ?? lease.metadata, lease)
          : null;
        if (handle) {
          const disposition = await this.#workspaces.reconcileDisposition(handle);
          this.#dispatcher.reportDisposition(attempt.jobId, handle, disposition);
        }
        this.#ledger.transitionAttempt(attempt.id, 'Terminal');
      } else if (attempt.state === 'Launching') {
        if (attempt.sessionId) {
          this.#ledger.transitionAttempt(attempt.id, 'Running');
          const job = this.#ledger.getJob(attempt.jobId);
          if (job?.state === 'Queued') this.#ledger.transitionJob(job.id, 'Working');
          if (job) {
            fireAndForgetOperational(() =>
              this.#operationalLog?.providerLaunched(job.id, attempt.id, job.provider),
            );
          }
        } else {
          this.#ledger.markAttemptUncertain(
            attempt.id,
            'Restart crossed the provider launch boundary before a durable session identity',
          );
          const job = this.#ledger.getJob(attempt.jobId);
          if (job) {
            fireAndForgetOperational(() =>
              this.#operationalLog?.providerTerminal(job.id, attempt.id, job.provider, 'uncertain'),
            );
          }
        }
      } else if (
        attempt.state === 'Running' &&
        !this.#dispatcher.activeAttemptIds().includes(attempt.id)
      ) {
        this.#ledger.markAttemptUncertain(
          attempt.id,
          'Attached provider process cannot be observed after restart; MDSpool will not relaunch it',
        );
        const job = this.#ledger.getJob(attempt.jobId);
        if (job) {
          fireAndForgetOperational(() =>
            this.#operationalLog?.providerTerminal(job.id, attempt.id, job.provider, 'uncertain'),
          );
        }
      }
    }
  }

  async #reconcileWorkspaceActions(scan: MarkdownNoteScanResult): Promise<void> {
    for (const evidence of scan.workspaceActions ?? []) {
      const job = this.#ledger.getJobByMarker(evidence.taskId);
      if (!job) continue;
      if (!samePath(path.resolve(evidence.notePath), path.resolve(job.sourcePath))) continue;
      const action = this.#ledger
        .listFollowUps(job.id)
        .find(
          (candidate) => candidate.eventKey === evidence.eventKey && candidate.completedAt === null,
        );
      if (!action) continue;
      const attempts = this.#ledger
        .listAttempts(job.id)
        .filter((attempt) => isWorkspaceAcknowledgmentEventKey(attempt.id, evidence.eventKey));
      if (attempts.length !== 1) continue;
      const attempt = attempts[0]!;
      const leases = this.#ledger
        .listLeases()
        .filter((lease) => lease.jobId === job.id && lease.attemptId === attempt.id);
      if (leases.length !== 1) continue;
      const lease = leases[0]!;
      if (lease.state === 'Released') {
        const completed = this.#ledger.completeFollowUp(job.id, evidence.eventKey);
        this.#projectResolvedWorkspaceAction(job, evidence.eventKey, completed.text);
        this.#projectReleasedWorkspaceAcknowledgment(job, evidence.eventKey);
        continue;
      }
      if (lease.state !== 'Quarantined') continue;
      let handle: ReturnType<typeof parseWorkspaceLeaseHandle> = null;
      try {
        handle = parseWorkspaceLeaseHandle(lease.metadata, lease);
      } catch {
        // Invalid durable metadata must not prevent unrelated actions from reconciling.
      }
      const acknowledgmentText = workspaceAcknowledgmentText(handle?.baseline.branch ?? null);
      const successorEventKey = nextWorkspaceAcknowledgmentEventKey(attempt.id, evidence.eventKey);
      const claimed = this.#ledger.claimWorkspaceAcknowledgment({
        jobId: job.id,
        attemptId: attempt.id,
        canonicalWorkspace: lease.canonicalWorkspace,
        eventKey: evidence.eventKey,
        successorEventKey,
        successorText: acknowledgmentText,
      });
      if (claimed.kind !== 'claimed') continue;
      const outcome =
        handle && action.text.startsWith(acknowledgmentText)
          ? await this.#workspaces.acknowledgeClaim(claimed)
          : this.#workspaces.refuseUndisclosedAcknowledgmentClaim(claimed);
      this.#projectWorkspaceAcknowledgment(claimed.disposition, outcome, job);
    }
  }

  #projectWorkspaceAcknowledgment(
    identity: WorkspaceAcknowledgmentIdentity,
    outcome: WorkspaceAcknowledgement,
    knownJob?: Job,
  ): void {
    const job = knownJob ?? this.#ledger.getJob(identity.jobId);
    if (!job) return;
    const followUps = this.#ledger.listFollowUps(job.id);
    const action = followUps.find((candidate) => candidate.eventKey === identity.eventKey);
    if (action) {
      this.#projectResolvedWorkspaceAction(job, identity.eventKey, action.text);
    }
    const adapter = this.#providers.get(job.provider);
    if (outcome.kind === 'released') {
      this.#projectReleasedWorkspaceAcknowledgment(job, identity.eventKey);
      fireAndForgetOperational(() =>
        this.#operationalLog?.workspaceReleased(job.id, identity.attemptId),
      );
      return;
    }
    const successor = followUps.find(
      (candidate) =>
        candidate.eventKey === identity.successorEventKey && candidate.completedAt === null,
    );
    if (successor) {
      this.#projector.enqueueSource(job, `workspace-action:${job.id}:${successor.eventKey}`, {
        kind: 'follow-up',
        taskId: job.sourceMarker,
        eventKey: successor.eventKey,
        checked: false,
        text: successor.text,
      });
    }
    if (adapter) {
      this.#observer.enqueueReceipt(
        job.id,
        adapter,
        `workspace-ack:${identity.eventKey}:refused`,
        undefined,
        outcome.reason,
      );
    }
    fireAndForgetOperational(() =>
      this.#operationalLog?.workspaceQuarantined(job.id, identity.attemptId, 'unsafe_state'),
    );
  }

  #reassertWorkspaceAcknowledgmentProjections(): void {
    for (const lease of this.#ledger.listLeases()) {
      const disposition = parseWorkspaceAcknowledgmentDisposition(lease.disposition);
      if (!disposition) {
        if (lease.state === 'Released') {
          const job = this.#ledger.getJob(lease.jobId);
          if (!job) continue;
          for (const action of this.#ledger
            .listFollowUps(job.id)
            .filter(({ eventKey }) =>
              isWorkspaceAcknowledgmentEventKey(lease.attemptId, eventKey),
            )) {
            const completed =
              action.completedAt === null
                ? this.#ledger.completeFollowUp(job.id, action.eventKey)
                : action;
            this.#projectResolvedWorkspaceAction(job, completed.eventKey, completed.text);
            this.#projectReleasedWorkspaceAcknowledgment(job, completed.eventKey);
          }
        }
        continue;
      }
      if (
        disposition.jobId !== lease.jobId ||
        disposition.attemptId !== lease.attemptId ||
        !samePath(disposition.canonicalWorkspace, lease.canonicalWorkspace)
      ) {
        continue;
      }
      const job = this.#ledger.getJob(disposition.jobId);
      if (!job) continue;
      const followUps = this.#ledger.listFollowUps(job.id);
      const action = followUps.find(({ eventKey }) => eventKey === disposition.eventKey);
      if (action && action.completedAt !== null) {
        this.#projectResolvedWorkspaceAction(job, action.eventKey, action.text);
      }
      if (lease.state === 'Released' && disposition.phase === 'restored-safe') {
        this.#projectReleasedWorkspaceAcknowledgment(job, disposition.eventKey);
        continue;
      }
      if (lease.state !== 'Quarantined' || disposition.phase !== 'refused') continue;
      const successor = followUps.find(
        ({ eventKey, completedAt }) =>
          eventKey === disposition.successorEventKey && completedAt === null,
      );
      if (successor) {
        const semanticKey = `workspace-action:${job.id}:${successor.eventKey}`;
        if (!this.#hasDurableProjection(semanticKey)) {
          this.#projector.enqueueSource(job, semanticKey, {
            kind: 'follow-up',
            taskId: job.sourceMarker,
            eventKey: successor.eventKey,
            checked: false,
            text: successor.text,
          });
        }
      }
      const adapter = this.#providers.get(job.provider);
      const receiptKey = `receipt:${job.id}:workspace-ack:${disposition.eventKey}:refused`;
      if (adapter && !this.#hasDurableProjection(receiptKey)) {
        this.#observer.enqueueReceipt(
          job.id,
          adapter,
          `workspace-ack:${disposition.eventKey}:refused`,
          undefined,
          disposition.reason,
        );
      }
    }
  }

  #projectResolvedWorkspaceAction(job: Job, eventKey: string, text: string): void {
    const semanticKey = `workspace-action-resolved:${job.id}:${eventKey}`;
    if (this.#hasDurableProjection(semanticKey)) return;
    this.#projector.enqueueSource(job, semanticKey, {
      kind: 'resolve-follow-up',
      taskId: job.sourceMarker,
      eventKey,
      checked: true,
      text,
    });
  }

  #projectReleasedWorkspaceAcknowledgment(job: Job, eventKey: string): void {
    const adapter = this.#providers.get(job.provider);
    const semanticKey = `receipt:${job.id}:workspace-ack:${eventKey}:released`;
    if (adapter && !this.#hasDurableProjection(semanticKey)) {
      this.#observer.enqueueReceipt(job.id, adapter, `workspace-ack:${eventKey}:released`);
    }
  }

  #hasDurableProjection(semanticKey: string): boolean {
    return Boolean(
      this.#ledger.getProjection(semanticKey) && this.#outbox.getBySemanticKey(semanticKey),
    );
  }

  async #observeRecoverableAttempts(): Promise<void> {
    for (const attempt of this.#ledger.listRecoverableAttempts()) {
      if (attempt.state !== 'Running' || !attempt.sessionId) continue;
      const job = this.#ledger.getJob(attempt.jobId);
      const adapter = job ? this.#providers.get(job.provider) : null;
      if (!job || !adapter?.capabilities.observe) continue;
      const evidence = await this.#observeProvider(adapter, attempt.sessionId);
      for (const event of evidence) {
        this.#observer.recordEvidence(attempt.id, adapter, event);
        if (event.kind === 'terminal') {
          this.#observer.finalize(attempt.id, adapter, observedTerminalResult(attempt, event));
          const lease = this.#ledger.listLeases().find((item) => item.attemptId === attempt.id);
          const handle = lease
            ? parseWorkspaceLeaseHandle(attempt.launchMetadata ?? lease.metadata, lease)
            : null;
          if (handle) {
            const disposition = await this.#workspaces.reconcileDisposition(handle);
            this.#dispatcher.reportDisposition(attempt.jobId, handle, disposition);
          }
          break;
        }
      }
    }
  }
}

function observedTerminalResult(
  attempt: Attempt,
  event: Extract<ProviderEvidence, { kind: 'terminal' }>,
): ProviderRunResult {
  return {
    launchState: 'started',
    processIdentity:
      attempt.processId === null || attempt.processStartIdentity === null
        ? null
        : { pid: attempt.processId, processStartIdentity: attempt.processStartIdentity },
    terminalState: event.state,
    observation: {
      sessionId: attempt.sessionId,
      state: event.state,
      latestOutput: attempt.latestOutput
        ? {
            text: attempt.latestOutput,
            hash: attempt.observationHash ?? digest(attempt.latestOutput),
          }
        : null,
      terminalProof: { state: event.state, proof: event.proof },
      events: [event],
    },
    exit: { code: 0, signal: null },
    diagnostics: [],
    cancelRequested: false,
    timedOut: false,
    log: { path: attempt.logPath, bytesWritten: 0, truncated: false },
  };
}

function digest(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url').slice(0, 32);
}
