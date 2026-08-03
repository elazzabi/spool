import { stdout } from 'node:process';
import type { Writable } from 'node:stream';

import * as clack from '@clack/prompts';

import { sanitizeTerminalText } from '../terminal.js';
import { isDefaultConfigPath } from '../config/paths.js';
import type { SpoolConfig } from '../config/schema.js';

export { sanitizeTerminalText } from '../terminal.js';

export interface StaticCliPresenter {
  intro(message: string): void;
  outro(message: string): void;
  section(title: string, lines: readonly string[]): void;
  info(message: string): void;
  success(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface StaticCliBindings {
  intro(message: string, output: Writable): void;
  outro(message: string, output: Writable): void;
  section(title: string, lines: readonly string[], output: Writable): void;
  info(message: string, output: Writable): void;
  success(message: string, output: Writable): void;
  warn(message: string, output: Writable): void;
  error(message: string, output: Writable): void;
}

const defaultStaticCliBindings: StaticCliBindings = {
  intro: (message, output) => clack.intro(message, { output }),
  outro: (message, output) => clack.outro(message, { output }),
  section: (title, lines, output) => clack.note(lines.join('\n'), title, { output }),
  info: (message, output) => clack.log.info(message, { output }),
  success: (message, output) => clack.log.success(message, { output }),
  warn: (message, output) => clack.log.warn(message, { output }),
  error: (message, output) => clack.log.error(message, { output }),
};

const asciiStaticCliBindings: StaticCliBindings = {
  intro: (message, output) => output.write(`${message}\n`),
  outro: (message, output) => output.write(`${message}\n`),
  section: (title, lines, output) => output.write(`${title}\n${lines.join('\n')}\n`),
  info: (message, output) => output.write(`[i] ${message}\n`),
  success: (message, output) => output.write(`[ok] ${message}\n`),
  warn: (message, output) => output.write(`[!] ${message}\n`),
  error: (message, output) => output.write(`[x] ${message}\n`),
};

/**
 * Presents already-sanitized, already-redacted static CLI report content.
 * Callers retain ownership of preparing dynamic values before invoking it.
 */
export class ClackStaticCliPresenter implements StaticCliPresenter {
  readonly #output: Writable;
  readonly #bindings: StaticCliBindings;

  constructor(
    options: {
      output?: Writable;
      bindings?: StaticCliBindings;
      unicode?: boolean;
    } = {},
  ) {
    this.#output = options.output ?? stdout;
    this.#bindings =
      options.bindings ??
      ((options.unicode ?? clack.unicode) ? defaultStaticCliBindings : asciiStaticCliBindings);
  }

  intro(message: string): void {
    this.#bindings.intro(message, this.#output);
  }

  outro(message: string): void {
    this.#bindings.outro(message, this.#output);
  }

  section(title: string, lines: readonly string[]): void {
    this.#bindings.section(title, lines, this.#output);
  }

  info(message: string): void {
    this.#bindings.info(message, this.#output);
  }

  success(message: string): void {
    this.#bindings.success(message, this.#output);
  }

  warn(message: string): void {
    this.#bindings.warn(message, this.#output);
  }

  error(message: string): void {
    this.#bindings.error(message, this.#output);
  }
}

export function renderShellCommand(
  argv: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string {
  return argv
    .map((argument) => renderShellArgument(sanitizeTerminalText(argument), platform))
    .join(' ');
}

export function spoolArgv(config: Pick<SpoolConfig, 'configPath'>, ...args: string[]): string[] {
  if (isDefaultConfigPath(config.configPath)) {
    return ['spool', ...args];
  }
  return ['spool', '--config', config.configPath, ...args];
}

function renderShellArgument(value: string, platform: NodeJS.Platform): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  if (platform === 'win32') return `'${value.replaceAll("'", "''")}'`;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
