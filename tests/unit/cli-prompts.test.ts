import { PassThrough, Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  ClackSetupPrompter,
  PlainSetupPrompter,
  PromptCancelledError,
  type ClackBindings,
  type PromptOption,
} from '../../src/cli/prompts.js';

const CANCEL = Symbol('cancel');

function createClackBindings(
  overrides: Partial<ClackBindings> = {},
): ClackBindings & { spinnerInstance: ReturnType<typeof createSpinner> } {
  const spinnerInstance = createSpinner();
  return {
    intro: vi.fn(),
    outro: vi.fn(),
    note: vi.fn(),
    text: vi.fn(() => Promise.resolve('answer')),
    select: vi.fn(() => Promise.resolve('codex')),
    multiselect: vi.fn(() => Promise.resolve(['codex'])),
    confirm: vi.fn(() => Promise.resolve(true)),
    isCancel: (value: unknown) => value === CANCEL,
    spinner: vi.fn(() => spinnerInstance),
    spinnerInstance,
    ...overrides,
  };
}

function createSpinner() {
  return {
    start: vi.fn(),
    message: vi.fn(),
    stop: vi.fn(),
  };
}

function outputText(stream: PassThrough): string {
  const value: unknown = stream.read();
  if (Buffer.isBuffer(value)) return value.toString();
  return typeof value === 'string' ? value : '';
}

const providerOptions: PromptOption<string>[] = [
  { value: 'codex', label: 'Codex', hint: 'Ready' },
  { value: 'claude', label: 'Claude', hint: 'Not found', disabled: true },
  { value: 'cursor', label: 'Cursor', hint: 'Ready' },
];

