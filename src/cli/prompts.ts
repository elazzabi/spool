import { createInterface, type Interface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import type { Readable, Writable } from 'node:stream';

import * as clack from '@clack/prompts';

import { sanitizeTerminalText } from '../terminal.js';

export class PromptCancelledError extends Error {
  override readonly name = 'PromptCancelledError';

  constructor() {
    super('Setup cancelled');
  }
}

export interface PromptOption<Value extends string = string> {
  value: Value;
  label: string;
  hint?: string;
  disabled?: boolean;
}

export interface PromptProgress {
  update(message: string): void;
}

export interface SetupPrompter {
  intro(message: string): void;
  outro(message: string): void;
  note(message: string, title?: string): void;
  text(message: string, defaultValue?: string): Promise<string>;
  select<Value extends string>(
    message: string,
    options: readonly PromptOption<Value>[],
    initialValue?: Value,
  ): Promise<Value>;
  multiselect<Value extends string>(
    message: string,
    options: readonly PromptOption<Value>[],
    initialValues?: readonly Value[],
  ): Promise<Value[]>;
  confirm(message: string, initialValue: boolean): Promise<boolean>;
  progress<Result>(
    message: string,
    task: (progress: PromptProgress) => Promise<Result>,
    successMessage?: string,
  ): Promise<Result>;
  close(): void;
}

interface PromptStreams {
  input: Readable;
  output: Writable;
}

interface SpinnerBinding {
  start: (message?: string) => void;
  message: (message?: string) => void;
  stop: (message?: string) => void;
}

export interface ClackBindings {
  intro: (message: string, streams: PromptStreams) => void;
  outro: (message: string, streams: PromptStreams) => void;
  note: (message: string, title: string | undefined, streams: PromptStreams) => void;
  text: (
    options: { message: string; defaultValue?: string; placeholder?: string },
    streams: PromptStreams,
  ) => Promise<unknown>;
  select: (
    options: {
      message: string;
      options: PromptOption[];
      initialValue?: string;
    },
    streams: PromptStreams,
  ) => Promise<unknown>;
  multiselect: (
    options: {
      message: string;
      options: PromptOption[];
      initialValues?: string[];
      required: boolean;
    },
    streams: PromptStreams,
  ) => Promise<unknown>;
  confirm: (
    options: { message: string; initialValue: boolean },
    streams: PromptStreams,
  ) => Promise<unknown>;
  isCancel: (value: unknown) => boolean;
  spinner: (streams: PromptStreams) => SpinnerBinding;
}

const defaultClackBindings: ClackBindings = {
  intro: (message, streams) => clack.intro(message, streams),
  outro: (message, streams) => clack.outro(message, streams),
  note: (message, title, streams) => clack.note(message, title, streams),
  text: (options, streams) => clack.text({ ...options, ...streams }),
  select: (options, streams) => clack.select({ ...options, ...streams }),
  multiselect: (options, streams) => clack.multiselect({ ...options, ...streams }),
  confirm: (options, streams) => clack.confirm({ ...options, ...streams }),
  isCancel: clack.isCancel,
  spinner: (streams) => clack.spinner(streams),
};

export class ClackSetupPrompter implements SetupPrompter {
  readonly #streams: PromptStreams;
  readonly #bindings: ClackBindings;
  #closed = false;

  constructor(
    options: {
      input?: Readable;
      output?: Writable;
      bindings?: ClackBindings;
    } = {},
  ) {
    this.#streams = {
      input: options.input ?? stdin,
      output: options.output ?? stdout,
    };
    this.#bindings = options.bindings ?? defaultClackBindings;
  }

  intro(message: string): void {
    this.#assertOpen();
    this.#bindings.intro(clean(message), this.#streams);
  }

  outro(message: string): void {
    this.#assertOpen();
    this.#bindings.outro(cleanBlock(message), this.#streams);
  }

  note(message: string, title?: string): void {
    this.#assertOpen();
    this.#bindings.note(
      cleanBlock(message),
      title === undefined ? undefined : clean(title),
      this.#streams,
    );
  }

  async text(message: string, defaultValue?: string): Promise<string> {
    this.#assertOpen();
    const cleanedDefault = defaultValue === undefined ? undefined : clean(defaultValue);
    const result = await this.#bindings.text(
      {
        message: clean(message),
        ...(cleanedDefault === undefined
          ? {}
          : { defaultValue: cleanedDefault, placeholder: cleanedDefault }),
      },
      this.#streams,
    );
    return this.#valueOrCancel<string>(result);
  }

  async select<Value extends string>(
    message: string,
    options: readonly PromptOption<Value>[],
    initialValue?: Value,
  ): Promise<Value> {
    this.#assertOpen();
    const result = await this.#bindings.select(
      {
        message: clean(message),
        options: cleanOptions(options),
        ...(initialValue === undefined ? {} : { initialValue }),
      },
      this.#streams,
    );
    return this.#valueOrCancel<Value>(result);
  }

  async multiselect<Value extends string>(
    message: string,
    options: readonly PromptOption<Value>[],
    initialValues: readonly Value[] = [],
  ): Promise<Value[]> {
    this.#assertOpen();
    const result = await this.#bindings.multiselect(
      {
        message: clean(message),
        options: cleanOptions(options),
        initialValues: [...initialValues],
        required: false,
      },
      this.#streams,
    );
    return this.#valueOrCancel<Value[]>(result);
  }

  async confirm(message: string, initialValue: boolean): Promise<boolean> {
    this.#assertOpen();
    const result = await this.#bindings.confirm(
      { message: clean(message), initialValue },
      this.#streams,
    );
    return this.#valueOrCancel<boolean>(result);
  }

  async progress<Result>(
    message: string,
    task: (progress: PromptProgress) => Promise<Result>,
    successMessage = 'Done',
  ): Promise<Result> {
    this.#assertOpen();
    const spinner = this.#bindings.spinner(this.#streams);
    spinner.start(clean(message));
    try {
      const result = await task({ update: (update) => spinner.message(clean(update)) });
      spinner.stop(clean(successMessage));
      return result;
    } catch (error) {
      spinner.stop(error instanceof PromptCancelledError ? 'Cancelled' : 'Failed');
      throw error;
    }
  }

  close(): void {
    this.#closed = true;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('Prompt session is closed');
  }

  #valueOrCancel<Value>(value: unknown): Value {
    if (this.#bindings.isCancel(value)) throw new PromptCancelledError();
    return value as Value;
  }
}

