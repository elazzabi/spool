import { describe, expect, it } from 'vitest';

import {
  assertAttemptTransition,
  assertJobTransition,
  assertLeaseTransition,
  assertProjectionTransition,
} from '../../src/domain/lifecycle.js';

describe('lifecycle transition guards', () => {
  it('allows only evidence-backed job transitions and keeps terminal outcomes monotonic', () => {
    expect(() => assertJobTransition('Queued', 'Working')).not.toThrow();
    expect(() => assertJobTransition('Working', 'NeedsInput')).not.toThrow();
    expect(() => assertJobTransition('NeedsInput', 'Working')).not.toThrow();
    expect(() => assertJobTransition('Working', 'Completed')).not.toThrow();
    expect(() => assertJobTransition('Completed', 'Working')).toThrow(/terminal/i);
    expect(() => assertJobTransition('Queued', 'Cancelled')).not.toThrow();
    expect(() => assertJobTransition('Working', 'Cancelled')).not.toThrow();
  });

  it('does not treat an uncertain launch as safe to relaunch', () => {
    expect(() => assertAttemptTransition('Prepared', 'Launching')).not.toThrow();
    expect(() => assertAttemptTransition('Launching', 'Uncertain')).not.toThrow();
    expect(() => assertAttemptTransition('Uncertain', 'Running')).not.toThrow();
    expect(() => assertAttemptTransition('Uncertain', 'Prepared')).toThrow(/invalid/i);
    expect(() => assertAttemptTransition('Terminal', 'Running')).toThrow(/terminal/i);
  });

  it('keeps lease and projection lifecycles independent', () => {
    expect(() => assertLeaseTransition('Held', 'Quarantined')).not.toThrow();
    expect(() => assertLeaseTransition('ReleasePending', 'Released')).not.toThrow();
    expect(() => assertLeaseTransition('Quarantined', 'ReleasePending')).not.toThrow();
    expect(() => assertLeaseTransition('Quarantined', 'Released')).toThrow(/invalid/i);
    expect(() => assertProjectionTransition('Pending', 'Blocked')).not.toThrow();
    expect(() => assertProjectionTransition('Blocked', 'Pending')).not.toThrow();
    expect(() => assertProjectionTransition('Applied', 'Pending')).toThrow(/terminal/i);
  });
});
