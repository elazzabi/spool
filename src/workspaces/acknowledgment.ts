import path from 'node:path';

import type { FollowUpAction } from '../domain/events.js';
import type { WorkspaceLease } from '../domain/job.js';

export const MAX_WORKSPACE_ACKNOWLEDGMENT_REASON_LENGTH = 500;

export type WorkspaceAcknowledgmentPhase =
  'awaiting-inspection' | 'inspected-safe' | 'restored-safe' | 'refused';

export interface WorkspaceAcknowledgmentIdentity {
  jobId: string;
  attemptId: string;
  canonicalWorkspace: string;
  eventKey: string;
  successorEventKey: string;
}

export interface WorkspaceAcknowledgmentDisposition extends WorkspaceAcknowledgmentIdentity {
  version: 1;
  kind: 'workspace-acknowledgment';
  phase: WorkspaceAcknowledgmentPhase;
  reason: string | null;
}

export interface WorkspaceCliAcknowledgmentDisposition {
  version: 1;
  kind: 'workspace-cli-acknowledgment';
  phase: 'inspected-safe' | 'restored-safe';
  jobId: string;
  attemptId: string;
  canonicalWorkspace: string;
  previousDisposition: string | null;
}

interface WorkspaceCliAcknowledgmentRequestBase {
  version: 1;
  kind: 'workspace-cli-acknowledgment-request';
  jobId: string;
  attemptId: string;
  canonicalWorkspace: string;
  previousDisposition: string | null;
}

export type WorkspaceCliAcknowledgmentRequest = WorkspaceCliAcknowledgmentRequestBase &
  ({ phase: 'requested'; reason: null } | { phase: 'refused'; reason: string });

type WorkspaceCliAcknowledgmentRequestInput = Omit<
  WorkspaceCliAcknowledgmentRequestBase,
  'version' | 'kind'
>;

export interface ClaimWorkspaceAcknowledgmentInput extends WorkspaceAcknowledgmentIdentity {
  successorText: string;
}

export interface RefuseWorkspaceAcknowledgmentInput extends WorkspaceAcknowledgmentIdentity {
  reason: string;
  successorText: string;
}

export type WorkspaceAcknowledgmentClaimResult =
  | {
      kind: 'claimed';
      action: FollowUpAction;
      successor: FollowUpAction;
      lease: WorkspaceLease;
      disposition: WorkspaceAcknowledgmentDisposition;
    }
  | { kind: 'refused'; reason: string };

export type ClaimedWorkspaceAcknowledgment = Extract<
  WorkspaceAcknowledgmentClaimResult,
  { kind: 'claimed' }
>;

export function workspaceAcknowledgmentEventKey(attemptId: string, generation: number): string {
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error('Workspace acknowledgment generation must be a non-negative integer');
  }
  return `workspace-ack:${attemptId}:${String(generation)}`;
}

export function workspaceAcknowledgmentText(baselineBranch: string | null): string {
  const target = baselineBranch
    ? `captured branch ${baselineBranch}`
    : 'the captured detached checkout';
  return `Inspect quarantined workspace: checking this action will attempt to return the clone to ${target} and release it`;
}

export function nextWorkspaceAcknowledgmentEventKey(
  attemptId: string,
  currentEventKey: string,
): string {
  const prefix = `workspace-ack:${attemptId}:`;
  if (currentEventKey.startsWith(prefix)) {
    const generation = Number(currentEventKey.slice(prefix.length));
    if (Number.isSafeInteger(generation) && generation >= 0) {
      return workspaceAcknowledgmentEventKey(attemptId, generation + 1);
    }
  }
  return workspaceAcknowledgmentEventKey(attemptId, 1);
}

export function isWorkspaceAcknowledgmentEventKey(attemptId: string, eventKey: string): boolean {
  const prefix = `workspace-ack:${attemptId}:`;
  if (eventKey.startsWith(prefix)) {
    const generation = Number(eventKey.slice(prefix.length));
    return Number.isSafeInteger(generation) && generation >= 0;
  }
  return eventKey.startsWith('workspace-') && eventKey.endsWith(`-${attemptId}`);
}

export function workspaceAcknowledgmentDisposition(
  identity: WorkspaceAcknowledgmentIdentity,
  phase: WorkspaceAcknowledgmentPhase,
  reason: string | null = null,
): WorkspaceAcknowledgmentDisposition {
  return {
    version: 1,
    kind: 'workspace-acknowledgment',
    phase,
    jobId: identity.jobId,
    attemptId: identity.attemptId,
    canonicalWorkspace: path.resolve(identity.canonicalWorkspace),
    eventKey: identity.eventKey,
    successorEventKey: identity.successorEventKey,
    reason: reason === null ? null : boundWorkspaceAcknowledgmentReason(reason),
  };
}

export function serializeWorkspaceAcknowledgmentDisposition(
  disposition: WorkspaceAcknowledgmentDisposition,
): string {
  return JSON.stringify(disposition);
}

export function workspaceCliAcknowledgmentDisposition(
  input: Omit<WorkspaceCliAcknowledgmentDisposition, 'version' | 'kind' | 'phase'>,
): WorkspaceCliAcknowledgmentDisposition {
  return {
    version: 1,
    kind: 'workspace-cli-acknowledgment',
    phase: 'inspected-safe',
    jobId: input.jobId,
    attemptId: input.attemptId,
    canonicalWorkspace: path.resolve(input.canonicalWorkspace),
    previousDisposition: input.previousDisposition,
  };
}