export class PlainSetupPrompter implements SetupPrompter {
  readonly #output: Writable;
  readonly #lines: AsyncIterator<string>;
  readonly #interface: Interface;
  readonly #processSigint: (() => void) | undefined;
  #closed = false;

  constructor(options: { input?: Readable; output?: Writable } = {}) {
    const input = options.input ?? stdin;
    this.#output = options.output ?? stdout;
    this.#interface = createInterface({ input, crlfDelay: Infinity });
    this.#lines = this.#interface[Symbol.asyncIterator]();
    const cancelInput = () => this.#interface.close();
    this.#interface.once('SIGINT', cancelInput);
    this.#processSigint = input === stdin ? cancelInput : undefined;
    if (this.#processSigint) process.once('SIGINT', this.#processSigint);
  }

  intro(message: string): void {
    this.#assertOpen();
    this.#write(`${clean(message)}\n\n`);
  }

  outro(message: string): void {
    this.#assertOpen();
    this.#write(`${cleanBlock(message)}\n`);
  }

  note(message: string, title?: string): void {
    this.#assertOpen();
    this.#write(`${title === undefined ? '' : `${clean(title)}: `}${cleanBlock(message)}\n`);
  }

  async text(message: string, defaultValue?: string): Promise<string> {
    const answer = await this.#ask(
      `${clean(message)}${defaultValue === undefined ? '' : ` [${clean(defaultValue)}]`}: `,
    );
    return answer || defaultValue || '';
  }

  async select<Value extends string>(
    message: string,
    options: readonly PromptOption<Value>[],
    initialValue?: Value,
  ): Promise<Value> {
    const defaultIndex = options.findIndex((option) => option.value === initialValue);
    while (true) {
      this.#renderOptions(message, options);
      const suffix = defaultIndex < 0 ? '' : ` [${defaultIndex + 1}]`;
      const answer = await this.#ask(`Choose one${suffix}: `);
      const index = answer === '' ? defaultIndex : parseChoice(answer, options.length);
      const option = index < 0 ? undefined : options[index];
      if (!option) {
        this.#write('Choose one of the listed numbers. Try again.\n');
      } else if (option.disabled) {
        this.#write('That choice is unavailable. Try again.\n');
      } else {
        return option.value;
      }
    }
  }

