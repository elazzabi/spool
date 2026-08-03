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

const piSessionPolicy = defineSessionIdPolicy({
  description: 'Pi session ID',
  pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  maxLength: 36,
});

export const piEnvironmentAllowlist = [
  ...defaultProviderEnvironmentAllowlist,
  'PI_CODING_AGENT_DIR',
] as const;

export const piSafeArgs = [
  '--offline',
  '--tools',
  'read,grep,find,ls',
  '--no-extensions',
  '--no-context-files',
  '--no-skills',
  '--no-prompt-templates',
] as const;

export function piLaunchArgs(defaultArgs: readonly string[], sessionDirectory: string): string[] {
  return [...defaultArgs, ...piSafeArgs, '--session-dir', sessionDirectory, '--mode', 'json'];
}

export interface PiProviderOptions {
  readonly executable: string;
  readonly defaultArgs: readonly string[];
  readonly sessionDirectory: string;
  readonly preflight: BuiltinProviderPreflight;
  readonly environmentAllowlist?: readonly string[];
}

export class PiProvider implements ProviderAdapter {
  readonly name = 'pi';
  readonly capabilities;
  readonly sessionIdPolicy = piSessionPolicy;
  readonly #options: PiProviderOptions;

  constructor(options: PiProviderOptions) {
    assertBuiltinParserSupported(options.preflight, 'pi');
    this.#options = options;
    this.capabilities = defineCapabilities(options.preflight.capabilities);
  }

