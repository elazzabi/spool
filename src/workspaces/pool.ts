import { realpathSync } from 'node:fs';
import path from 'node:path';

import { normalizeGitHubRepository, type RepositoryConfig } from '../config/schema.js';
import type { JobState, LeaseState, WorkspaceLease } from '../domain/job.js';
import type { LedgerRepository } from '../ledger/repositories.js';
import {
  inspectGitWorkspace,
  restoreWorkspaceBaselineBranch,
  samePath,
  type GitRunner,
  type WorkspaceFingerprint,
  type WorkspaceInspection,
} from './git.js';
import {
  WorkspaceSentinelManager,
  type WorkspaceSentinelManagerOptions,
  type WorkspaceSentinelPayload,
} from './lease.js';
import {
  compareWorkspaceFingerprints,
  quarantineDetail,
  serializeQuarantineDetail,
  type WorkspaceQuarantineDetail,
} from './quarantine.js';
import { parseWorkspaceLeaseHandle, serializeWorkspaceLeaseHandle } from './persisted-lease.js';
import {
  boundWorkspaceAcknowledgmentReason,
  matchesWorkspaceAcknowledgmentIdentity,
  parseWorkspaceCliAcknowledgmentRequest,
  parseWorkspaceCliAcknowledgmentDisposition,
  parseWorkspaceAcknowledgmentDisposition,
  serializeWorkspaceCliAcknowledgmentDisposition,
  workspaceCliAcknowledgmentRestored,
  workspaceCliAcknowledgmentDisposition,
  type ClaimedWorkspaceAcknowledgment,
  type WorkspaceCliAcknowledgmentDisposition,
  type WorkspaceAcknowledgmentDisposition,
} from './acknowledgment.js';

export interface WorkspacePoolOptions {
  repositories: RepositoryConfig[];
  ledger: LedgerRepository;
  gitRunner?: GitRunner;
  sentinels?: WorkspaceSentinelManager;
  sentinelOptions?: WorkspaceSentinelManagerOptions;
}

export interface WorkspaceCandidateResult {
  configuredPath: string;
  inspection: WorkspaceInspection | null;
  code: 'eligible' | 'unsafe' | 'leased' | 'sentinel-unsafe' | 'ledger-unavailable';
  message: string;
  blockingLease?: {
    jobId: string;
    taskId: string;
    jobState: JobState;
    leaseState: LeaseState;
  };
}

export interface WorkspaceLeaseHandle {
  repository: string;
  configuredPath: string;
  canonicalWorkspace: string;
  baseline: WorkspaceFingerprint;
  sentinel: WorkspaceSentinelPayload;
  ledgerLease: WorkspaceLease;
}

export type WorkspaceAcquireResult =
  | { kind: 'acquired'; handle: WorkspaceLeaseHandle; inspected: WorkspaceCandidateResult[] }
  | { kind: 'capacity-unavailable'; repository: string; inspected: WorkspaceCandidateResult[] }
  | { kind: 'unconfigured'; repository: string; inspected: [] };

export type WorkspaceCapacityResult =
  | { kind: 'available'; repository: string; inspected: WorkspaceCandidateResult[] }
  | {
      kind: 'capacity-unavailable';
      repository: string;
      inspected: WorkspaceCandidateResult[];
    }
  | { kind: 'unconfigured'; repository: string; inspected: [] };

export interface WorkspaceAcquireInput {
  repository: string;
  jobId: string;
  attemptId: string;
}

export type WorkspaceVerification =
  | { kind: 'verified'; inspection: WorkspaceInspection }
  | { kind: 'quarantined'; detail: WorkspaceQuarantineDetail; inspection: WorkspaceInspection };

export type WorkspaceReconcileResult =
  | { kind: 'released'; lease: WorkspaceLease; inspection: WorkspaceInspection }
  | {
      kind: 'quarantined';
      lease: WorkspaceLease;
      detail: WorkspaceQuarantineDetail;
      inspection: WorkspaceInspection;
    };

