import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineCapabilities } from './capabilities.js';
import { pinLaunchTarget, pinLogTarget } from './process-runner.js';
import {
  defineSessionIdPolicy,
  isRecord,
  type ProviderAdapter,
  type ProviderCommand,
  type ProviderEventParseResult,
  type ProviderLaunchInput,
  type ProviderLaunchRequest,
} from './types.js';

const fakeAgentPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../examples/providers/fake-agent.mjs',
);

export type FakeProviderScenario =
  | 'capture'
  | 'duplicate'
  | 'partial'
  | 'complete'
  | 'fail'
  | 'silent'
  | 'malformed'
  | 'no-terminal'
  | 'stderr-fail'
  | 'wait-cancel'
  | 'truncated'
  | 'lifecycle';

export interface FakeProviderOptions {
  readonly executable: string;
  readonly defaultArgs?: readonly string[];
  readonly environmentAllowlist?: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
}

export interface FakeLaunchInput extends ProviderLaunchInput {
  readonly scenario?: FakeProviderScenario;
  readonly statePath?: string;
}

export class FakeProvider implements ProviderAdapter {
  readonly name = 'fake';
  readonly capabilities = defineCapabilities({
    launch: true,
    observe: true,
    inspect: true,
    resume: true,
    cancel: true,
    needsInput: true,
  });
  readonly sessionIdPolicy = defineSessionIdPolicy({
    description: 'fake provider session ID',
    pattern: /^fake-[a-z0-9][a-z0-9-]*$/,
    maxLength: 64,
  });
  readonly #options: FakeProviderOptions;

  constructor(options: FakeProviderOptions) {
    this.#options = options;
  }

  parseEvent(value: unknown): ProviderEventParseResult {
    return parseFakeProviderEvent(value);
  }

  createLaunch(input: FakeLaunchInput): ProviderLaunchRequest {
    const args = [
      fakeAgentPath,
      ...(this.#options.defaultArgs ?? []),
      '--scenario',
      input.scenario ?? 'complete',
    ];
    if (input.statePath) args.push('--state', input.statePath);
    return {
      target: pinLaunchTarget(this.#options.executable, input.cwd),
      args,
      environmentAllowlist: this.#options.environmentAllowlist ?? [],
      environment: this.#options.environment ?? {},
      prompt: input.prompt,
      logTarget: pinLogTarget(input.logPath),
      limits: {
        maxLogBytes: 64 * 1024,
        maxJsonLineBytes: 1024,
        maxOutputBytes: 64 * 1024,
      },
      timeoutMs: 5_000,
      cancelGraceMs: 1_000,
      sessionIdPolicy: this.sessionIdPolicy,
      parseEvent: parseFakeProviderEvent,
    };
  }

  inspectCommand(sessionId: string): ProviderCommand {
    return this.#command('--inspect', sessionId);
  }

  resumeCommand(sessionId: string): ProviderCommand {
    return this.#command('--resume', sessionId);
  }

  cancelCommand(sessionId: string): ProviderCommand {
    return this.#command('--cancel', sessionId);
  }

  #command(operation: string, sessionId: string): ProviderCommand {
    const parsed = this.sessionIdPolicy.parse(sessionId);
    return { executable: this.#options.executable, args: [fakeAgentPath, operation, parsed] };
  }
}

export function parseFakeProviderEvent(value: unknown): ProviderEventParseResult {
  if (!isRecord(value) || typeof value.type !== 'string') return { kind: 'ignored' };
  if (!['session', 'state', 'output', 'terminal'].includes(value.type)) return { kind: 'ignored' };
  if (typeof value.event_id !== 'string' || value.event_id.length === 0) {
    return { kind: 'malformed', message: `Fake ${value.type} event is missing event_id` };
  }

  switch (value.type) {
    case 'session':
      if (typeof value.session_id !== 'string') {
        return { kind: 'malformed', message: 'Fake session event is missing session_id' };
      }
      return {
        kind: 'event',
        event: { kind: 'session', eventKey: value.event_id, sessionId: value.session_id },
      };
    case 'state': {
      if (!['working', 'needs_input', 'temporarily_unavailable'].includes(String(value.status))) {
        return { kind: 'malformed', message: 'Fake state event has an invalid status' };
      }
      if (value.status === 'needs_input' && typeof value.episode_id !== 'string') {
        return { kind: 'malformed', message: 'Fake needs-input event is missing episode_id' };
      }
      const state = value.status as 'working' | 'needs_input' | 'temporarily_unavailable';
      return {
        kind: 'event',
        event: {
          kind: 'state',
          eventKey: value.event_id,
          state,
          ...(typeof value.episode_id === 'string' ? { episodeId: value.episode_id } : {}),
          ...(typeof value.message === 'string' ? { message: value.message } : {}),
        },
      };
    }
    case 'output':
      if (typeof value.text !== 'string') {
        return { kind: 'malformed', message: 'Fake output event is missing text' };
      }
      return {
        kind: 'event',
        event: { kind: 'output', eventKey: value.event_id, text: value.text },
      };
    case 'terminal': {
      if (!['completed', 'failed', 'cancelled'].includes(String(value.status))) {
        return { kind: 'malformed', message: 'Fake terminal event has an invalid status' };
      }
      if (typeof value.proof !== 'string' || value.proof.length === 0) {
        return { kind: 'malformed', message: 'Fake terminal event is missing proof' };
      }
      const state = value.status as 'completed' | 'failed' | 'cancelled';
      return {
        kind: 'event',
        event: {
          kind: 'terminal',
          eventKey: value.event_id,
          state,
          proof: value.proof,
          ...(typeof value.message === 'string' ? { message: value.message } : {}),
        },
      };
    }
  }
  return { kind: 'ignored' };
}