  async multiselect<Value extends string>(
    message: string,
    options: readonly PromptOption<Value>[],
    initialValues: readonly Value[] = [],
  ): Promise<Value[]> {
    const defaultIndexes = options.flatMap((option, index) =>
      initialValues.includes(option.value) && !option.disabled ? [index + 1] : [],
    );
    while (true) {
      this.#renderOptions(message, options);
      const defaultLabel = defaultIndexes.join(',');
      const answer = await this.#ask(
        `Choose numbers separated by commas${defaultLabel ? ` [${defaultLabel}]` : ''} (or none): `,
      );
      if (answer.trim().toLowerCase() === 'none') return [];
      const values = answer === '' ? defaultIndexes : parseChoices(answer, options.length);
      if (!values) {
        this.#write('Choose listed numbers separated by commas, or none. Try again.\n');
        continue;
      }
      const selected = values.map((index) => options[index - 1]);
      if (selected.some((option) => option?.disabled)) {
        this.#write('That choice is unavailable. Try again.\n');
        continue;
      }
      return selected.flatMap((option) => (option ? [option.value] : []));
    }
  }

  async confirm(message: string, initialValue: boolean): Promise<boolean> {
    while (true) {
      const answer = (
        await this.#ask(`${clean(message)} ${initialValue ? '[Y/n]' : '[y/N]'}: `)
      ).toLowerCase();
      if (!answer) return initialValue;
      if (answer === 'y' || answer === 'yes') return true;
      if (answer === 'n' || answer === 'no') return false;
      this.#write('Please answer yes or no.\n');
    }
  }

  async progress<Result>(
    message: string,
    task: (progress: PromptProgress) => Promise<Result>,
    successMessage = 'Done',
  ): Promise<Result> {
    this.#assertOpen();
    this.#write(`${clean(message)}…\n`);
    try {
      const result = await task({ update: (update) => this.#write(`${clean(update)}\n`) });
      this.#write(`${clean(successMessage)}\n`);
      return result;
    } catch (error) {
      this.#write(`${error instanceof PromptCancelledError ? 'Cancelled' : 'Failed'}\n`);
      throw error;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#processSigint) process.off('SIGINT', this.#processSigint);
    this.#interface.close();
  }

  async #ask(prompt: string): Promise<string> {
    this.#assertOpen();
    this.#write(prompt);
    const next = await this.#lines.next();
    if (next.done) {
      throw new PromptCancelledError();
    }
    return next.value.trim();
  }

  #renderOptions<Value extends string>(
    message: string,
    options: readonly PromptOption<Value>[],
  ): void {
    this.#assertOpen();
    this.#write(`${clean(message)}\n`);
    options.forEach((option, index) => {
      const hint = option.hint ? ` — ${clean(option.hint)}` : '';
      const disabled = option.disabled ? ' (unavailable)' : '';
      this.#write(`  ${index + 1}) ${clean(option.label)}${hint}${disabled}\n`);
    });
  }

  #write(value: string): void {
    this.#output.write(value);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('Prompt session is closed');
  }
}

function clean(value: string): string {
  return sanitizeTerminalText(value);
}

function cleanBlock(value: string): string {
  return value
    .split(/\r\n?|\n/)
    .map(clean)
    .join('\n');
}

function cleanOptions<Value extends string>(
  options: readonly PromptOption<Value>[],
): PromptOption<Value>[] {
  return options.map((option) => ({
    value: option.value,
    label: clean(option.label),
    ...(option.hint === undefined ? {} : { hint: clean(option.hint) }),
    ...(option.disabled === undefined ? {} : { disabled: option.disabled }),
  }));
}

function parseChoice(answer: string, length: number): number {
  if (!/^\d+$/.test(answer)) return -1;
  const index = Number(answer) - 1;
  return index >= 0 && index < length ? index : -1;
}

function parseChoices(answer: string, length: number): number[] | undefined {
  const parts = answer
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0 || parts.some((part) => !/^\d+$/.test(part))) return undefined;
  const values = [...new Set(parts.map(Number))];
  return values.every((value) => value >= 1 && value <= length) ? values : undefined;
}
