import { TextDecoder } from 'node:util';

export type JsonLineRecord =
  | { readonly kind: 'value'; readonly value: unknown }
  | { readonly kind: 'malformed'; readonly message: string }
  | { readonly kind: 'truncated'; readonly message: string };

export interface JsonLineDecoderOptions {
  readonly maxLineBytes: number;
  readonly maxTotalBytes: number;
}

/**
 * Incremental, byte-bounded JSONL decoder. It never substitutes invalid UTF-8
 * into protocol data and continues draining input after its evidence budget.
 */
export class JsonLineDecoder {
  readonly #maxLineBytes: number;
  readonly #maxTotalBytes: number;
  #buffer = Buffer.alloc(0);
  #totalBytes = 0;
  #discardingLongLine = false;
  #truncated = false;

  constructor(options: JsonLineDecoderOptions) {
    if (options.maxLineBytes < 1 || options.maxTotalBytes < 1) {
      throw new Error('JSONL byte limits must be positive');
    }
    this.#maxLineBytes = options.maxLineBytes;
    this.#maxTotalBytes = options.maxTotalBytes;
  }

  push(chunk: Uint8Array): JsonLineRecord[] {
    const records: JsonLineRecord[] = [];
    if (chunk.byteLength === 0) return records;

    const remaining = this.#maxTotalBytes - this.#totalBytes;
    if (remaining <= 0) {
      this.#emitTruncation(records, 'Provider stdout exceeded its evidence byte limit');
      return records;
    }

    const accepted = Buffer.from(chunk).subarray(0, remaining);
    this.#totalBytes += accepted.byteLength;
    if (accepted.byteLength < chunk.byteLength) {
      this.#emitTruncation(records, 'Provider stdout exceeded its evidence byte limit');
    }

    let start = 0;
    for (let index = 0; index < accepted.length; index += 1) {
      if (accepted[index] !== 0x0a) continue;
      const segment = accepted.subarray(start, index);
      start = index + 1;
      this.#acceptSegment(segment, true, records);
    }
    if (start < accepted.length) this.#acceptSegment(accepted.subarray(start), false, records);
    return records;
  }

  finish(): JsonLineRecord[] {
    const records: JsonLineRecord[] = [];
    if (this.#discardingLongLine) {
      this.#discardingLongLine = false;
      this.#buffer = Buffer.alloc(0);
      return records;
    }
    if (this.#buffer.length > 0) {
      this.#decodeLine(this.#buffer, records);
      this.#buffer = Buffer.alloc(0);
    }
    return records;
  }

  #acceptSegment(segment: Buffer, ended: boolean, records: JsonLineRecord[]): void {
    if (this.#discardingLongLine) {
      if (ended) this.#discardingLongLine = false;
      return;
    }

    if (this.#buffer.length + segment.length > this.#maxLineBytes) {
      this.#buffer = Buffer.alloc(0);
      this.#discardingLongLine = !ended;
      records.push({
        kind: 'malformed',
        message: `Provider JSONL line exceeded ${String(this.#maxLineBytes)} bytes`,
      });
      return;
    }

    this.#buffer = Buffer.concat([this.#buffer, segment]);
    if (ended) {
      const line = this.#buffer.at(-1) === 0x0d ? this.#buffer.subarray(0, -1) : this.#buffer;
      this.#buffer = Buffer.alloc(0);
      if (line.length > 0) this.#decodeLine(line, records);
    }
  }

  #decodeLine(line: Buffer, records: JsonLineRecord[]): void {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(line);
    } catch {
      records.push({ kind: 'malformed', message: 'Provider JSONL contained invalid UTF-8' });
      return;
    }
    try {
      records.push({ kind: 'value', value: JSON.parse(text) as unknown });
    } catch {
      records.push({ kind: 'malformed', message: 'Provider emitted malformed JSONL' });
    }
  }

  #emitTruncation(records: JsonLineRecord[], message: string): void {
    if (this.#truncated) return;
    this.#truncated = true;
    records.push({ kind: 'truncated', message });
  }
}

/** Incremental bounded UTF-8 line decoder for a strict text-line protocol. */
export class TextLineDecoder {
  readonly #maxLineBytes: number;
  readonly #maxTotalBytes: number;
  #buffer = Buffer.alloc(0);
  #totalBytes = 0;
  #discardingLongLine = false;
  #truncated = false;

  constructor(options: JsonLineDecoderOptions) {
    if (options.maxLineBytes < 1 || options.maxTotalBytes < 1) {
      throw new Error('Line byte limits must be positive');
    }
    this.#maxLineBytes = options.maxLineBytes;
    this.#maxTotalBytes = options.maxTotalBytes;
  }

  push(chunk: Uint8Array): JsonLineRecord[] {
    const records: JsonLineRecord[] = [];
    if (chunk.byteLength === 0) return records;
    const remaining = this.#maxTotalBytes - this.#totalBytes;
    if (remaining <= 0) {
      this.#emitTruncation(records);
      return records;
    }
    const accepted = Buffer.from(chunk).subarray(0, remaining);
    this.#totalBytes += accepted.byteLength;
    if (accepted.byteLength < chunk.byteLength) this.#emitTruncation(records);

    let start = 0;
    for (let index = 0; index < accepted.length; index += 1) {
      if (accepted[index] !== 0x0a) continue;
      this.#acceptSegment(accepted.subarray(start, index), true, records);
      start = index + 1;
    }
    if (start < accepted.length) this.#acceptSegment(accepted.subarray(start), false, records);
    return records;
  }

  finish(): JsonLineRecord[] {
    const records: JsonLineRecord[] = [];
    if (this.#discardingLongLine) {
      this.#discardingLongLine = false;
      this.#buffer = Buffer.alloc(0);
      return records;
    }
    if (this.#buffer.length > 0) {
      this.#decodeLine(this.#buffer, records);
      this.#buffer = Buffer.alloc(0);
    }
    return records;
  }

  #acceptSegment(segment: Buffer, ended: boolean, records: JsonLineRecord[]): void {
    if (this.#discardingLongLine) {
      if (ended) this.#discardingLongLine = false;
      return;
    }
    if (this.#buffer.length + segment.length > this.#maxLineBytes) {
      this.#buffer = Buffer.alloc(0);
      this.#discardingLongLine = !ended;
      records.push({
        kind: 'malformed',
        message: `Provider text line exceeded ${String(this.#maxLineBytes)} bytes`,
      });
      return;
    }
    this.#buffer = Buffer.concat([this.#buffer, segment]);
    if (!ended) return;
    const line = this.#buffer.at(-1) === 0x0d ? this.#buffer.subarray(0, -1) : this.#buffer;
    this.#buffer = Buffer.alloc(0);
    if (line.length > 0) this.#decodeLine(line, records);
  }

  #decodeLine(line: Buffer, records: JsonLineRecord[]): void {
    try {
      records.push({
        kind: 'value',
        value: new TextDecoder('utf-8', { fatal: true }).decode(line),
      });
    } catch {
      records.push({ kind: 'malformed', message: 'Provider text output contained invalid UTF-8' });
    }
  }

  #emitTruncation(records: JsonLineRecord[]): void {
    if (this.#truncated) return;
    this.#truncated = true;
    records.push({
      kind: 'truncated',
      message: 'Provider stdout exceeded its evidence byte limit',
    });
  }
}