export type WorkspaceAcknowledgement =
  | { kind: 'released'; lease: WorkspaceLease; inspection: WorkspaceInspection }
  | { kind: 'refused'; reason: string; inspection: WorkspaceInspection | null };

export class WorkspacePool {
  readonly #repositories: RepositoryConfig[];
  readonly #ledger: LedgerRepository;
  readonly #gitRunner: GitRunner | undefined;
  readonly #sentinels: WorkspaceSentinelManager;

  constructor(options: WorkspacePoolOptions) {
    this.#repositories = options.repositories.map((entry) => ({
      repository: normalizeGitHubRepository(entry.repository),
      clones: [...entry.clones],
    }));
    this.#ledger = options.ledger;
    this.#gitRunner = options.gitRunner;
    this.#sentinels =
      options.sentinels ?? new WorkspaceSentinelManager(options.sentinelOptions ?? {});
  }

  async inspect(repository: string): Promise<WorkspaceCandidateResult[]> {
    const normalized = normalizeGitHubRepository(repository);
    const configured = this.#repositories.find((entry) => entry.repository === normalized);
    if (!configured) return [];
    const results: WorkspaceCandidateResult[] = [];
    for (const candidate of configured.clones) {
      results.push(await this.#candidate(candidate, normalized));
    }
    return results;
  }

  async potentialCapacity(
    repository: string,
  ): Promise<'available' | 'capacity-unavailable' | 'unconfigured'> {
    return (await this.capacity(repository)).kind;
  }

  async capacity(repository: string): Promise<WorkspaceCapacityResult> {
    const normalized = normalizeGitHubRepository(repository);
    const configured = this.#repositories.find((entry) => entry.repository === normalized);
    if (!configured) {
      return { kind: 'unconfigured', repository: normalized, inspected: [] };
    }
    const inspected: WorkspaceCandidateResult[] = [];
    for (const configuredPath of configured.clones) {
      const candidate = await this.#candidate(configuredPath, normalized);
      const workspace = candidate.inspection?.canonicalWorkspace;
      const commonDirectory = candidate.inspection?.fingerprint?.gitCommonDirectory;
      if (candidate.code !== 'eligible' || !workspace || !commonDirectory) {
        inspected.push(candidate);
        continue;
      }
      const lease = this.#ledger.getLease(workspace);
      if (lease && lease.state !== 'Released') {
        const job = this.#ledger.getJob(lease.jobId);
        inspected.push({
          ...candidate,
          code: 'leased',
          message: job
            ? `In use by task ${job.sourceMarker} (${job.state}; job ${job.id})`
            : `Workspace has an active spool lease for unknown job ${lease.jobId}`,
          ...(job
            ? {
                blockingLease: {
                  jobId: job.id,
                  taskId: job.sourceMarker,
                  jobState: job.state,
                  leaseState: lease.state,
                },
              }
            : {}),
        });
        continue;
      }
      const availability = await this.#sentinels.availability(commonDirectory);
      if (availability === 'available') {
        inspected.push(candidate);
        return { kind: 'available', repository: normalized, inspected };
      }
      inspected.push({
        ...candidate,
        code: availability === 'busy' ? 'leased' : 'sentinel-unsafe',
        message:
          availability === 'busy'
            ? 'Workspace has a live or indeterminate spool lease sentinel'
            : 'Workspace lease sentinel cannot be inspected safely',
      });
    }
    return { kind: 'capacity-unavailable', repository: normalized, inspected };
  }

  async acquire(input: WorkspaceAcquireInput): Promise<WorkspaceAcquireResult> {
    const repository = normalizeGitHubRepository(input.repository);
    const configured = this.#repositories.find((entry) => entry.repository === repository);
    if (!configured) return { kind: 'unconfigured', repository, inspected: [] };

    const inspected: WorkspaceCandidateResult[] = [];
    for (const configuredPath of configured.clones) {
      const inspection = await this.#inspect(configuredPath, repository);
      if (!inspection.eligible || !inspection.fingerprint || !inspection.canonicalWorkspace) {
        inspected.push({
          configuredPath,
          inspection,
          code: 'unsafe',
          message: inspection.reasons.map((reason) => reason.message).join('; '),
        });
        continue;
      }

      const acquired = await this.#sentinels.acquire(inspection.fingerprint.gitCommonDirectory, {
        jobId: input.jobId,
        attemptId: input.attemptId,
        canonicalWorkspace: inspection.canonicalWorkspace,
        requestedRepository: repository,
        baseline: inspection.fingerprint,
      });
      if (acquired.kind !== 'acquired') {
        inspected.push({
          configuredPath,
          inspection,
          code: acquired.kind === 'busy' ? 'leased' : 'sentinel-unsafe',
          message: acquired.reason,
        });
        continue;
      }

      try {
        const ledgerLease = this.#ledger.holdLease(
          inspection.canonicalWorkspace,
          input.jobId,
          input.attemptId,
          serializeWorkspaceLeaseHandle({
            repository,
            configuredPath,
            canonicalWorkspace: inspection.canonicalWorkspace,
            baseline: inspection.fingerprint,
            sentinel: acquired.payload,
          }),
        );
        inspected.push({
          configuredPath,
          inspection,
          code: 'eligible',
          message: acquired.recoveredStale
            ? 'Workspace acquired after safe stale-sentinel recovery'
            : 'Workspace acquired',
        });
        return {
          kind: 'acquired',
          handle: {
            repository,
            configuredPath,
            canonicalWorkspace: inspection.canonicalWorkspace,
            baseline: inspection.fingerprint,
            sentinel: acquired.payload,
            ledgerLease,
          },
          inspected,
        };
      } catch (error) {
        const unwound = await this.#sentinels.releaseOwned(
          inspection.fingerprint.gitCommonDirectory,
          acquired.payload,
        );
        if (!unwound.valid) {
          throw new Error(
            `Ledger rejected workspace lease and its sentinel could not be unwound: ${unwound.reason}`,
            { cause: error },
          );
        }
        throw error;
      }
    }

    return { kind: 'capacity-unavailable', repository, inspected };
  }

  async verifyBeforeSpawn(handle: WorkspaceLeaseHandle): Promise<WorkspaceVerification> {
    const sentinel = await this.#sentinels.verifyOwned(
      handle.baseline.gitCommonDirectory,
      handle.sentinel,
    );
    const inspection = await this.#inspect(handle.configuredPath, handle.repository);
    if (!sentinel.valid) {
      const detail = quarantineDetail(
        'sentinel-invalid',
        handle.baseline,
        inspection,
        `Workspace sentinel validation failed before provider spawn: ${sentinel.reason}`,
      );
      this.#quarantine(handle, detail);
      return { kind: 'quarantined', detail, inspection };
    }

    const differences = compareWorkspaceFingerprints(handle.baseline, inspection.fingerprint);
    if (!inspection.eligible || differences.length > 0) {
      const detail = quarantineDetail(
        'workspace-changed',
        handle.baseline,
        inspection,
        'Workspace changed between lease acquisition and provider spawn',
      );
      this.#quarantine(handle, detail);
      return { kind: 'quarantined', detail, inspection };
    }
    return { kind: 'verified', inspection };
  }

  async reconcileDisposition(handle: WorkspaceLeaseHandle): Promise<WorkspaceReconcileResult> {
    const existingLease = this.#ledger.getLease(handle.canonicalWorkspace);
    if (!existingLease) throw new Error(`Unknown workspace lease ${handle.canonicalWorkspace}`);
    const cliAcknowledgment = parseWorkspaceCliAcknowledgmentDisposition(existingLease.disposition);
    if (
      existingLease.state === 'ReleasePending' &&
      cliAcknowledgment &&
      this.#matchesCliAcknowledgment(cliAcknowledgment, handle)
    ) {
      const recovered = await this.#continueCliAcknowledgment(cliAcknowledgment);
      if (recovered.kind === 'released') return recovered;
    }
    const inspection = await this.#inspect(handle.configuredPath, handle.repository);
    if (existingLease.state === 'Released') {
      return { kind: 'released', lease: existingLease, inspection };
    }
    const sentinel = await this.#sentinels.verifyOwned(
      handle.baseline.gitCommonDirectory,
      handle.sentinel,
    );
    const differences = compareWorkspaceFingerprints(handle.baseline, inspection.fingerprint);
    const releaseAlreadyRemovedSentinel =
      existingLease.state === 'ReleasePending' && sentinel.missing === true;
    if (
      (!sentinel.valid && !releaseAlreadyRemovedSentinel) ||
      !inspection.eligible ||
      differences.length > 0
    ) {
      const detail = quarantineDetail(
        sentinel.valid ? 'workspace-changed' : 'sentinel-invalid',
        handle.baseline,
        inspection,
        sentinel.valid
          ? 'Workspace changed while the provider held its lease'
          : `Workspace sentinel validation failed at release: ${sentinel.reason}`,
      );
      return {
        kind: 'quarantined',
        lease: this.#quarantine(handle, detail),
        detail,
        inspection,
      };
    }

    let lease = existingLease;
    if (lease.state === 'Quarantined') {
      const detail = quarantineDetail(
        'workspace-changed',
        handle.baseline,
        inspection,
        'Workspace remains quarantined pending human acknowledgement',
      );
      return { kind: 'quarantined', lease, detail, inspection };
    }
    if (lease.state === 'Held') {
      lease = this.#ledger.transitionLease(handle.canonicalWorkspace, 'ReleasePending');
    }
    if (releaseAlreadyRemovedSentinel) {
      lease = this.#ledger.transitionLease(handle.canonicalWorkspace, 'Released');
      return { kind: 'released', lease, inspection };
    }
    const releasedSentinel =
      lease.state === 'ReleasePending' && handle.sentinel.ownerNonce !== this.#sentinels.ownerNonce
        ? await this.#sentinels.releaseAbandoned(
            handle.baseline.gitCommonDirectory,
            handle.sentinel,
          )
        : await this.#sentinels.releaseOwned(handle.baseline.gitCommonDirectory, handle.sentinel);
    if (!releasedSentinel.valid) {
      const detail = quarantineDetail(
        'release-failed',
        handle.baseline,
        inspection,
        `Workspace sentinel could not be released: ${releasedSentinel.reason}`,
      );
      return {
        kind: 'quarantined',
        lease: this.#quarantine(handle, detail),
        detail,
        inspection,
      };
    }
    lease = this.#ledger.transitionLease(handle.canonicalWorkspace, 'Released');
    return { kind: 'released', lease, inspection };
  }

  async acknowledge(canonicalWorkspace: string): Promise<WorkspaceAcknowledgement> {
    const canonical = path.resolve(canonicalWorkspace);
    const lease = this.#ledger.getLease(canonical);
    const request = parseWorkspaceCliAcknowledgmentRequest(lease?.disposition ?? null);
    const pending = parseWorkspaceCliAcknowledgmentDisposition(lease?.disposition ?? null);
    if (lease?.state === 'ReleasePending' && pending) {
      return this.#continueCliAcknowledgment(pending);
    }
    if (!lease || lease.state !== 'Quarantined') {
      return {
        kind: 'refused',
        reason: 'Workspace does not have a quarantined lease',
        inspection: null,
      };
    }
    const configured = this.#configuredClone(canonical);
    if (!configured) {
      return this.#refuseCliAcknowledgmentRequest(
        canonical,
        request,
        'Quarantined workspace is no longer present in configuration',
        null,
      );
    }
    const handle = parseWorkspaceLeaseHandle(lease.metadata, lease);
    if (!handle) {
      return this.#refuseCliAcknowledgmentRequest(
        canonical,
        request,
        'Quarantined workspace has no valid durable lease identity',
        null,
      );
    }
    const sentinel = await this.#sentinels.verifyQuarantined(handle.baseline.gitCommonDirectory, {
      jobId: lease.jobId,
      attemptId: lease.attemptId,
      canonicalWorkspace: canonical,
    });
    if (!sentinel.valid) {
      return this.#refuseCliAcknowledgmentRequest(
        canonical,
        request,
        `Quarantine sentinel verification failed: ${sentinel.reason}`,
        null,
      );
    }
    const inspection = await this.#inspect(configured.clone, configured.repository);
    const inspectionProblem = workspaceInspectionProblem(inspection);
    if (inspectionProblem) {
      return this.#refuseCliAcknowledgmentRequest(
        canonical,
        request,
        `Workspace is still unsafe: ${inspectionProblem}`,
        inspection,
      );
    }
    const disposition = workspaceCliAcknowledgmentDisposition({
      jobId: lease.jobId,
      attemptId: lease.attemptId,
      canonicalWorkspace: canonical,
      previousDisposition: request?.previousDisposition ?? lease.disposition,
    });
    this.#ledger.transitionLease(
      canonical,
      'ReleasePending',
      serializeWorkspaceCliAcknowledgmentDisposition(disposition),
    );
    return this.#continueCliAcknowledgment(disposition);
  }

  async acknowledgeClaim(claim: ClaimedWorkspaceAcknowledgment): Promise<WorkspaceAcknowledgement> {
    const lease = this.#ledger.getLease(claim.disposition.canonicalWorkspace);
    const disposition = parseWorkspaceAcknowledgmentDisposition(lease?.disposition ?? null);
    if (
      !lease ||
      lease.state !== 'ReleasePending' ||
      !disposition ||
      disposition.phase !== 'awaiting-inspection' ||
      !matchesWorkspaceAcknowledgmentIdentity(disposition, claim.disposition)
    ) {
      return {
        kind: 'refused',
        reason: 'Workspace acknowledgment claim is no longer current',
        inspection: null,
      };
    }
    return this.#continueWorkspaceAcknowledgment(disposition, claim.successor.text);
  }

  refuseUndisclosedAcknowledgmentClaim(
    claim: ClaimedWorkspaceAcknowledgment,
  ): WorkspaceAcknowledgement {
    const lease = this.#ledger.getLease(claim.disposition.canonicalWorkspace);
    const disposition = parseWorkspaceAcknowledgmentDisposition(lease?.disposition ?? null);
    if (
      !lease ||
      lease.state !== 'ReleasePending' ||
      !disposition ||
      disposition.phase !== 'awaiting-inspection' ||
      !matchesWorkspaceAcknowledgmentIdentity(disposition, claim.disposition)
    ) {
      return {
        kind: 'refused',
        reason: 'Workspace acknowledgment claim is no longer current',
        inspection: null,
      };
    }
    return this.#refuseWorkspaceAcknowledgment(
      disposition,
      claim.successor.text,
      'The checked action predates branch-restoration disclosure; inspect and confirm the new action',
      null,
    );
  }

  async recoverAcknowledgment(canonicalWorkspace: string): Promise<WorkspaceAcknowledgement> {
    const canonical = path.resolve(canonicalWorkspace);
    const lease = this.#ledger.getLease(canonical);
    const disposition = parseWorkspaceAcknowledgmentDisposition(lease?.disposition ?? null);
    if (!lease || lease.state !== 'ReleasePending' || !disposition) {
      return {
        kind: 'refused',
        reason: 'Workspace does not have a pending acknowledgment operation',
        inspection: null,
      };
    }
    const successor = this.#ledger
      .listFollowUps(disposition.jobId)
      .find(({ eventKey }) => eventKey === disposition.successorEventKey);
    if (!successor || successor.completedAt === null) {
      return {
        kind: 'refused',
        reason: 'Workspace acknowledgment successor is not safely staged',
        inspection: null,
      };
    }
    if (disposition.phase === 'awaiting-inspection') {
      return this.#refuseWorkspaceAcknowledgment(
        disposition,
        successor.text,
        'Acknowledgment was interrupted before safety inspection; inspect and confirm again',
        null,
      );
    }
    if (!['inspected-safe', 'restored-safe'].includes(disposition.phase)) {
      return {
        kind: 'refused',
        reason: 'Workspace acknowledgment is not recoverable',
        inspection: null,
      };
    }
    return this.#continueWorkspaceAcknowledgment(disposition, successor.text);
  }

  async #continueWorkspaceAcknowledgment(
    disposition: WorkspaceAcknowledgmentDisposition,
    successorText: string,
  ): Promise<WorkspaceAcknowledgement> {
    const context = this.#acknowledgmentContext(disposition);
    if (!context) {
      return this.#refuseWorkspaceAcknowledgment(
        disposition,
        successorText,
        'Quarantined workspace is no longer present in configuration or its durable identity is invalid',
        null,
      );
    }
    if (disposition.phase !== 'awaiting-inspection') {
      const sentinel = await this.#sentinels.verifyQuarantined(
        context.handle.baseline.gitCommonDirectory,
        disposition,
      );
      if (!sentinel.valid) {
        if (sentinel.missing === true && disposition.phase === 'restored-safe') {
          const inspection = await this.#inspect(
            context.configuredClone,
            context.handle.repository,
          );
          return {
            kind: 'released',
            lease: this.#ledger.completeWorkspaceAcknowledgment(disposition),
            inspection,
          };
        }
        return this.#refuseWorkspaceAcknowledgment(
          disposition,
          successorText,
          `Quarantine sentinel verification failed after inspection: ${sentinel.reason}`,
          null,
        );
      }
    }
    const inspection = await this.#inspect(context.configuredClone, context.handle.repository);
    const inspectionProblem = workspaceInspectionProblem(inspection);
    if (inspectionProblem) {
      return this.#refuseWorkspaceAcknowledgment(
        disposition,
        successorText,
        `Workspace is still unsafe: ${inspectionProblem}`,
        inspection,
      );
    }
    if (!samePath(inspection.canonicalWorkspace ?? '', disposition.canonicalWorkspace)) {
      return this.#refuseWorkspaceAcknowledgment(
        disposition,
        successorText,
        'Configured workspace path changed after quarantine',
        inspection,
      );
    }
    if (disposition.phase === 'awaiting-inspection') {
      const sentinel = await this.#sentinels.verifyQuarantined(
        context.handle.baseline.gitCommonDirectory,
        disposition,
      );
      if (!sentinel.valid) {
        return this.#refuseWorkspaceAcknowledgment(
          disposition,
          successorText,
          `Quarantine sentinel verification failed before release: ${sentinel.reason}`,
          inspection,
        );
      }
      this.#ledger.markWorkspaceAcknowledgmentInspected(disposition);
    }
    const restoration = await restoreWorkspaceBaselineBranch(
      context.configuredClone,
      context.handle.repository,
      context.handle.baseline,
      { ...(this.#gitRunner ? { runner: this.#gitRunner } : {}) },
    );
    if (restoration.kind === 'refused') {
      return this.#refuseWorkspaceAcknowledgment(
        disposition,
        successorText,
        restoration.reason,
        restoration.inspection,
      );
    }
    if (disposition.phase !== 'restored-safe') {
      this.#ledger.markWorkspaceAcknowledgmentRestored(disposition);
    }
    const released = await this.#sentinels.releaseQuarantined(
      context.handle.baseline.gitCommonDirectory,
      disposition,
    );
    if (!released.valid && released.missing !== true) {
      return this.#refuseWorkspaceAcknowledgment(
        disposition,
        successorText,
        `Quarantine sentinel verification failed: ${released.reason}`,
        inspection,
      );
    }
    return {
      kind: 'released',
      lease: this.#ledger.completeWorkspaceAcknowledgment(disposition),
      inspection: restoration.inspection,
    };
  }

  #refuseWorkspaceAcknowledgment(
    disposition: WorkspaceAcknowledgmentDisposition,
    successorText: string,
    reason: string,
    inspection: WorkspaceInspection | null,
  ): WorkspaceAcknowledgement {
    const boundedReason = boundWorkspaceAcknowledgmentReason(reason);
    this.#ledger.refuseWorkspaceAcknowledgment({
      ...disposition,
      reason: boundedReason,
      successorText: `${successorText}: ${boundedReason}`,
    });
    return { kind: 'refused', reason: boundedReason, inspection };
  }

  async #continueCliAcknowledgment(
    disposition: WorkspaceCliAcknowledgmentDisposition,
  ): Promise<WorkspaceAcknowledgement> {
    const lease = this.#ledger.getLease(disposition.canonicalWorkspace);
    const handle = lease ? parseWorkspaceLeaseHandle(lease.metadata, lease) : null;
    if (!lease || lease.state !== 'ReleasePending') {
      return {
        kind: 'refused',
        reason: 'Workspace CLI acknowledgment is no longer current',
        inspection: null,
      };
    }
    if (!handle || !this.#matchesCliAcknowledgment(disposition, handle)) {
      return this.#refusePendingCliAcknowledgment(
        disposition,
        'Workspace CLI acknowledgment is no longer current',
        null,
      );
    }
    const configured = this.#configuredClone(disposition.canonicalWorkspace);
    if (!configured || configured.repository !== handle.repository) {
      return this.#refusePendingCliAcknowledgment(
        disposition,
        'Quarantined workspace is no longer present in configuration',
        null,
      );
    }
    const sentinel = await this.#sentinels.verifyQuarantined(
      handle.baseline.gitCommonDirectory,
      disposition,
    );
    if (sentinel.missing === true && disposition.phase === 'restored-safe') {
      const inspection = await this.#inspect(configured.clone, configured.repository);
      return {
        kind: 'released',
        lease: this.#ledger.transitionLease(
          disposition.canonicalWorkspace,
          'Released',
          serializeWorkspaceCliAcknowledgmentDisposition(disposition),
        ),
        inspection,
      };
    }
    if (!sentinel.valid) {
      return this.#refusePendingCliAcknowledgment(
        disposition,
        `Quarantine sentinel verification failed: ${sentinel.reason}`,
        null,
      );
    }
    const inspection = await this.#inspect(configured.clone, configured.repository);
    const inspectionProblem = workspaceInspectionProblem(inspection);
    if (inspectionProblem) {
      return this.#refusePendingCliAcknowledgment(
        disposition,
        `Workspace is still unsafe: ${inspectionProblem}`,
        inspection,
      );
    }
    const restoration = await restoreWorkspaceBaselineBranch(
      configured.clone,
      handle.repository,
      handle.baseline,
      { ...(this.#gitRunner ? { runner: this.#gitRunner } : {}) },
    );
    if (restoration.kind === 'refused') {
      return this.#refusePendingCliAcknowledgment(
        disposition,
        restoration.reason,
        restoration.inspection,
      );
    }
    const restoredDisposition = workspaceCliAcknowledgmentRestored(disposition);
    if (disposition.phase !== 'restored-safe') {
      this.#ledger.markWorkspaceCliAcknowledgmentRestored(disposition);
    }
    const released = await this.#sentinels.releaseQuarantined(
      handle.baseline.gitCommonDirectory,
      restoredDisposition,
    );
    if (!released.valid) {
      return this.#refusePendingCliAcknowledgment(
        disposition,
        `Quarantine sentinel verification failed: ${released.reason}`,
        inspection,
      );
    }
    return {
      kind: 'released',
      lease: this.#ledger.transitionLease(
        disposition.canonicalWorkspace,
        'Released',
        serializeWorkspaceCliAcknowledgmentDisposition(restoredDisposition),
      ),
      inspection: restoration.inspection,
    };
  }

  #matchesCliAcknowledgment(
    disposition: WorkspaceCliAcknowledgmentDisposition,
    handle: WorkspaceLeaseHandle,
  ): boolean {
    return (
      disposition.jobId === handle.ledgerLease.jobId &&
      disposition.attemptId === handle.ledgerLease.attemptId &&
      samePath(disposition.canonicalWorkspace, handle.canonicalWorkspace)
    );
  }

  #refuseCliAcknowledgmentRequest(
    canonicalWorkspace: string,
    request: ReturnType<typeof parseWorkspaceCliAcknowledgmentRequest>,
    reason: string,
    inspection: WorkspaceInspection | null,
  ): Extract<WorkspaceAcknowledgement, { kind: 'refused' }> {
    if (request?.phase === 'requested') {
      this.#ledger.refuseWorkspaceCliAcknowledgment(canonicalWorkspace, reason);
    }
    return { kind: 'refused', reason, inspection };
  }

  #refusePendingCliAcknowledgment(
    disposition: WorkspaceCliAcknowledgmentDisposition,
    reason: string,
    inspection: WorkspaceInspection | null,
  ): Extract<WorkspaceAcknowledgement, { kind: 'refused' }> {
    this.#ledger.refusePendingWorkspaceCliAcknowledgment(disposition, reason);
    return { kind: 'refused', reason, inspection };
  }

  #acknowledgmentContext(disposition: WorkspaceAcknowledgmentDisposition): {
    configuredClone: string;
    handle: WorkspaceLeaseHandle;
  } | null {
    const lease = this.#ledger.getLease(disposition.canonicalWorkspace);
    if (
      !lease ||
      lease.state !== 'ReleasePending' ||
      lease.jobId !== disposition.jobId ||
      lease.attemptId !== disposition.attemptId
    ) {
      return null;
    }
    const configured = this.#configuredClone(disposition.canonicalWorkspace);
    if (!configured) return null;
    try {
      const handle = parseWorkspaceLeaseHandle(lease.metadata, lease);
      if (!handle || handle.repository !== configured.repository) return null;
      return { configuredClone: configured.clone, handle };
    } catch {
      return null;
    }
  }

  #quarantine(handle: WorkspaceLeaseHandle, detail: WorkspaceQuarantineDetail): WorkspaceLease {
    const lease = this.#ledger.getLease(handle.canonicalWorkspace);
    if (!lease) throw new Error(`Unknown workspace lease ${handle.canonicalWorkspace}`);
    if (lease.state === 'Quarantined') return lease;
    if (lease.state === 'Released') {
      throw new Error(`Cannot quarantine released workspace ${handle.canonicalWorkspace}`);
    }
    return this.#ledger.transitionLease(
      handle.canonicalWorkspace,
      'Quarantined',
      serializeQuarantineDetail(detail),
    );
  }

  #configuredClone(canonicalWorkspace: string): { repository: string; clone: string } | null {
    for (const repository of this.#repositories) {
      for (const clone of repository.clones) {
        let configuredCanonical: string;
        try {
          configuredCanonical = realpathSync(clone);
        } catch {
          configuredCanonical = path.resolve(clone);
        }
        if (samePath(configuredCanonical, canonicalWorkspace)) {
          return { repository: repository.repository, clone };
        }
      }
    }
    return null;
  }

  #inspect(configuredPath: string, repository: string): Promise<WorkspaceInspection> {
    return inspectGitWorkspace(configuredPath, repository, {
      ...(this.#gitRunner ? { runner: this.#gitRunner } : {}),
    });
  }

  async #candidate(configuredPath: string, repository: string): Promise<WorkspaceCandidateResult> {
    const inspection = await this.#inspect(configuredPath, repository);
    return {
      configuredPath,
      inspection,
      code: inspection.eligible ? 'eligible' : 'unsafe',
      message: inspection.eligible
        ? 'Workspace is eligible'
        : inspection.reasons.map((reason) => reason.message).join('; '),
    };
  }
}

function workspaceInspectionProblem(inspection: WorkspaceInspection): string | null {
  if (!inspection.fingerprint) {
    return `Workspace could not be inspected: ${inspection.reasons.map((item) => item.message).join('; ')}`;
  }
  if (inspection.fingerprint.status.entries.length > 0) {
    const dirty = inspection.reasons.find(({ code }) => code === 'worktree-dirty');
    return dirty?.message ?? 'The clone has uncommitted or untracked changes';
  }
  return null;
}
