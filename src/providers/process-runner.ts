import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';

import { JsonLineDecoder, TextLineDecoder, type JsonLineRecord } from './jsonl.js';
import { buildProviderEnvironment } from './environment.js';
import { AttemptLogWriter, sanitizeOperatorText } from './logs.js';
import { ProviderObservationAccumulator } from './observation.js';
import {
  asSessionIdPolicy,
  type LaunchFileIdentity,
  type ProviderEvidence,
  type ProviderExitEvidence,
  type ProviderLaunchRequest,
  type ProviderLaunchTarget,
  type ProviderRunCallbacks,
  type ProviderRunResult,
  type ProviderTerminalState,
} from './types.js';

const DEFAULT_CANCEL_GRACE_MS = 2_000;

export function pinLaunchTarget(executable: string, cwd: string): ProviderLaunchTarget {
  const executableIdentity = pinExistingPath(executable, 'file');
  accessSync(executableIdentity.canonicalPath, constants.X_OK);
  return {
    executable: executableIdentity,
    cwd: pinExistingPath(cwd, 'directory'),
  };
}

export function pinLogTarget(logPath: string): LaunchFileIdentity {
  return pinExistingPath(logPath, 'file');
}

export async function runProviderProcess(
  request: ProviderLaunchRequest,
  callbacks: ProviderRunCallbacks = {},
): Promise<ProviderRunResult> {
  validateRequest(request);
  const observation = new ProviderObservationAccumulator();
  const diagnostics = (request.diagnostics ?? [])
    .map((diagnostic) => sanitizeOperatorText(diagnostic))
    .filter((diagnostic) => diagnostic.length > 0);
  let log: AttemptLogWriter;
  try {
    revalidateLaunchTarget(request.target);
    log = new AttemptLogWriter(request.logTarget, request.limits.maxLogBytes);
  } catch (error) {
    diagnostics.push(sanitizeError(error));
    return resultBeforeSpawn(request.logTarget.canonicalPath, observation, diagnostics);
  }

  if (request.signal?.aborted) {
    log.close();
    diagnostics.push('Provider launch was cancelled before spawn');
    return resultBeforeSpawn(request.logTarget.canonicalPath, observation, diagnostics);
  }

  let child: ChildProcess;
  try {
    // Revalidate once more at the actual spawn boundary, after opening the log.
    revalidateLaunchTarget(request.target);
    child = spawn(request.target.executable.canonicalPath, [...request.args], {
      cwd: request.target.cwd.canonicalPath,
      env: buildProviderEnvironment(process.env, request.environmentAllowlist, request.environment),
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    log.close();
    diagnostics.push(sanitizeError(error));
    return resultBeforeSpawn(request.logTarget.canonicalPath, observation, diagnostics);
  }

  const processIdentity = child.pid
    ? { pid: child.pid, processStartIdentity: readProcessStartIdentity(child.pid) }
    : null;
  let launchState: ProviderRunResult['launchState'] = processIdentity ? 'started' : 'not_started';
  let protocolCompromised = false;
  let cancelRequested = false;
  let timedOut = false;
  let cancelling = false;
  const sessionPolicy = asSessionIdPolicy(request.sessionIdPolicy);
  const Decoder = request.stdoutFormat === 'lines' ? TextLineDecoder : JsonLineDecoder;
  const decoder = new Decoder({
    maxLineBytes: request.limits.maxJsonLineBytes,
    maxTotalBytes: request.limits.maxOutputBytes,
  });

  let processing: Promise<void> = Promise.resolve();
  if (processIdentity && callbacks.onProcessStarted) {
    processing = processing.then(() => callbacks.onProcessStarted?.(processIdentity));
  }
  processing = processing.catch((error: unknown) => {
    launchState = 'uncertain';
    protocolCompromised = true;
    diagnostics.push(`Could not persist provider process identity: ${sanitizeError(error)}`);
    requestProcessTreeTermination(child, request.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS);
  });

  child.stdout?.on('data', (chunk: Buffer) => {
    try {
      log.append(chunk);
    } catch (error) {
      markUncertain(`Could not retain provider stdout: ${sanitizeError(error)}`);
    }
    enqueueRecords(decoder.push(chunk));
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    try {
      log.append(chunk);
    } catch (error) {
      markUncertain(`Could not retain provider stderr: ${sanitizeError(error)}`);
    }
    const diagnostic = sanitizeOperatorText(chunk);
    if (diagnostic) diagnostics.push(`Provider stderr: ${diagnostic}`);
  });

  let spawnError: Error | null = null;
  child.once('error', (error) => {
    spawnError = error;
    if (processIdentity) {
      markUncertain(`Provider process error after spawn: ${sanitizeError(error)}`);
    } else {
      diagnostics.push(`Provider failed before spawn: ${sanitizeError(error)}`);
    }
  });

  const abort = (): void => {
    cancelRequested = true;
    if (!cancelling) {
      cancelling = true;
      requestProcessTreeTermination(child, request.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS);
    }
  };
  request.signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    diagnostics.push(`Provider exceeded its ${String(request.timeoutMs)}ms timeout`);
    if (!cancelling) {
      cancelling = true;
      requestProcessTreeTermination(child, request.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS);
    }
  }, request.timeoutMs);
  timeout.unref();

  child.stdin?.on('error', (error) => {
    markUncertain(`Could not write provider prompt after spawn: ${sanitizeError(error)}`);
  });
  child.stdin?.end(request.prompt);

  const exit = await waitForClose(child);
  clearTimeout(timeout);
  request.signal?.removeEventListener('abort', abort);
  enqueueRecords(decoder.finish());
  enqueueStreamFinish();
  await processing;
  const logSnapshot = log.snapshot();
  log.close();
  if (logSnapshot.truncated) {
    protocolCompromised = true;
    diagnostics.push('Provider attempt log reached its byte limit');
  }
  if (spawnError && !processIdentity) launchState = 'not_started';

  const snapshot = observation.snapshot();
  const terminalState = compatibleTerminalState(
    snapshot.terminalProof?.state ?? null,
    exit,
    launchState,
    protocolCompromised,
    diagnostics,
  );
  if (!snapshot.terminalProof) diagnostics.push('Provider exited without terminal proof');
  if (snapshot.events.length === 0)
    diagnostics.push('Provider produced no machine-readable evidence');

  return {
    launchState,
    processIdentity,
    terminalState,
    observation: snapshot,
    exit,
    diagnostics,
    cancelRequested,
    timedOut,
    log: logSnapshot,
  };

  function markUncertain(message: string): void {
    if (processIdentity) launchState = 'uncertain';
    protocolCompromised = true;
    diagnostics.push(message);
    if (!cancelling) {
      cancelling = true;
      requestProcessTreeTermination(child, request.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS);
    }
  }

  function enqueueRecords(records: readonly JsonLineRecord[]): void {
    processing = processing
      .then(() => processRecords(records))
      .catch((error: unknown) => {
        markUncertain(`Could not persist provider evidence: ${sanitizeError(error)}`);
      });
  }

  function enqueueStreamFinish(): void {
    const finishEventStream = request.finishEventStream;
    if (!finishEventStream) return;
    processing = processing
      .then(() => processParsedEvent(finishEventStream()))
      .catch((error: unknown) => {
        markUncertain(`Could not persist provider end-of-stream evidence: ${sanitizeError(error)}`);
      });
  }

  async function processRecords(records: readonly JsonLineRecord[]): Promise<void> {
    for (const record of records) {
      if (record.kind !== 'value') {
        protocolCompromised = true;
        diagnostics.push(record.message);
        continue;
      }
      await processParsedEvent(request.parseEvent(record.value));
    }
  }

  async function processParsedEvent(parsed: ReturnType<typeof request.parseEvent>): Promise<void> {
    if (parsed.kind === 'ignored') return;
    if (parsed.kind === 'malformed') {
      protocolCompromised = true;
      diagnostics.push(sanitizeOperatorText(parsed.message));
      return;
    }
    const events = parsed.kind === 'event' ? [parsed.event] : parsed.events;
    for (const parsedEvent of events) await processEvent(parsedEvent);
  }

  async function processEvent(parsedEvent: ProviderEvidence): Promise<void> {
    let event: ProviderEvidence = parsedEvent;
    if (event.kind === 'session') {
      try {
        event = { ...event, sessionId: sessionPolicy.parse(event.sessionId) };
      } catch (error) {
        protocolCompromised = true;
        diagnostics.push(sanitizeError(error));
        return;
      }
    }
    const outcome = observation.ingest(event);
    if (outcome === 'conflict') {
      protocolCompromised = true;
      diagnostics.push(`Conflicting provider evidence for ${event.eventKey}`);
      return;
    }
    if (outcome !== 'accepted') return;
    if (event.kind === 'session') {
      await callbacks.onSessionIdentity?.({ sessionId: event.sessionId });
    }
    await callbacks.onEvidence?.(event);
  }
}

