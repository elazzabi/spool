export const jobStates = [
  'Queued',
  'Working',
  'NeedsInput',
  'Completed',
  'Failed',
  'Cancelled',
] as const;

export type JobState = (typeof jobStates)[number];
export const terminalJobStates = ['Completed', 'Failed', 'Cancelled'] as const;
export type TerminalJobState = (typeof terminalJobStates)[number];

export function isTerminalJobState(state: JobState): state is TerminalJobState {
  return (terminalJobStates as readonly JobState[]).includes(state);
}

export const attemptStates = ['Prepared', 'Launching', 'Running', 'Uncertain', 'Terminal'] as const;
export type AttemptState = (typeof attemptStates)[number];

export const leaseStates = ['Held', 'ReleasePending', 'Released', 'Quarantined'] as const;
export type LeaseState = (typeof leaseStates)[number];

export const projectionStates = ['Pending', 'Applied', 'Blocked'] as const;
export type ProjectionState = (typeof projectionStates)[number];

export interface Job {
  id: string;
  sequence: number;
  sourceMarker: string;
  sourcePath: string;
  provider: string;
  directive: string;
  context: string;
  repository: string | null;
  state: JobState;
  cancellationRequested: boolean;
  createdAt: string;
  updatedAt: string;
  terminalAt: string | null;
}

export interface Attempt {
  id: string;
  jobId: string;
  attemptNumber: number;
  state: AttemptState;
  logPath: string;
  provider: string | null;
  sessionId: string | null;
  observationCursor: string | null;
  observationHash: string | null;
  uncertaintyReason: string | null;
  processId: number | null;
  processStartIdentity: string | null;
  latestOutput: string | null;
  launchMetadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  terminalAt: string | null;
}

export interface WorkspaceLease {
  canonicalWorkspace: string;
  jobId: string;
  attemptId: string;
  state: LeaseState;
  disposition: string | null;
  metadata: Record<string, unknown> | null;
  heldAt: string;
  updatedAt: string;
  releasedAt: string | null;
}

export interface Projection {
  id: string;
  jobId: string;
  semanticKey: string;
  state: ProjectionState;
  blockedReason: string | null;
  createdAt: string;
  updatedAt: string;
}
