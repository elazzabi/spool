import type { Writable } from 'node:stream';

import type { SpoolConfig } from '../../config/schema.js';
import {
  followOperationalLogs,
  formatOperationalEvent,
  readOperationalLogs,
} from '../../logging/reader.js';

export async function runLogs(
  config: SpoolConfig,
  options: { readonly follow: boolean },
): Promise<void> {
  const abort = new AbortController();
  let brokenPipe = false;
  let outputError: Error | null = null;
  const stop = (): void => abort.abort();
  const onOutputError = (error: Error & { code?: string }): void => {
    if (error.code === 'EPIPE') brokenPipe = true;
    else outputError = error;
    abort.abort();
  };
  process.stdout.on('error', onOutputError);
  try {
    if (!options.follow) {
      const snapshot = await readOperationalLogs(config.stateDirectory);
      for (const warning of snapshot.warnings) process.stderr.write(`Warning: ${warning}\n`);
      if (snapshot.events.length === 0) {
        await writeLine(process.stdout, 'No operational logs found.', abort.signal);
      } else {
        for (const event of snapshot.events) {
          if (brokenPipe) break;
          await writeLine(process.stdout, formatOperationalEvent(event), abort.signal);
        }
      }
    } else {
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      for await (const item of followOperationalLogs({
        stateDirectory: config.stateDirectory,
        signal: abort.signal,
      })) {
        if (item.kind === 'warning') process.stderr.write(`Warning: ${item.message}\n`);
        else await writeLine(process.stdout, formatOperationalEvent(item.event), abort.signal);
      }
    }
  } catch (error) {
    if (!isBrokenPipe(error)) throw error;
  } finally {
    if (options.follow) {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
    process.stdout.off('error', onOutputError);
  }
  if (outputError !== null)
    throw new Error('Operational log output failed', { cause: outputError });
}

function isBrokenPipe(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'EPIPE'
  );
}

function writeLine(output: Writable, line: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      output.off('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const settle = (error?: Error | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onError = (error: Error): void => settle(error);
    const onAbort = (): void => settle();
    output.once('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
    output.write(`${line}\n`, (error) => settle(error));
  });
}