function validateRequest(request: ProviderLaunchRequest): void {
  for (const [name, value] of Object.entries(request.limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1) {
    throw new Error('Provider timeout must be a positive integer');
  }
  for (const name of [...request.environmentAllowlist, ...Object.keys(request.environment)]) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name.includes('\0')) {
      throw new Error(`Invalid environment variable name: ${name}`);
    }
  }
  for (const value of [...request.args, ...Object.values(request.environment)]) {
    if (value.includes('\0')) throw new Error('Provider argv and environment cannot contain NUL');
  }
}

function pinExistingPath(value: string, kind: 'file' | 'directory'): LaunchFileIdentity {
  const canonicalPath = realpathSync(value);
  const stats = statSync(canonicalPath);
  if ((kind === 'file' && !stats.isFile()) || (kind === 'directory' && !stats.isDirectory())) {
    throw new Error(`Expected ${kind}: ${value}`);
  }
  return {
    canonicalPath,
    device: stats.dev,
    inode: stats.ino,
    mode: stats.mode,
  };
}

function revalidateLaunchTarget(target: ProviderLaunchTarget): void {
  revalidateIdentity(target.executable, 'file');
  accessSync(target.executable.canonicalPath, constants.X_OK);
  revalidateIdentity(target.cwd, 'directory');
}