describe('ClackSetupPrompter', () => {
  it('passes defaults, ordered choices, preselection, disabled hints, and stream ownership through', async () => {
    const bindings = createClackBindings();
    const input = new PassThrough();
    const output = new PassThrough();
    const prompter = new ClackSetupPrompter({ input, output, bindings });

    await expect(prompter.text('Folder', '/notes')).resolves.toBe('answer');
    await expect(prompter.select('Primary', providerOptions, 'cursor')).resolves.toBe('codex');
    await expect(
      prompter.multiselect('Agents', providerOptions, ['codex', 'cursor']),
    ).resolves.toEqual(['codex']);
    await expect(prompter.confirm('Create configuration?', true)).resolves.toBe(true);

    expect(bindings.text).toHaveBeenCalledWith(
      { message: 'Folder', defaultValue: '/notes', placeholder: '/notes' },
      { input, output },
    );
    expect(bindings.select).toHaveBeenCalledWith(
      {
        message: 'Primary',
        options: providerOptions,
        initialValue: 'cursor',
      },
      { input, output },
    );
    expect(bindings.multiselect).toHaveBeenCalledWith(
      {
        message: 'Agents',
        options: providerOptions,
        initialValues: ['codex', 'cursor'],
        required: false,
      },
      { input, output },
    );
    expect(bindings.confirm).toHaveBeenCalledWith(
      { message: 'Create configuration?', initialValue: true },
      { input, output },
    );
  });

  it.each([
    ['text', (prompter: ClackSetupPrompter) => prompter.text('Question')],
    ['select', (prompter: ClackSetupPrompter) => prompter.select('Question', providerOptions)],
    [
      'multiselect',
      (prompter: ClackSetupPrompter) => prompter.multiselect('Question', providerOptions),
    ],
    ['confirm', (prompter: ClackSetupPrompter) => prompter.confirm('Question', true)],
  ])('normalizes cancellation from %s', async (primitive, invoke) => {
    const bindings = createClackBindings({ [primitive]: vi.fn(() => Promise.resolve(CANCEL)) });
    const prompter = new ClackSetupPrompter({ bindings });

    await expect(invoke(prompter)).rejects.toThrow(PromptCancelledError);
  });

  it('sanitizes control characters from every rendered dynamic value', async () => {
    const bindings = createClackBindings();
    const prompter = new ClackSetupPrompter({ bindings });
    const unsafeOptions: PromptOption<string>[] = [
      { value: 'codex', label: 'Co\u001bdex', hint: 'Re\u0007ady' },
    ];

    prompter.intro('sp\u001bool');
    prompter.note('Found\u0007 one\nCodex ready', 'Sta\u001btus');
    await prompter.text('Fol\u0007der', '/tmp/\u001bnotes');
    await prompter.select('Age\u001bnt', unsafeOptions);
    await prompter.multiselect('Age\u0007nts', unsafeOptions, ['codex']);
    await prompter.confirm('Cre\u001bate?', true);
    prompter.outro('Do\u0007ne\nNext step');

    expect(bindings.intro).toHaveBeenCalledWith('spool', expect.anything());
    expect(bindings.note).toHaveBeenCalledWith(
      'Found one\nCodex ready',
      'Status',
      expect.anything(),
    );
    expect(bindings.text).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Folder', defaultValue: '/tmp/notes' }),
      expect.anything(),
    );
    expect(bindings.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Agent',
        options: [{ value: 'codex', label: 'Codex', hint: 'Ready' }],
      }),
      expect.anything(),
    );
    expect(bindings.multiselect).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Agents' }),
      expect.anything(),
    );
    expect(bindings.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Create?' }),
      expect.anything(),
    );
    expect(bindings.outro).toHaveBeenCalledWith('Done\nNext step', expect.anything());
  });

  it('stops progress on success, failure, and cancellation', async () => {
    const successBindings = createClackBindings();
    const successPrompter = new ClackSetupPrompter({ bindings: successBindings });
    await expect(
      successPrompter.progress(
        'Checking',
        (progress) => {
          progress.update('Still checking');
          return Promise.resolve(42);
        },
        'Ready',
      ),
    ).resolves.toBe(42);
    expect(successBindings.spinnerInstance.start).toHaveBeenCalledWith('Checking');
    expect(successBindings.spinnerInstance.message).toHaveBeenCalledWith('Still checking');
    expect(successBindings.spinnerInstance.stop).toHaveBeenCalledOnce();
    expect(successBindings.spinnerInstance.stop).toHaveBeenCalledWith('Ready');

    const failureBindings = createClackBindings();
    const failurePrompter = new ClackSetupPrompter({ bindings: failureBindings });
    await expect(
      failurePrompter.progress('Checking', () => Promise.reject(new Error('offline'))),
    ).rejects.toThrow('offline');
    expect(failureBindings.spinnerInstance.stop).toHaveBeenCalledOnce();
    expect(failureBindings.spinnerInstance.stop).toHaveBeenCalledWith('Failed');

    const cancelBindings = createClackBindings();
    const cancelPrompter = new ClackSetupPrompter({ bindings: cancelBindings });
    await expect(
      cancelPrompter.progress('Checking', () => Promise.reject(new PromptCancelledError())),
    ).rejects.toThrow(PromptCancelledError);
    expect(cancelBindings.spinnerInstance.stop).toHaveBeenCalledOnce();
    expect(cancelBindings.spinnerInstance.stop).toHaveBeenCalledWith('Cancelled');
  });

  it('closes idempotently and refuses prompts after closing', async () => {
    const bindings = createClackBindings();
    const input = new PassThrough();
    const output = new PassThrough();
    const prompter = new ClackSetupPrompter({ input, output, bindings });

    prompter.close();
    prompter.close();

    await expect(prompter.text('Question')).rejects.toThrow('Prompt session is closed');
  });
});

