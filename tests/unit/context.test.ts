import { describe, expect, it } from 'vitest';

import { compilePromptContext } from '../../src/notes/context.js';
import { scanNote } from '../../src/notes/parse.js';

describe('compilePromptContext', () => {
  it('uses a direct PR before an ancestor PR and labels every source', () => {
    const source = [
      '## Wednesday',
      '- Parent https://github.com/acme/parent/pull/1',
      '  - [ ] @claude review https://github.com/acme/direct/pull/2 carefully',
    ].join('\n');
    const directive = scanNote(source, { providers: { claude: '@claude' } }).directives[0];

    expect(directive).toBeDefined();
    expect(directive?.context.pr?.provenance).toBe('direct');
    expect(compilePromptContext(directive!)).toBe(
      [
        'Day (heading): Wednesday',
        'Ancestor (list): Parent https://github.com/acme/parent/pull/1',
        'PR (direct): https://github.com/acme/direct/pull/2',
        'Repository (direct): acme/direct',
        'Instruction (direct): review https://github.com/acme/direct/pull/2 carefully',
      ].join('\n'),
    );
  });

  it('includes repository context without inventing pull-request context', () => {
    const source = '- [ ] Update README https://github.com/elazzabi/spool @codex';
    const directive = scanNote(source, { providers: { codex: '@codex' } }).directives[0];

    expect(directive).toBeDefined();
    expect(compilePromptContext(directive!)).toBe(
      [
        'Repository (direct): elazzabi/spool',
        'Instruction (direct): Update README https://github.com/elazzabi/spool',
      ].join('\n'),
    );
  });

  it('renders only the canonical repository identity resolved from an alias', () => {
    const directive = scanNote('- WooPayments\n  - [ ] @codex reconcile the ledger', {
      providers: { codex: '@codex' },
      repositoryAliases: new Map([['woopayments', 'automattic/woocommerce-payments']]),
    }).directives[0];

    expect(directive).toBeDefined();
    expect(compilePromptContext(directive!)).toBe(
      [
        'Ancestor (list): WooPayments',
        'Repository (ancestor): automattic/woocommerce-payments',
        'Instruction (direct): reconcile the ledger',
      ].join('\n'),
    );
  });
});
