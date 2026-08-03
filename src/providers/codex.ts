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

const codexSessionPolicy = defineSessionIdPolicy({
  description: 'Codex session ID',
  pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  maxLength: 36,
});

export interface CodexProviderOptions {
  readonly executable: string;
  readonly defaultArgs: readonly string[];
  readonly preflight: BuiltinProviderPreflight;
  readonly environmentAllowlist?: readonly string[];
}

export class CodexProvider implements ProviderAdapter {
  readonly name = 'codex';
  readonly capabilities;
  readonly sessionIdPolicy = codexSessionPolicy;
  readonly #options: CodexProviderOptions;

  constructor(options: CodexProviderOptions) {
    assertBuiltinParserSupported(options.preflight, 'codex');
    this.#options = options;
    this.capabilities = defineCapabilities(options.preflight.capabilities);
  }

  createLaunch(input: ProviderLaunchInput): ProviderLaunchRequest {
    return {
      target: pinLaunchTarget(this.#options.executable, input.cwd),
      args: ['exec', ...this.#options.defaultArgs, '--json', '-'],
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
      parseEvent: parseCodexEvent,
    };
  }

  parseEvent(value: unknown): ProviderEventParseResult {
    return parseCodexEvent(value);
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
      args: [...this.#options.defaultArgs, 'resume', parsed],
    };
  }
}

export function parseCodexEvent(value: unknown): ProviderEventParseResult {
  if (!isRecord(value) || typeof value.type !== 'string') return { kind: 'ignored' };
  switch (value.type) {
    case 'thread.started':
      if (typeof value.thread_id !== 'string') {
        return { kind: 'malformed', message: 'Codex thread.started is missing thread_id' };
      }
      return {
        kind: 'events',
        events: [
          {
            kind: 'session',
            eventKey: `codex:thread:${value.thread_id}`,
            sessionId: value.thread_id,
          },
          {
            kind: 'state',
            eventKey: `codex:thread:${value.thread_id}:working`,
            state: 'working',
          },
        ],
      };
    case 'turn.started':
      return {
        kind: 'event',
        event: { kind: 'state', eventKey: `codex:turn:started:${digest(value)}`, state: 'working' },
      };
    case 'item.completed':
      return parseCompletedCodexItem(value.item);
    case 'turn.completed':
      return {
        kind: 'event',
        event: {
          kind: 'terminal',
          eventKey: `codex:turn:completed:${digest(value)}`,
          state: 'completed',
          proof: 'codex:turn.completed',
        },
      };
    case 'turn.failed': {
      const message = extractErrorMessage(value.error);
      if (!message) return { kind: 'malformed', message: 'Codex turn.failed is missing error' };
      return failedCodexEvent(`codex:turn:failed:${digest(value)}`, message);
    }
    case 'error': {
      const message = extractErrorMessage(value) ?? extractErrorMessage(value.error);
      if (!message) return { kind: 'malformed', message: 'Codex error event is missing a message' };
      return failedCodexEvent(`codex:error:${digest(value)}`, message);
    }
    default:
      return { kind: 'ignored' };
  }
}

function parseCompletedCodexItem(item: unknown): ProviderEventParseResult {
  if (!isRecord(item) || typeof item.type !== 'string' || typeof item.id !== 'string') {
    return { kind: 'malformed', message: 'Codex item.completed is missing a typed item ID' };
  }
  if (item.type === 'agent_message') {
    if (typeof item.text !== 'string') {
      return { kind: 'malformed', message: 'Codex agent_message item is missing text' };
    }
    return {
      kind: 'event',
      event: { kind: 'output', eventKey: `codex:item:${item.id}`, text: item.text },
    };
  }
  if (item.status === 'failed') {
    const message = extractErrorMessage(item.error) ?? extractErrorMessage(item.message);
    if (!message) return { kind: 'ignored' };
    return failedCodexEvent(`codex:item:${item.id}:failed`, message);
  }
  if (item.type === 'error') {
    const message = extractErrorMessage(item);
    if (!message) return { kind: 'malformed', message: 'Codex error item is missing a message' };
    return {
      kind: 'event',
      event: { kind: 'output', eventKey: `codex:item:${item.id}:diagnostic`, text: message },
    };
  }
  return { kind: 'ignored' };
}

function failedCodexEvent(eventKey: string, message: string): ProviderEventParseResult {
  return {
    kind: 'events',
    events: [
      { kind: 'output', eventKey: `${eventKey}:output`, text: message },
      {
        kind: 'terminal',
        eventKey,
        state: 'failed',
        proof: 'codex:explicit-failure',
        message,
      },
    ],
  };
}

function extractErrorMessage(value: unknown, depth = 0): string | null {
  if (depth > 4) return null;
  if (typeof value === 'string') {
    const message = value.trim();
    if (!message) return null;
    if (message.startsWith('{')) {
      try {
        const nested = extractErrorMessage(JSON.parse(message) as unknown, depth + 1);
        if (nested) return nested;
      } catch {
        // Keep the original provider text when it only resembles JSON.
      }
    }
    return message;
  }
  if (isRecord(value)) {
    return (
      extractErrorMessage(value.message, depth + 1) ?? extractErrorMessage(value.error, depth + 1)
    );
  }
  return null;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