export function serializeWorkspaceCliAcknowledgmentDisposition(
  disposition: WorkspaceCliAcknowledgmentDisposition,
): string {
  return JSON.stringify(disposition);
}

export function workspaceCliAcknowledgmentRestored(
  disposition: WorkspaceCliAcknowledgmentDisposition,
): WorkspaceCliAcknowledgmentDisposition {
  return { ...disposition, phase: 'restored-safe' };
}

export function workspaceCliAcknowledgmentRequest(
  input: WorkspaceCliAcknowledgmentRequestInput,
): WorkspaceCliAcknowledgmentRequest {
  return {
    version: 1,
    kind: 'workspace-cli-acknowledgment-request',
    phase: 'requested',
    jobId: input.jobId,
    attemptId: input.attemptId,
    canonicalWorkspace: path.resolve(input.canonicalWorkspace),
    previousDisposition: input.previousDisposition,
    reason: null,
  };
}

export function workspaceCliAcknowledgmentRefusal(
  input: WorkspaceCliAcknowledgmentRequestInput,
  reason: string,
): WorkspaceCliAcknowledgmentRequest {
  return {
    ...workspaceCliAcknowledgmentRequest(input),
    phase: 'refused',
    reason: boundWorkspaceAcknowledgmentReason(reason),
  };
}

export function serializeWorkspaceCliAcknowledgmentRequest(
  request: WorkspaceCliAcknowledgmentRequest,
): string {
  return JSON.stringify(request);
}

export function parseWorkspaceCliAcknowledgmentRequest(
  value: string | null,
): WorkspaceCliAcknowledgmentRequest | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as Partial<WorkspaceCliAcknowledgmentRequestBase> & {
      phase?: unknown;
      reason?: unknown;
    };
    if (
      parsed.version !== 1 ||
      parsed.kind !== 'workspace-cli-acknowledgment-request' ||
      (parsed.phase !== 'requested' && parsed.phase !== 'refused') ||
      !isNonemptyString(parsed.jobId) ||
      !isNonemptyString(parsed.attemptId) ||
      !isNonemptyString(parsed.canonicalWorkspace) ||
      (parsed.previousDisposition !== null && typeof parsed.previousDisposition !== 'string') ||
      (parsed.phase === 'requested' ? parsed.reason !== null : typeof parsed.reason !== 'string')
    ) {
      return null;
    }
    return parsed as WorkspaceCliAcknowledgmentRequest;
  } catch {
    return null;
  }
}

export function parseWorkspaceCliAcknowledgmentDisposition(
  value: string | null,
): WorkspaceCliAcknowledgmentDisposition | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as Partial<WorkspaceCliAcknowledgmentDisposition>;
    if (
      parsed.version !== 1 ||
      parsed.kind !== 'workspace-cli-acknowledgment' ||
      !['inspected-safe', 'restored-safe'].includes(parsed.phase ?? '') ||
      !isNonemptyString(parsed.jobId) ||
      !isNonemptyString(parsed.attemptId) ||
      !isNonemptyString(parsed.canonicalWorkspace) ||
      (parsed.previousDisposition !== null && typeof parsed.previousDisposition !== 'string')
    ) {
      return null;
    }
    return parsed as WorkspaceCliAcknowledgmentDisposition;
  } catch {
    return null;
  }
}

export function parseWorkspaceAcknowledgmentDisposition(
  value: string | null,
): WorkspaceAcknowledgmentDisposition | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as Partial<WorkspaceAcknowledgmentDisposition>;
    if (
      parsed.version !== 1 ||
      parsed.kind !== 'workspace-acknowledgment' ||
      !['awaiting-inspection', 'inspected-safe', 'restored-safe', 'refused'].includes(
        parsed.phase ?? '',
      ) ||
      !isNonemptyString(parsed.jobId) ||
      !isNonemptyString(parsed.attemptId) ||
      !isNonemptyString(parsed.canonicalWorkspace) ||
      !isNonemptyString(parsed.eventKey) ||
      !isNonemptyString(parsed.successorEventKey) ||
      (parsed.reason !== null && typeof parsed.reason !== 'string')
    ) {
      return null;
    }
    return parsed as WorkspaceAcknowledgmentDisposition;
  } catch {
    return null;
  }
}

export function matchesWorkspaceAcknowledgmentIdentity(
  disposition: WorkspaceAcknowledgmentDisposition,
  identity: WorkspaceAcknowledgmentIdentity,
): boolean {
  return (
    disposition.jobId === identity.jobId &&
    disposition.attemptId === identity.attemptId &&
    disposition.canonicalWorkspace === path.resolve(identity.canonicalWorkspace) &&
    disposition.eventKey === identity.eventKey &&
    disposition.successorEventKey === identity.successorEventKey
  );
}

export function boundWorkspaceAcknowledgmentReason(reason: string): string {
  const normalized = reason.replace(/\s+/gu, ' ').trim();
  if (normalized.length <= MAX_WORKSPACE_ACKNOWLEDGMENT_REASON_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_WORKSPACE_ACKNOWLEDGMENT_REASON_LENGTH - 1)}…`;
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
