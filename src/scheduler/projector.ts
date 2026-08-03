import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { deepestContainingDirectory } from '../config/paths.js';
import type { SpoolConfig } from '../config/schema.js';
import type { Job } from '../domain/job.js';
import type { LedgerRepository } from '../ledger/repositories.js';
import type { OutboxRepository } from '../ledger/outbox.js';
import { findUniqueDayHeading } from '../notes/day-heading.js';
import {
  applyNoteProjection,
  projectCurrentWeekFollowUp,
  type CurrentWeekFollowUp,
  type NoteProjectionIntent,
} from '../notes/patch.js';
import { weeklyNoteFilename } from '../notes/week.js';

const OUTBOX_KIND = 'note-projection';

interface SourceProjectionPayload {
  version: 1;
  destination: 'source';
  jobId: string;
  notePath: string;
  intent: NoteProjectionIntent;
}

interface CurrentWeekProjectionPayload {
  version: 1;
  destination: 'current-week';
  jobId: string;
  sourceNotePath: string;
  eventKey: string;
  taskId: string;
  checked: boolean;
  text: string;
  command?: readonly string[];
  commandDirectory?: string;
}

type ProjectionPayload = SourceProjectionPayload | CurrentWeekProjectionPayload;

export interface ProjectionDeliveryResult {
  applied: number;
  blocked: number;
  errors: string[];
}

export class NoteProjector {
  readonly #config: SpoolConfig;
  readonly #ledger: LedgerRepository;
  readonly #outbox: OutboxRepository;
  readonly #now: () => Date;

  constructor(options: {
    config: SpoolConfig;
    ledger: LedgerRepository;
    outbox: OutboxRepository;
    now?: () => Date;
  }) {
    this.#config = options.config;
    this.#ledger = options.ledger;
    this.#outbox = options.outbox;
    this.#now = options.now ?? (() => new Date());
  }