describe('PlainSetupPrompter', () => {
  it('supports the same happy-path primitives with numbered line-oriented choices', async () => {
    const input = Readable.from(['/notes\n3\n1,3\ny\n']);
    const output = new PassThrough();
    const prompter = new PlainSetupPrompter({ input, output });

    prompter.intro('spool setup');
    prompter.note('Detected agents', 'Status');
    await expect(prompter.text('Folder', '/default')).resolves.toBe('/notes');
    await expect(prompter.select('Primary', providerOptions, 'codex')).resolves.toBe('cursor');
    await expect(
      prompter.multiselect('Agents', providerOptions, ['codex', 'cursor']),
    ).resolves.toEqual(['codex', 'cursor']);
    await expect(prompter.confirm('Create configuration?', false)).resolves.toBe(true);
    prompter.outro('Done');
    prompter.close();

    const rendered = outputText(output);
    expect(rendered).toContain('spool setup');
    expect(rendered).toContain('Status: Detected agents');
    expect(rendered).toContain('2) Claude — Not found (unavailable)');
    expect(rendered).toContain('Choose numbers separated by commas [1,3]');
    expect(rendered).toContain('Done');
  });

  it('uses defaults on empty answers and rejects unavailable choices before retrying', async () => {
    const input = Readable.from(['\n2\n1\n\n']);
    const output = new PassThrough();
    const prompter = new PlainSetupPrompter({ input, output });

    await expect(prompter.text('Folder', '/default')).resolves.toBe('/default');
    await expect(prompter.select('Primary', providerOptions, 'codex')).resolves.toBe('codex');
    await expect(prompter.confirm('Continue?', true)).resolves.toBe(true);
    prompter.close();

    expect(outputText(output)).toContain('That choice is unavailable. Try again.');
  });

  it('supports an explicitly empty multiselect and sanitizes output', async () => {
    const input = Readable.from(['none\n']);
    const output = new PassThrough();
    const prompter = new PlainSetupPrompter({ input, output });

    await expect(
      prompter.multiselect('Age\u001bnts', [
        { value: 'codex', label: 'Co\u0007dex', hint: 'Re\u001bady' },
      ]),
    ).resolves.toEqual([]);
    prompter.close();

    const rendered = outputText(output);
    expect(rendered).toContain('Agents');
    expect(rendered).toContain('Codex — Ready');
    expect(rendered).not.toContain('\u001b');
    expect(rendered).not.toContain('\u0007');
  });

  it('preserves multiline notes and outros while sanitizing each line', () => {
    const output = new PassThrough();
    const prompter = new PlainSetupPrompter({ input: Readable.from([]), output });

    prompter.note('Enabled: Co\u001bdex\nUnavailable: Claude', 'Review');
    prompter.outro('Setup complete\nStart spool daemon');
    prompter.close();

    expect(outputText(output)).toContain(
      'Review: Enabled: Codex\nUnavailable: Claude\nSetup complete\nStart spool daemon\n',
    );
  });

  it('keeps the cancellation outcome renderable after input ends', async () => {
    const output = new PassThrough();
    const prompter = new PlainSetupPrompter({ input: Readable.from([]), output });

    await expect(prompter.text('Folder')).rejects.toThrow(PromptCancelledError);
    expect(() => prompter.outro('Setup cancelled. Nothing was written.')).not.toThrow();
    prompter.close();

    expect(outputText(output)).toContain('Setup cancelled. Nothing was written.');
  });

  it('renders progress updates and terminal outcomes for success, failure, and cancellation', async () => {
    const output = new PassThrough();
    const prompter = new PlainSetupPrompter({ input: Readable.from([]), output });

    await expect(
      prompter.progress(
        'Checking\u001b',
        (progress) => {
          progress.update('Found\u0007 Codex');
          return Promise.resolve('ok');
        },
        'Ready\u001b',
      ),
    ).resolves.toBe('ok');
    await expect(
      prompter.progress('Checking', () => Promise.reject(new Error('offline'))),
    ).rejects.toThrow('offline');
    await expect(
      prompter.progress('Checking', () => Promise.reject(new PromptCancelledError())),
    ).rejects.toThrow(PromptCancelledError);
    prompter.close();

    expect(outputText(output)).toContain(
      'Checking…\nFound Codex\nReady\nChecking…\nFailed\nChecking…\nCancelled\n',
    );
  });

  it('closes idempotently and refuses prompts after closing', async () => {
    const prompter = new PlainSetupPrompter({
      input: Readable.from([]),
      output: new PassThrough(),
    });

    prompter.close();
    prompter.close();

    await expect(prompter.text('Question')).rejects.toThrow('Prompt session is closed');
  });
});