  createLaunch(input: ProviderLaunchInput): ProviderLaunchRequest {
    const eventStream = createPiEventStream();
    return {
      target: pinLaunchTarget(this.#options.executable, input.cwd),
      args: piLaunchArgs(this.#options.defaultArgs, this.#options.sessionDirectory),
      stdoutFormat: 'jsonl',
      environmentAllowlist: this.#options.environmentAllowlist ?? piEnvironmentAllowlist,
      environment: {},
      prompt: input.prompt,
      logTarget: pinLogTarget(input.logPath),
      limits: {
        maxLogBytes: 32 * 1024 * 1024,
        maxJsonLineBytes: 4 * 1024 * 1024,
        maxOutputBytes: 32 * 1024 * 1024,
      },
      timeoutMs: 8 * 60 * 60 * 1000,
      cancelGraceMs: 5_000,
      diagnostics: this.#options.preflight.warnings,
      sessionIdPolicy: this.sessionIdPolicy,
      parseEvent: eventStream.parseEvent,
      finishEventStream: eventStream.finishEventStream,
    };
  }

  parseEvent(value: unknown): ProviderEventParseResult {
    return parsePiStreamEvent(value);
  }

  inspectCommand(sessionId: string): ProviderCommand {
    return this.#sessionCommand(sessionId);
  }

  resumeCommand(sessionId: string): ProviderCommand {
    return this.#sessionCommand(sessionId);
  }

  #sessionCommand(sessionId: string): ProviderCommand {
    const parsed = this.sessionIdPolicy.parse(sessionId);
    return {
      executable: this.name,
      args: [
        ...this.#options.defaultArgs,
        ...piSafeArgs,
        '--session-dir',
        this.#options.sessionDirectory,
        '--session',
        parsed,
      ],
    };
  }
}

function createPiEventStream(): {
  parseEvent: (value: unknown) => ProviderEventParseResult;
  finishEventStream: () => ProviderEventParseResult;
} {
  let terminal: Extract<ProviderEvidence, { kind: 'terminal' }> | null = null;
  let hasSessionIdentity = false;
  return {
    parseEvent: (value) => {
      if (isRecord(value) && value.type === 'auto_retry_start') {
        terminal = null;
        return { kind: 'ignored' };
      }
      const parsed = parsePiStreamEvent(value);
      if (parsed.kind === 'events' && parsed.events.some((event) => event.kind === 'session')) {
        hasSessionIdentity = true;
      }
      if (isRecord(value) && value.type === 'agent_end' && parsed.kind === 'malformed') {
        terminal = null;
      }
      if (parsed.kind !== 'event' || parsed.event.kind !== 'terminal') return parsed;
      terminal = parsed.event;
      return { kind: 'ignored' };
    },
    finishEventStream: () => {
      const finalTerminal = terminal;
      terminal = null;
      const hadSessionIdentity = hasSessionIdentity;
      hasSessionIdentity = false;
      if (!hadSessionIdentity || !finalTerminal) return { kind: 'ignored' };
      return { kind: 'event', event: finalTerminal };
    },
  };
}

function parsePiStreamEvent(value: unknown): ProviderEventParseResult {
  if (!isRecord(value) || typeof value.type !== 'string') return { kind: 'ignored' };

  if (value.type === 'session') {
    if (value.version !== 3 || typeof value.id !== 'string') {
      return { kind: 'malformed', message: 'Pi session header is missing a version-3 session ID' };
    }
    try {
      piSessionPolicy.parse(value.id);
    } catch {
      return { kind: 'malformed', message: 'Pi session header contains an invalid session ID' };
    }
    return {
      kind: 'events',
      events: [
        { kind: 'session', eventKey: `pi:session:${value.id}`, sessionId: value.id },
        { kind: 'state', eventKey: `pi:session:${value.id}:working`, state: 'working' },
      ],
    };
  }

  if (value.type === 'message_end') return parsePiMessageEnd(value.message, value);
  if (value.type === 'agent_end') return parsePiAgentEnd(value.messages, value);
  return { kind: 'ignored' };
}

function parsePiMessageEnd(message: unknown, event: unknown): ProviderEventParseResult {
  if (!isRecord(message) || typeof message.role !== 'string') {
    return { kind: 'malformed', message: 'Pi message_end is missing a typed message' };
  }
  if (message.role !== 'assistant') return { kind: 'ignored' };
  const text = extractAssistantText(message);
  if (text.kind === 'malformed') return text;
  if (!text.text) return { kind: 'ignored' };
  return {
    kind: 'event',
    event: { kind: 'output', eventKey: `pi:message_end:${digest(event)}`, text: text.text },
  };
}

function parsePiAgentEnd(messages: unknown, event: unknown): ProviderEventParseResult {
  if (!Array.isArray(messages)) {
    return { kind: 'malformed', message: 'Pi agent_end is missing messages' };
  }
  let assistant: Record<string, unknown> | null = null;
  for (const message of messages) {
    if (!isRecord(message) || typeof message.role !== 'string') {
      return { kind: 'malformed', message: 'Pi agent_end contains an invalid message' };
    }
    if (message.role === 'assistant') assistant = message;
  }
  if (!assistant || typeof assistant.stopReason !== 'string' || !assistant.stopReason) {
    return {
      kind: 'malformed',
      message: 'Pi agent_end is missing a final assistant stopReason',
    };
  }
  const text = extractAssistantText(assistant);
  if (text.kind === 'malformed') return text;

  const stopReason = assistant.stopReason;
  const state =
    stopReason === 'error' ? 'failed' : stopReason === 'aborted' ? 'cancelled' : 'completed';
  const errorMessage =
    typeof assistant.errorMessage === 'string' && assistant.errorMessage.trim()
      ? assistant.errorMessage.trim()
      : null;
  const message =
    state === 'failed' ? (errorMessage ?? text.text) : state === 'cancelled' ? text.text : '';
  return {
    kind: 'event',
    event: {
      kind: 'terminal',
      eventKey: `pi:agent_end:${digest(event)}`,
      state,
      proof: `pi:agent_end:${stopReason}`,
      ...(message ? { message } : {}),
    },
  };
}

function extractAssistantText(
  message: Record<string, unknown>,
):
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'malformed'; readonly message: string } {
  if (!Array.isArray(message.content)) {
    return { kind: 'malformed', message: 'Pi assistant message is missing content blocks' };
  }
  const text: string[] = [];
  for (const block of message.content) {
    if (!isRecord(block) || typeof block.type !== 'string') {
      return {
        kind: 'malformed',
        message: 'Pi assistant message contains an invalid content block',
      };
    }
    if (block.type !== 'text') continue;
    if (typeof block.text !== 'string') {
      return { kind: 'malformed', message: 'Pi assistant text block is missing text' };
    }
    text.push(block.text);
  }
  return { kind: 'text', text: text.join('\n') };
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
