import { z } from 'zod';

export const OPERATIONAL_EVENT_VERSION = 1 as const;
export const MAX_OPERATIONAL_RECORD_BYTES = 16 * 1_024;

export const operationalSeverities = ['info', 'warn', 'error'] as const;
export type OperationalSeverity = (typeof operationalSeverities)[number];

export const operationalRuntimeModes = ['daemon', 'run-once'] as const;
export type OperationalRuntimeMode = (typeof operationalRuntimeModes)[number];

export const dispatchWaitReasons = [
  'provider_unavailable',
  'initial_receipt_pending',
  'repository_missing',
  'workspace_unconfigured',
  'workspace_capacity',
  'workspace_quarantined',
  'projection_blocked',
] as const;
export type DispatchWaitReason = (typeof dispatchWaitReasons)[number];

export const workspaceQuarantineReasons = [
  'changed_before_spawn',
  'release_failed',
  'unsafe_state',
] as const;
export type WorkspaceQuarantineReason = (typeof workspaceQuarantineReasons)[number];

export const providerTerminalOutcomes = [
  'completed',
  'failed',
  'cancelled',
  'timed_out',
  'uncertain',
] as const;
export type ProviderTerminalOutcome = (typeof providerTerminalOutcomes)[number];

const uuid = z.uuid();
const timestamp = z.iso.datetime({ offset: false, precision: 3 });
const providerName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);
const boundedCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const base = {
  version: z.literal(OPERATIONAL_EVENT_VERSION),
  eventId: uuid,
  timestamp,
  runtimeId: uuid,
};

const operationalEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...base,
      type: z.literal('runtime.started'),
      severity: z.literal('info'),
      mode: z.enum(operationalRuntimeModes),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('runtime.stopped'),
      severity: z.literal('info'),
      mode: z.enum(operationalRuntimeModes),
      outcome: z.enum(['clean', 'failed']),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('reconciliation.completed'),
      severity: z.literal('info'),
      claimedJobs: boundedCount,
      launchedJobs: boundedCount,
      waitingJobs: boundedCount,
      projected: boundedCount,
      blockedProjections: boundedCount,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('reconciliation.failed'),
      severity: z.literal('error'),
      reason: z.literal('internal_error'),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('job.claimed'),
      severity: z.literal('info'),
      jobId: uuid,
      provider: providerName,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('dispatch.waiting'),
      severity: z.literal('warn'),
      jobId: uuid,
      reason: z.enum(dispatchWaitReasons),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('workspace.acquired'),
      severity: z.literal('info'),
      jobId: uuid,
      attemptId: uuid,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('workspace.released'),
      severity: z.literal('info'),
      jobId: uuid,
      attemptId: uuid,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('workspace.quarantined'),
      severity: z.literal('warn'),
      jobId: uuid,
      attemptId: uuid,
      reason: z.enum(workspaceQuarantineReasons),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('provider.launched'),
      severity: z.literal('info'),
      jobId: uuid,
      attemptId: uuid,
      provider: providerName,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('provider.terminal'),
      severity: z.enum(['info', 'warn', 'error']),
      jobId: uuid,
      attemptId: uuid,
      provider: providerName,
      outcome: z.enum(providerTerminalOutcomes),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('logging.records_dropped'),
      severity: z.literal('warn'),
      count: boundedCount.min(1),
      reason: z.literal('queue_overload'),
    })
    .strict(),
]);

export type OperationalEvent = z.infer<typeof operationalEventSchema>;
export type OperationalEventType = OperationalEvent['type'];

/**
 * Parse the exact on-disk contract. Unknown keys and unsupported versions are
 * rejected before a renderer can inspect their values.
 */
export function parseOperationalEvent(value: unknown): OperationalEvent {
  return operationalEventSchema.parse(value);
}

export function tryParseOperationalEvent(value: unknown): OperationalEvent | null {
  const result = operationalEventSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function serializeOperationalEvent(event: OperationalEvent): Buffer {
  const parsed = parseOperationalEvent(event);
  const encoded = Buffer.from(`${JSON.stringify(parsed)}\n`, 'utf8');
  if (encoded.byteLength > MAX_OPERATIONAL_RECORD_BYTES) {
    throw new Error('Operational log record exceeds the fixed byte limit');
  }
  return encoded;
}

export function fireAndForgetOperational(operation: () => Promise<unknown> | undefined): void {
  try {
    const pending = operation();
    if (pending) void pending.catch(() => undefined);
  } catch {
    // Operational logging never widens the caller's failure domain.
  }
}
