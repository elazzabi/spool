import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  openSync,
  readSync,
  writeSync,
} from 'node:fs';

import type { LaunchFileIdentity } from './types.js';

const DEFAULT_DIAGNOSTIC_LIMIT = 2_000;

export class AttemptLogWriter {
  readonly path: string;
  readonly #descriptor: number;
  readonly #maxBytes: number;
  #bytesWritten: number;
  #truncated = false;
  #closed = false;

  constructor(logTarget: LaunchFileIdentity, maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new Error('Attempt log byte limit must be a positive integer');
    }
    const noFollow = constants.O_NOFOLLOW ?? 0;
    this.#descriptor = openSync(
      logTarget.canonicalPath,
      constants.O_WRONLY | constants.O_APPEND | noFollow,
      0o600,
    );
    const stats = fstatSync(this.#descriptor);
    if (
      !stats.isFile() ||
      stats.dev !== logTarget.device ||
      stats.ino !== logTarget.inode ||
      stats.mode !== logTarget.mode
    ) {
      closeSync(this.#descriptor);
      throw new Error('Attempt log destination changed after it was persisted');
    }
    fchmodSync(this.#descriptor, 0o600);
    this.path = logTarget.canonicalPath;
    this.#maxBytes = maxBytes;
    this.#bytesWritten = Math.min(stats.size, maxBytes);
    this.#truncated = stats.size > maxBytes;
  }

  append(chunk: Uint8Array): void {
    if (this.#closed || chunk.byteLength === 0) return;
    const remaining = this.#maxBytes - this.#bytesWritten;
    if (remaining <= 0) {
      this.#truncated = true;
      return;
    }
    const accepted = Buffer.from(chunk).subarray(0, remaining);
    let offset = 0;
    while (offset < accepted.length) {
      offset += writeSync(this.#descriptor, accepted, offset, accepted.length - offset);
    }
    this.#bytesWritten += accepted.length;
    if (accepted.length < chunk.byteLength) this.#truncated = true;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    closeSync(this.#descriptor);
  }

  snapshot(): { path: string; bytesWritten: number; truncated: boolean } {
    return {
      path: this.path,
      bytesWritten: this.#bytesWritten,
      truncated: this.#truncated,
    };
  }
}

export type AttemptLogReplay =
  | {
      readonly mode: 'sanitized';
      readonly content: string;
      readonly bytesRead: number;
      readonly truncated: boolean;
    }
  | {
      readonly mode: 'unsafe-raw';
      readonly content: Buffer;
      readonly bytesRead: number;
      readonly truncated: boolean;
      readonly warning: string;
    };

/** Reading evidence never invokes the protocol parser or replays transitions. */
export function replayAttemptLog(
  logTarget: LaunchFileIdentity,
  options: { readonly maxBytes: number; readonly mode?: 'sanitized' | 'unsafe-raw' },
): AttemptLogReplay {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
    throw new Error('Attempt log replay byte limit must be a positive integer');
  }
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const descriptor = openSync(logTarget.canonicalPath, constants.O_RDONLY | noFollow);
  try {
    const stats = fstatSync(descriptor);
    if (
      !stats.isFile() ||
      stats.dev !== logTarget.device ||
      stats.ino !== logTarget.inode ||
      stats.mode !== logTarget.mode
    ) {
      throw new Error('Attempt log destination changed before replay');
    }
    const length = Math.min(stats.size, options.maxBytes);
    const content = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const read = readSync(descriptor, content, offset, length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    const bounded = content.subarray(0, offset);
    const truncated = stats.size > offset;
    if (options.mode === 'unsafe-raw') {
      return {
        mode: 'unsafe-raw',
        content: bounded,
        bytesRead: offset,
        truncated,
        warning: 'Unsafe raw provider output may contain active terminal control sequences',
      };
    }
    return {
      mode: 'sanitized',
      content: sanitizeOperatorText(bounded),
      bytesRead: offset,
      truncated,
    };
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Make terminal diagnostics inert while retaining visible evidence of every
 * control. Raw bytes remain available in the owner-only attempt log.
 */
export function sanitizeOperatorText(
  value: string | Uint8Array,
  maxCharacters = DEFAULT_DIAGNOSTIC_LIMIT,
): string {
  const source =
    typeof value === 'string'
      ? value
      : new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(value);
  let rendered = '';
  for (const character of source) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (character === '\n' || character === '\t') {
      rendered += character;
    } else if (isUnsafeCodePoint(codePoint)) {
      rendered += `\\u{${codePoint.toString(16).toUpperCase().padStart(4, '0')}}`;
    } else if (character === '\ufffd') {
      rendered += '\\u{FFFD}';
    } else {
      rendered += character;
    }
    if (rendered.length >= maxCharacters) {
      return `${rendered.slice(0, maxCharacters)}…`;
    }
  }
  return rendered;
}

function isUnsafeCodePoint(codePoint: number): boolean {
  return (
    codePoint < 0x20 ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069) ||
    codePoint === 0x061c ||
    codePoint === 0x200e ||
    codePoint === 0x200f
  );
}
