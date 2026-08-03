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
  type ProviderEvidence,
  type ProviderEventParseResult,
  type ProviderLaunchInput,
  type ProviderLaunchRequest,
} from './types.js';

const claudeSessionPolicy = defineSessionIdPolicy({
  description: 'Claude session ID',
  pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  maxLength: 36,
});

export interface ClaudeProviderOptions {
  readonly executable: string;
  readonly defaultArgs: readonly string[];
  readonly preflight: BuiltinProviderPreflight;
  readonly environmentAllowlist?: readonly string[];
}

export class ClaudeProvider implements ProviderAdapter {
  readonly name = 'claude';
  readonly capabilities;
  readonly sessionIdPolicy = claudeSessionPolicy;
  readonly #options: ClaudeProviderOptions;

  constructor(options: ClaudeProviderOptions) {
    assertBuiltinParserSupported(options.preflight, 'claude');
    this.#options = options;
    this.capabilities = defineCapabilities(options.preflight.capabilities);
  }

  createLaunch(input: ProviderLaunchInput): ProviderLaunchRequest {
    const eventStream = createClaudeEventStream();
    return {
      target: pinLaunchTarget(this.#options.executable, input.cwd),
      args: [...this.#options.defaultArgs, '-p', '--output-format', 'stream-json', '--verbose'],
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
      parseEvent: eventStream.parseEvent,
      finishEventStream: eventStream.finishEventStream,
    };
  }

  parseEvent(value: unknown): ProviderEventParseResult {
    return parseClaudeStreamEvent(value);
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
      executable: this.name,
      args: [...this.#options.defaultArgs, '--resume', parsed],
    };
  }
}

function createClaudeEventStream(): {
  parseEvent: (value: unknown) => ProviderEventParseResult;
  finishEventStream: () => ProviderEventParseResult;
} {
  let terminal: Extract<ProviderEvidence, { kind: 'terminal' }> | null = null;
  return {
    parseEvent: (value) => {
      const parsed = parseClaudeStreamEvent(value);
      if (parsed.kind !== 'events') return parsed;
      const checkpointTerminal = parsed.events.find(
        (event): event is Extract<ProviderEvidence, { kind: 'terminal' }> =>
          event.kind === 'terminal',
      );
      if (!checkpointTerminal) return parsed;
      terminal = checkpointTerminal;
      return {
        kind: 'events',
        events: parsed.events.filter((event) => event.kind !== 'terminal'),
      };
    },
    finishEventStream: () => {
      if (!terminal) return { kind: 'ignored' };
      const finalTerminal = terminal;
      terminal = null;
      return { kind: 'event', event: finalTerminal };
    },
  };
}

export function parseClaudeStreamEvent(value: unknown): ProviderEventParseResult {
  if (!isRecord(value) || typeof value.type !== 'string') return { kind: 'ignored' };
  if (value.type === 'system' && value.subtype === 'init') {
    if (typeof value.session_id !== 'string') {
      return { kind: 'malformed', message: 'Claude init event is missing session_id' };
    }
    return {
      kind: 'events',
      events: [
        {
          kind: 'session',
          eventKey: `claude:session:${value.session_id}`,
          sessionId: value.session_id,
        },
        {
          kind: 'state',
          eventKey: `claude:session:${value.session_id}:working`,
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
    return { kind: 'malformed', message: 'Claude result event is missing required fields' };
  }
  const success = value.subtype === 'success' && value.is_error === false;
  const eventBase = `claude:result:${value.session_id}:${digest(JSON.stringify(value))}`;
  return {
    kind: 'events',
    events: [
      {
        kind: 'session',
        eventKey: `claude:session:${value.session_id}`,
        sessionId: value.session_id,
      },
      { kind: 'output', eventKey: `${eventBase}:output`, text: value.result },
      {
        kind: 'terminal',
        eventKey: `${eventBase}:terminal`,
        state: success ? 'completed' : 'failed',
        proof: success ? 'claude:result:success' : 'claude:result:failure',
        ...(!success ? { message: value.result } : {}),
      },
    ],
  };
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