  enqueueSource(job: Job, semanticKey: string, intent: NoteProjectionIntent): void {
    this.#ledger.recordProjection(job.id, semanticKey);
    this.#outbox.enqueue({
      semanticKey,
      kind: OUTBOX_KIND,
      payload: {
        version: 1,
        destination: 'source',
        jobId: job.id,
        notePath: job.sourcePath,
        intent,
      },
    });
  }

  enqueueCurrentWeek(
    job: Job,
    semanticKey: string,
    input: Omit<
      CurrentWeekProjectionPayload,
      'version' | 'destination' | 'jobId' | 'sourceNotePath'
    >,
  ): void {
    this.#ledger.recordProjection(job.id, semanticKey);
    this.#outbox.enqueue({
      semanticKey,
      kind: OUTBOX_KIND,
      payload: {
        version: 1,
        destination: 'current-week',
        jobId: job.id,
        sourceNotePath: job.sourcePath,
        ...input,
      },
    });
  }

  async deliver(ownerToken: string, maximum = 100): Promise<ProjectionDeliveryResult> {
    const result: ProjectionDeliveryResult = { applied: 0, blocked: 0, errors: [] };
    for (let delivered = 0; delivered < maximum; delivered += 1) {
      const now = this.#now();
      const item = this.#outbox.claimNext(ownerToken, 30_000, now);
      if (!item) break;
      try {
        if (item.kind !== OUTBOX_KIND) {
          this.#outbox.release(item.id, ownerToken, `Unsupported outbox kind: ${item.kind}`, now);
          result.errors.push(`Unsupported outbox kind: ${item.kind}`);
          break;
        }
        const payload = parseProjectionPayload(item.payload);
        const projection = await this.#apply(payload);
        if (projection.blocked) {
          this.#ledger.transitionProjection(
            item.semanticKey,
            'Blocked',
            projection.reason ?? 'Projection target is not currently safe',
          );
          // Keep this row claimed until its short lease expires. That defers it without allowing
          // the FIFO head to be reclaimed immediately, so unrelated later projections can run.
          result.blocked += 1;
          continue;
        }
        const current = this.#ledger.recordProjection(payload.jobId, item.semanticKey);
        if (current.state === 'Blocked') {
          this.#ledger.transitionProjection(item.semanticKey, 'Pending');
        }
        this.#ledger.transitionProjection(item.semanticKey, 'Applied');
        this.#outbox.acknowledge(item.id, ownerToken, now);
        result.applied += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const projection = this.#ledger.getProjection(item.semanticKey);
        if (projection && projection.state !== 'Applied') {
          this.#ledger.transitionProjection(item.semanticKey, 'Blocked', message);
        }
        this.#outbox.release(item.id, ownerToken, message, now);
        result.errors.push(`${item.semanticKey}: ${message}`);
        // The released FIFO head is immediately claimable again. Stop this delivery pass so a
        // persistent filesystem error cannot spin through the whole batch in one reconciliation.
        break;
      }
    }
    return result;
  }

  async #apply(payload: ProjectionPayload) {
    if (payload.destination === 'source') {
      return applyNoteProjection(payload.notePath, payload.intent, {
        providers: providerDirectives(this.#config),
      });
    }
    const owningRoot = deepestContainingDirectory(this.#config.vaults, payload.sourceNotePath);
    if (!owningRoot) {
      return {
        changed: false,
        blocked: true,
        reason: 'Source note is outside every configured watched folder.',
        sourceHash: '',
      };
    }
    const currentNotePath = path.join(
      owningRoot,
      weeklyNoteFilename(this.#now(), this.#config.timeZone),
    );
    const dayHeading = await currentDayHeading(
      currentNotePath,
      this.#now(),
      this.#config.timeZone,
      this.#config.dayAliases,
    );
    if (!dayHeading) {
      return {
        changed: false,
        blocked: true,
        reason: 'Current weekly note or its current-day H2 is missing or ambiguous.',
        sourceHash: '',
      };
    }
    const input: CurrentWeekFollowUp = {
      currentNotePath,
      sourceNotePath: payload.sourceNotePath,
      dayHeading,
      eventKey: payload.eventKey,
      taskId: payload.taskId,
      checked: payload.checked,
      text: payload.text,
      ...(payload.command ? { command: payload.command } : {}),
      ...(payload.commandDirectory ? { commandDirectory: payload.commandDirectory } : {}),
    };
    return projectCurrentWeekFollowUp(input);
  }
}

export function providerDirectives(config: SpoolConfig): Record<string, string> {
  return Object.fromEntries(
    config.providers
      .filter((provider) => provider.enabled)
      .map((provider) => [provider.name, provider.directive]),
  );
}

async function currentDayHeading(
  notePath: string,
  now: Date,
  timeZone: string,
  aliases: SpoolConfig['dayAliases'],
): Promise<string | null> {
  let source: string;
  try {
    source = await readFile(notePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const canonical = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone })
    .format(now)
    .toLowerCase() as keyof SpoolConfig['dayAliases'];
  const candidates = [
    ...new Map(
      [canonical, ...(aliases[canonical] ?? [])].map((candidate) => [
        candidate.trim().toLocaleLowerCase('en-US'),
        candidate,
      ]),
    ).values(),
  ];
  const matches = candidates.flatMap((candidate) => {
    const match = findUniqueDayHeading(source, candidate);
    return match ? [match.heading] : [];
  });
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function parseProjectionPayload(value: Record<string, unknown>): ProjectionPayload {
  if (
    value.version !== 1 ||
    typeof value.destination !== 'string' ||
    typeof value.jobId !== 'string'
  ) {
    throw new Error('Invalid note-projection outbox payload');
  }
  if (
    value.destination === 'source' &&
    typeof value.notePath === 'string' &&
    typeof value.intent === 'object' &&
    value.intent !== null
  ) {
    return value as unknown as SourceProjectionPayload;
  }
  if (
    value.destination === 'current-week' &&
    typeof value.sourceNotePath === 'string' &&
    typeof value.eventKey === 'string' &&
    typeof value.taskId === 'string' &&
    typeof value.checked === 'boolean' &&
    typeof value.text === 'string' &&
    (value.commandDirectory === undefined || typeof value.commandDirectory === 'string') &&
    (value.command === undefined ||
      (Array.isArray(value.command) && value.command.every((item) => typeof item === 'string')))
  ) {
    return value as unknown as CurrentWeekProjectionPayload;
  }
  throw new Error('Invalid note-projection outbox payload');
}