function revalidateIdentity(identity: LaunchFileIdentity, kind: 'file' | 'directory'): void {
  const current = pinExistingPath(identity.canonicalPath, kind);
  if (
    current.canonicalPath !== identity.canonicalPath ||
    current.device !== identity.device ||
    current.inode !== identity.inode ||
    current.mode !== identity.mode
  ) {
    throw new Error(`Pinned ${kind} changed before provider spawn: ${identity.canonicalPath}`);
  }
}

function readProcessStartIdentity(pid: number): string {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
      const closingParenthesis = stat.lastIndexOf(')');
      const startTicks = stat
        .slice(closingParenthesis + 1)
        .trim()
        .split(/\s+/)[19];
      if (startTicks) return `linux:${startTicks}`;
    } catch {
      // Fall back to the launch instant below.
    }
  }
  if (process.platform === 'darwin' || process.platform === 'freebsd') {
    const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: false,
    });
    const startedAt = result.stdout.trim();
    if (startedAt) return `${process.platform}:${startedAt}`;
  }
  return `pid:${String(pid)}:observed:${String(Date.now())}`;
}

function waitForClose(child: ChildProcess): Promise<ProviderExitEvidence> {
  return new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

function requestProcessTreeTermination(child: ChildProcess, graceMs: number): void {
  const pid = child.pid;
  if (!pid) return;
  sendSignal(child, 'SIGTERM');
  const escalation = setTimeout(
    () => {
      if (child.exitCode === null && child.signalCode === null) sendSignal(child, 'SIGKILL');
    },
    Math.max(1, graceMs),
  );
  escalation.unref();
}

function sendSignal(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    if (process.platform !== 'win32') {
      process.kill(-pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process may already have reached its terminal state.
    }
  }
}

function compatibleTerminalState(
  proof: ProviderTerminalState | null,
  exit: ProviderExitEvidence,
  launchState: ProviderRunResult['launchState'],
  protocolCompromised: boolean,
  diagnostics: string[],
): ProviderTerminalState | 'unproven' {
  if (launchState !== 'started' || protocolCompromised || proof === null) return 'unproven';
  if (proof === 'completed' && (exit.code !== 0 || exit.signal !== null)) {
    diagnostics.push('Provider completion proof was incompatible with its process exit');
    return 'unproven';
  }
  return proof;
}

function sanitizeError(error: unknown): string {
  return sanitizeOperatorText(error instanceof Error ? error.message : String(error));
}

function resultBeforeSpawn(
  logPath: string,
  observation: ProviderObservationAccumulator,
  diagnostics: string[],
): ProviderRunResult {
  return {
    launchState: 'not_started',
    processIdentity: null,
    terminalState: 'unproven',
    observation: observation.snapshot(),
    exit: { code: null, signal: null },
    diagnostics,
    cancelRequested: false,
    timedOut: false,
    log: { path: logPath, bytesWritten: 0, truncated: false },
  };
}
