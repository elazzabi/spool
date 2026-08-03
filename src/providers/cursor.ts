import { createHash } from 'node:crypto';

import { defineCapabilities } from './capabilities.js';
import { defaultProviderEnvironmentAllowlist } from './environment.js';
import { pinLaunchTarget, pinLogTarget } from './process-runner.js';
import { assertBuiltinParserSupported, type BuiltinProviderPreflight } from './preflight.js';
import {
  defineSessionIdPolicy,
  isRecord,
  type ProviderAdapter,
  type ProviderCommand,
  type ProviderEventParseResult,
  type ProviderLaunchInput,
  type ProviderLaunchRequest,
} from './types.js';

const cursorSessionPolicy = defineSessionIdPolicy({
  description: 'Cursor session ID',
  pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  maxLength: 36,
});

export interface CursorProviderOptions {
  readonly executable: string;
  readonly defaultArgs: readonly string[];
  readonly preflight: BuiltinProviderPreflight;
  readonly environmentAllowlist?: readonly string[];
}

export class CursorProvider implements ProviderAdapter {
  readonly name = 'cursor';
  readonly capabilities;
  readonly sessionIdPolicy = cursorSessionPolicy;
  readonly #options: CursorProviderOptions;

  constructor(options: CursorProviderOptions) {
    assertBuiltinParserSupported(options.preflight, 'cursor');
    this.#options = options;
    this.capabilities = defineCapabilities(options.preflight.capabilities);
  }

  createLaunch(input: ProviderLaunchInput): ProviderLaunchRequest {
    const target = pinLaunchTarget(this.#options.executable, input.cwd);
    return {
      target,
      args: [
        ...this.#options.defaultArgs,
        '--print',
        '--output-format',
        'stream-json',
        '--workspace',
        target.cwd.canonicalPath,
      ],
      stdoutFormat: 'jsonl',
      environmentAllowlist:
        this.#options.environmentAllowlist ?? defaultProviderEnvironmentAllowlist,
      environment: {},
      prompt: input.prompt,
      logTarget: pinLogTarget(input.logPath),
      limits: {
        maxLogBytes: 8 * 1024 * 1024,
        maxJsonLineBytes: 1024 * 1024,
        maxOutputBytes: 8 * 1024 * 1024,
      },
      timeoutMs: 8 * 60 * 60 * 1000,
      cancelGraceMs: 5_000,
      sessionIdPolicy: this.sessionIdPolicy,
      parseEvent: parseCursorEvent,
    };
  }

  parseEvent(value: unknown): ProviderEventParseResult {
    return parseCursorEvent(value);
  }

  inspectCommand(sessionId: string): ProviderCommand {
    return this.#resumeCommand(sessionId);
  }

  resumeCommand(sessionId: string): ProviderCommand {
    return this.#resumeCommand(sessionId);
  }

  #resumeCommand(sessionId: string): ProviderCommand {
    const parsed = this.sessionIdPolicy.parse(sessionId);
    return {
      executable: this.#options.executable,
      args: [...this.#options.defaultArgs, '--resume', parsed],
    };
  }
}

export function parseCursorEvent(value: unknown): ProviderEventParseResult {
  if (!isRecord(value) || typeof value.type !== 'string') return { kind: 'ignored' };
  if (value.type === 'system' && value.subtype === 'init') {
    if (typeof value.session_id !== 'string') {
      return { kind: 'malformed', message: 'Cursor init event is missing session_id' };
    }
    return {
      kind: 'events',
      events: [
        {
          kind: 'session',
          eventKey: `cursor:session:${value.session_id}`,
          sessionId: value.session_id,
        },
        {
          kind: 'state',
          eventKey: `cursor:session:${value.session_id}:working`,
          state: 'working',
        },
      ],
    };
  }
  if (value.type !== 'result') return { kind: 'ignored' };
  if (
    typeof value.session_id !== 'string' ||
    typeof value.subtype !== 'string' ||
    typeof value.is_error !== 'boolean' ||
    typeof value.result !== 'string'
  ) {
    return { kind: 'malformed', message: 'Cursor result event is missing required fields' };
  }
  const success = value.subtype === 'success' && value.is_error === false;
  const eventBase = `cursor:result:${value.session_id}:${digest(value)}`;
  return {
    kind: 'events',
    events: [
      {
        kind: 'session',
        eventKey: `cursor:session:${value.session_id}`,
        sessionId: value.session_id,
      },
      { kind: 'output', eventKey: `${eventBase}:output`, text: value.result },
      {
        kind: 'terminal',
        eventKey: `${eventBase}:terminal`,
        state: success ? 'completed' : 'failed',
        proof: success ? 'cursor:result:success' : 'cursor:result:failure',
        ...(!success ? { message: value.result } : {}),
      },
    ],
  };
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
