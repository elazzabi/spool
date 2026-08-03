import { createHash } from 'node:crypto';

import type {
  ProviderEvidence,
  ProviderObservationSnapshot,
  ProviderState,
  ProviderTerminalState,
} from './types.js';

export type ObservationIngestResult =
  'accepted' | 'duplicate' | 'ignored-after-terminal' | 'conflict';

export class ProviderObservationAccumulator {
  readonly #eventKeys = new Set<string>();
  readonly #events: ProviderEvidence[] = [];
  #sessionId: string | null = null;
  #state: ProviderState | null = null;
  #latestOutput: { text: string; hash: string } | null = null;
  #terminalProof: { state: ProviderTerminalState; proof: string } | null = null;

  ingest(event: ProviderEvidence): ObservationIngestResult {
    if (this.#eventKeys.has(event.eventKey)) return 'duplicate';

    if (event.kind === 'session' && this.#sessionId && this.#sessionId !== event.sessionId) {
      return 'conflict';
    }
    if (this.#terminalProof) {
      if (
        event.kind === 'terminal' &&
        (event.state !== this.#terminalProof.state || event.proof !== this.#terminalProof.proof)
      ) {
        return 'conflict';
      }
      return 'ignored-after-terminal';
    }

    this.#eventKeys.add(event.eventKey);
    this.#events.push(event);
    switch (event.kind) {
      case 'session':
        this.#sessionId = event.sessionId;
        break;
      case 'state':
        this.#state = event.state;
        break;
      case 'output':
        this.#latestOutput = {
          text: event.text,
          hash: createHash('sha256').update(event.text).digest('hex'),
        };
        break;
      case 'terminal':
        this.#state = event.state;
        this.#terminalProof = { state: event.state, proof: event.proof };
        break;
    }
    return 'accepted';
  }

  snapshot(): ProviderObservationSnapshot {
    return {
      sessionId: this.#sessionId,
      state: this.#state,
      latestOutput: this.#latestOutput ? { ...this.#latestOutput } : null,
      terminalProof: this.#terminalProof ? { ...this.#terminalProof } : null,
      events: [...this.#events],
    };
  }
}

export function temporarilyUnavailableObservation(reason: string): ProviderEvidence {
  return {
    kind: 'state',
    eventKey: `temporarily-unavailable:${createHash('sha256').update(reason).digest('hex')}`,
    state: 'temporarily_unavailable',
    message: reason,
  };
}
