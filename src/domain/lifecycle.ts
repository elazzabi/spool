import type { AttemptState, JobState, LeaseState, ProjectionState } from './job.js';

export class InvalidLifecycleTransitionError extends Error {
  constructor(lifecycle: string, from: string, to: string, terminal: boolean) {
    super(
      terminal
        ? `${lifecycle} state ${from} is terminal and cannot transition to ${to}`
        : `Invalid ${lifecycle} transition from ${from} to ${to}`,
    );
    this.name = 'InvalidLifecycleTransitionError';
  }
}

const jobTransitions: Readonly<Record<JobState, readonly JobState[]>> = {
  Queued: ['Working', 'Cancelled'],
  Working: ['NeedsInput', 'Completed', 'Failed', 'Cancelled'],
  NeedsInput: ['Working', 'Completed', 'Failed', 'Cancelled'],
  Completed: [],
  Failed: [],
  Cancelled: [],
};

const attemptTransitions: Readonly<Record<AttemptState, readonly AttemptState[]>> = {
  Prepared: ['Launching', 'Terminal'],
  Launching: ['Running', 'Uncertain', 'Terminal'],
  Running: ['Uncertain', 'Terminal'],
  Uncertain: ['Running', 'Terminal'],
  Terminal: [],
};

const leaseTransitions: Readonly<Record<LeaseState, readonly LeaseState[]>> = {
  Held: ['ReleasePending', 'Quarantined'],
  ReleasePending: ['Released', 'Quarantined'],
  Released: [],
  Quarantined: ['ReleasePending'],
};

const projectionTransitions: Readonly<Record<ProjectionState, readonly ProjectionState[]>> = {
  Pending: ['Applied', 'Blocked'],
  Applied: [],
  Blocked: ['Pending', 'Applied'],
};

export function assertJobTransition(from: JobState, to: JobState): void {
  assertTransition('job', jobTransitions, from, to);
}

export function assertAttemptTransition(from: AttemptState, to: AttemptState): void {
  assertTransition('attempt', attemptTransitions, from, to);
}

export function assertLeaseTransition(from: LeaseState, to: LeaseState): void {
  assertTransition('lease', leaseTransitions, from, to);
}

export function assertProjectionTransition(from: ProjectionState, to: ProjectionState): void {
  assertTransition('projection', projectionTransitions, from, to);
}

function assertTransition<State extends string>(
  lifecycle: string,
  transitions: Readonly<Record<State, readonly State[]>>,
  from: State,
  to: State,
): void {
  if (from === to) return;
  const valid = transitions[from];
  if (!valid.includes(to)) {
    throw new InvalidLifecycleTransitionError(lifecycle, from, to, valid.length === 0);
  }
}
