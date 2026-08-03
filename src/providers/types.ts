export type ProviderState =
  'working' | 'needs_input' | 'completed' | 'failed' | 'cancelled' | 'temporarily_unavailable';

export type ProviderTerminalState = 'completed' | 'failed' | 'cancelled';

export interface ProviderCapabilities {
  readonly launch: boolean;
  readonly observe: boolean;
  readonly inspect: boolean;
  readonly resume: boolean;
  readonly cancel: boolean;
  readonly needsInput: boolean;
}

/** A command remains executable and argv data until the final human renderer. */
export interface ProviderCommand {
  readonly executable: string;
  readonly args: readonly string[];
}

export interface SessionIdPolicyDefinition {
  readonly description: string;
  readonly pattern: RegExp;
  readonly maxLength: number;
}

export interface SessionIdPolicy extends SessionIdPolicyDefinition {
  parse(value: unknown): string;
}

export interface ProcessIdentity {
  readonly pid: number;
  readonly processStartIdentity: string;
}

export interface SessionIdentity {
  readonly sessionId: string;
}

interface ProviderEvidenceBase {
  readonly eventKey: string;
  readonly sequence?: number;
}

export type ProviderEvidence =
  | (ProviderEvidenceBase & {
      readonly kind: 'session';
      readonly sessionId: string;
    })
  | (ProviderEvidenceBase & {
      readonly kind: 'state';
      readonly state: Exclude<ProviderState, ProviderTerminalState>;
      readonly episodeId?: string;
      readonly message?: string;
    })
  | (ProviderEvidenceBase & {
      readonly kind: 'output';
      readonly text: string;
    })
  | (ProviderEvidenceBase & {
      readonly kind: 'terminal';
      readonly state: ProviderTerminalState;
      readonly proof: string;
      readonly message?: string;
    });

export type ProviderEventParseResult =
  | { readonly kind: 'event'; readonly event: ProviderEvidence }
  | { readonly kind: 'events'; readonly events: readonly ProviderEvidence[] }
  | { readonly kind: 'ignored' }
  | { readonly kind: 'malformed'; readonly message: string };

export type ProviderEventParser = (value: unknown) => ProviderEventParseResult;

export interface ProviderLaunchInput {
  readonly cwd: string;
  readonly logPath: string;
  readonly prompt: string | Uint8Array;
}

export interface ProviderAdapter {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  readonly sessionIdPolicy: SessionIdPolicy;
  createLaunch(input: ProviderLaunchInput): ProviderLaunchRequest;
  parseEvent(value: unknown): ProviderEventParseResult;
  inspectCommand(sessionId: string): ProviderCommand | null;
  resumeCommand?(sessionId: string): ProviderCommand | null;
  cancelCommand?(sessionId: string): ProviderCommand | null;
}

export interface LaunchFileIdentity {
  readonly canonicalPath: string;
  readonly device: number;
  readonly inode: number;
  readonly mode: number;
}

export interface ProviderLaunchTarget {
  readonly executable: LaunchFileIdentity;
  readonly cwd: LaunchFileIdentity;
}

export interface ProviderProcessLimits {
  readonly maxLogBytes: number;
  readonly maxJsonLineBytes: number;
  readonly maxOutputBytes: number;
}

export interface ProviderLaunchRequest {
  readonly target: ProviderLaunchTarget;
  readonly args: readonly string[];
  /** JSONL is the default. Line mode exists for version-pinned text protocols. */
  readonly stdoutFormat?: 'jsonl' | 'lines';
  /** Only these keys are inherited from the parent process. */
  readonly environmentAllowlist: readonly string[];
  /** Explicit values are intentional and do not inherit ambient secrets. */
  readonly environment: Readonly<Record<string, string>>;
  readonly prompt: string | Uint8Array;
  /** The caller persists and pins this destination before asking the runner to spawn. */
  readonly logTarget: LaunchFileIdentity;
  readonly limits: ProviderProcessLimits;
  readonly timeoutMs: number;
  readonly cancelGraceMs?: number;
  /** Sanitized provider context retained with the attempt, including on uncertainty. */
  readonly diagnostics?: readonly string[];
  readonly signal?: AbortSignal;
  readonly sessionIdPolicy: SessionIdPolicy | SessionIdPolicyDefinition;
  readonly parseEvent: ProviderEventParser;
  /** Emits evidence that can only be proven once the provider's stdout stream has closed. */
  readonly finishEventStream?: () => ProviderEventParseResult;
}

export interface ProviderObservationSnapshot {
  readonly sessionId: string | null;
  readonly state: ProviderState | null;
  readonly latestOutput: { readonly text: string; readonly hash: string } | null;
  readonly terminalProof: {
    readonly state: ProviderTerminalState;
    readonly proof: string;
  } | null;
  readonly events: readonly ProviderEvidence[];
}

export interface ProviderRunCallbacks {
  /** Persist this immediately. Throwing makes the launch uncertain. */
  readonly onProcessStarted?: (identity: ProcessIdentity) => void | Promise<void>;
  /** Persist this immediately. Throwing makes the launch uncertain. */
  readonly onSessionIdentity?: (identity: SessionIdentity) => void | Promise<void>;
  readonly onEvidence?: (event: ProviderEvidence) => void | Promise<void>;
}

export interface ProviderExitEvidence {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface ProviderRunResult {
  readonly launchState: 'not_started' | 'started' | 'uncertain';
  readonly processIdentity: ProcessIdentity | null;
  readonly terminalState: ProviderTerminalState | 'unproven';
  readonly observation: ProviderObservationSnapshot;
  readonly exit: ProviderExitEvidence;
  readonly diagnostics: readonly string[];
  readonly cancelRequested: boolean;
  readonly timedOut: boolean;
  readonly log: {
    readonly path: string;
    readonly bytesWritten: number;
    readonly truncated: boolean;
  };
}

export function defineSessionIdPolicy(definition: SessionIdPolicyDefinition): SessionIdPolicy {
  if (!Number.isSafeInteger(definition.maxLength) || definition.maxLength < 1) {
    throw new Error('Session ID maximum length must be a positive integer');
  }
  return Object.freeze({
    ...definition,
    parse(value: unknown): string {
      if (typeof value !== 'string') {
        throw new Error(`Invalid ${definition.description}: expected text`);
      }
      if (value.length > definition.maxLength) {
        throw new Error(
          `Invalid ${definition.description}: exceeds ${String(definition.maxLength)} characters`,
        );
      }
      definition.pattern.lastIndex = 0;
      if (!definition.pattern.test(value)) {
        throw new Error(`Invalid ${definition.description}: value does not match its grammar`);
      }
      return value;
    },
  });
}

export function asSessionIdPolicy(
  policy: SessionIdPolicy | SessionIdPolicyDefinition,
): SessionIdPolicy {
  return 'parse' in policy ? policy : defineSessionIdPolicy(policy);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
