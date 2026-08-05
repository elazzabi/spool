import { describe, expect, it } from 'vitest';

import { applyTextPatches } from '../../src/notes/patch.js';
import { planIdentityBootstrap } from '../../src/notes/identity.js';
import { scanNote } from '../../src/notes/parse.js';

const providers = { claude: '@claude', codex: '@codex' };

describe('scanNote', () => {
  it('discovers only unchecked provider task items and preserves unrelated source', () => {
    const source = [
      '# Week 29',
      '',
      '## Monday',
      '- [ ] Buy milk',
      '- prose mentioning @claude is not work',
      '- [x] @claude already done',
      '```md',
      '- [ ] @claude fenced example',
      '<!-- spool:task id="fenced" anchor="spool-fenced" -->',
      '```',
      '- [ ] @claude first task',
      '- [ ] @claude second task',
      '',
      '## Tuesday',
      '- [ ] ordinary task',
      '',
    ].join('\n');

    const scan = scanNote(source, { providers });

    expect(scan.directives.map((directive) => directive.directiveText)).toEqual([
      'first task',
      'second task',
    ]);
    expect(scan.directives.every((directive) => directive.dayHeading === 'Monday')).toBe(true);
    expect(scan.source).toBe(source);
  });

  it('treats a trailing provider directive as an explicit dispatch action', () => {
    const source = [
      '## Monday',
      '- [ ] Write the complete requirement before dispatching @claude',
      '- [ ] Review https://github.com/acme/widgets/pull/42 @codex   ',
      '- [ ] Can @claude help with this someday?',
      '- [ ] Review issue@claude',
      '- [ ] Review @claude-not-a-directive',
      '- [ ] @claude leading syntax still works',
      '- [x] Already completed @claude',
      '- [ ] @claude leading remains authoritative @codex',
    ].join('\n');

    const scan = scanNote(source, { providers });

    expect(
      scan.directives.map(({ provider, directiveText }) => ({ provider, directiveText })),
    ).toEqual([
      {
        provider: 'claude',
        directiveText: 'Write the complete requirement before dispatching',
      },
      {
        provider: 'codex',
        directiveText: 'Review https://github.com/acme/widgets/pull/42',
      },
      { provider: 'claude', directiveText: 'leading syntax still works' },
      { provider: 'claude', directiveText: 'leading remains authoritative @codex' },
    ]);
    expect(scan.directives[1]?.context.pr).toEqual({
      provenance: 'direct',
      repository: 'acme/widgets',
      url: 'https://github.com/acme/widgets/pull/42',
    });
    expect(scan.directives[1]?.context.repository).toEqual({
      provenance: 'direct',
      repository: 'acme/widgets',
    });
  });

  it('bootstraps and rescans trailing directives without changing their instruction text', () => {
    const source = '## Monday\n- [ ] Finish writing first @claude\n';
    const initial = scanNote(source, { providers });
    const next = applyTextPatches(
      source,
      planIdentityBootstrap(initial, () => 'trailing-task'),
      initial.sourceHash,
    );
    const [rescanned] = scanNote(next, { providers }).directives;

    expect(next).toContain('- [ ] Finish writing first @claude\n  ```spool');
    expect(rescanned?.taskId).toBe('trailing-task');
    expect(rescanned?.provider).toBe('claude');
    expect(rescanned?.directiveText).toBe('Finish writing first');
  });

  it('inherits a PR only from the direct list ancestry and records provenance', () => {
    const source = [
      '## Monday',
      '- PR https://github.com/acme/widgets/pull/42',
      '  - [ ] @claude review this PR',
      '  - [ ] unrelated sibling',
      '- https://github.com/other/repo/pull/9',
      '  - [ ] @codex another branch',
      '## Tuesday',
      '- [ ] @claude review this',
    ].join('\n');

    const [nested, otherDay] = scanNote(source, { providers }).directives.filter(
      (directive) => directive.provider === 'claude',
    );

    expect(nested?.context.pr).toEqual({
      provenance: 'ancestor',
      repository: 'acme/widgets',
      url: 'https://github.com/acme/widgets/pull/42',
    });
    expect(nested?.context.repository).toEqual({
      provenance: 'ancestor',
      repository: 'acme/widgets',
    });
    expect(nested?.context.ancestors).toEqual(['PR https://github.com/acme/widgets/pull/42']);
    expect(nested?.context.dayHeading).toBe('Monday');
    expect(nested?.context.ancestors.join(' ')).not.toContain('unrelated sibling');
    expect(otherDay?.context.pr).toBeUndefined();
    expect(otherDay?.context.dayHeading).toBe('Tuesday');
  });

  it('selects direct and ancestor GitHub repositories without requiring pull requests', () => {
    const source = [
      '## Monday',
      '- Repository https://github.com/acme/widgets',
      '  - [ ] @claude update the documentation',
      '- [ ] Check https://github.com/Acme/Direct.git @codex',
    ].join('\n');

    const [inherited, direct] = scanNote(source, { providers }).directives;

    expect(inherited?.context.repository).toEqual({
      provenance: 'ancestor',
      repository: 'acme/widgets',
    });
    expect(inherited?.context.pr).toBeUndefined();
    expect(direct?.context.repository).toEqual({
      provenance: 'direct',
      repository: 'acme/direct',
    });
    expect(direct?.context.pr).toBeUndefined();
  });

  it('prefers an explicitly scoped repository over a direct reference repository', () => {
    const source = [
      '- Repository https://github.com/elazzabi/spool',
      '  - [x] Add support for `config repository add` to add git repositories',
      '  - [ ] I want a README closer to the OpenClaw reference (https://github.com/openclaw/openclaw) @codex',
    ].join('\n');

    const [directive] = scanNote(source, { providers }).directives;

    expect(directive?.context.repository).toEqual({
      provenance: 'ancestor',
      repository: 'elazzabi/spool',
    });
    expect(directive?.context.pr).toBeUndefined();
  });

  it('prefers pull-request context over an earlier repository URL in the same text', () => {
    const source = [
      '- Compare https://github.com/acme/widgets with https://github.com/acme/widgets/pull/42',
      '  - [ ] @claude review the pull request',
      '- [ ] Review https://github.com/acme/widgets before https://github.com/acme/widgets/pull/43 @codex',
    ].join('\n');

    const [inherited, direct] = scanNote(source, { providers }).directives;

    expect(inherited?.context.pr).toEqual({
      provenance: 'ancestor',
      repository: 'acme/widgets',
      url: 'https://github.com/acme/widgets/pull/42',
    });
    expect(direct?.context.pr).toEqual({
      provenance: 'direct',
      repository: 'acme/widgets',
      url: 'https://github.com/acme/widgets/pull/43',
    });
  });

  it('resolves only an exact rendered outermost repository alias', () => {
    const repositoryAliases = new Map([['woopayments', 'automattic/woocommerce-payments']]);
    const source = [
      '- **WooPayments**',
      '  - [ ] @claude emphasized alias',
      '- `WOOPAYMENTS`',
      '  - [ ] @claude inline-code alias',
      '- [WooPayments](https://example.com/projects/payments)',
      '  - [ ] @claude linked alias',
      '- [ ] WooPayments',
      '  - [ ] @claude checkbox alias',
    ].join('\n');

    const directives = scanNote(source, { providers, repositoryAliases }).directives;

    expect(directives).toHaveLength(4);
    for (const directive of directives) {
      expect(directive.context.repository).toEqual({
        provenance: 'ancestor',
        repository: 'automattic/woocommerce-payments',
      });
      expect(directive.context.pr).toBeUndefined();
    }
    expect(directives.map((directive) => directive.context.ancestors[0])).toEqual([
      'WooPayments',
      'WOOPAYMENTS',
      'WooPayments',
      'WooPayments',
    ]);
  });

  it('does not resolve aliases from partial, decorated, direct, or nested text', () => {
    const repositoryAliases = new Map([['woopayments', 'automattic/woocommerce-payments']]);
    const source = [
      '- unknown',
      '  - [ ] @claude woopayments in directive prose',
      '- woo',
      '  - [ ] @claude partial',
      '- Project: woopayments',
      '  - [ ] @claude prefixed',
      '- woopayments project',
      '  - [ ] @claude suffixed',
      '- another-project',
      '  - woopayments',
      '    - [ ] @claude nested ancestor',
      '- ![](https://example.com/icon.png)',
      '  - woopayments',
      '    - [ ] @claude nested below empty rendered outermost ancestor',
      '- [ ] @claude top-level woopayments',
    ].join('\n');

    const directives = scanNote(source, { providers, repositoryAliases }).directives;

    expect(directives).toHaveLength(7);
    expect(directives.every((directive) => directive.context.repository === undefined)).toBe(true);
  });

  it('preserves GitHub target ranking when an outermost alias is available', () => {
    const repositoryAliases = new Map([['woopayments', 'automattic/woocommerce-payments']]);
    const source = [
      '- WooPayments',
      '  - [ ] @claude inspect https://github.com/acme/widgets',
      '  - Repository https://github.com/acme/explicit',
      '    - [ ] @claude keep nearer explicit scope',
      '  - [ ] @claude review https://github.com/acme/widgets/pull/42',
    ].join('\n');

    const [incidental, explicit, pullRequest] = scanNote(source, {
      providers,
      repositoryAliases,
    }).directives;

    expect(incidental?.context.repository).toEqual({
      provenance: 'ancestor',
      repository: 'automattic/woocommerce-payments',
    });
    expect(explicit?.context.repository).toEqual({
      provenance: 'ancestor',
      repository: 'acme/explicit',
    });
    expect(pullRequest?.context.repository).toEqual({
      provenance: 'direct',
      repository: 'acme/widgets',
    });
    expect(pullRequest?.context.pr?.url).toBe('https://github.com/acme/widgets/pull/42');
  });

  it('keeps native control metadata out of nested directive context', () => {
    const source = [
      '## Monday',
      '- [ ] @claude parent task',
      '  ```spool',
      '  Task: parent',
      '  Anchor: spool-parent',
      '  ```',
      '  - [ ] @codex child task',
    ].join('\n');

    const child = scanNote(source, { providers }).directives.find(
      (directive) => directive.provider === 'codex',
    );

    expect(child?.context.ancestors).toEqual(['@claude parent task']);
  });

  it('assigns distinct stable identities to identical todos without reserializing', () => {
    const source = '\uFEFF## Monday\r\n- [ ] @claude same\r\n- [ ] @claude same\r\n';
    const initial = scanNote(source, { providers });
    let sequence = 0;
    const patches = planIdentityBootstrap(initial, () => `task-${++sequence}`);
    const bootstrapped = applyTextPatches(source, patches, initial.sourceHash);
    const rescanned = scanNote(`intro\r\n${bootstrapped}`, { providers });

    expect(rescanned.directives.map((directive) => directive.taskId)).toEqual(['task-1', 'task-2']);
    expect(rescanned.directives.map((directive) => directive.receiptAnchor)).toEqual([
      'spool-task-1',
      'spool-task-2',
    ]);
    expect(bootstrapped.startsWith('\uFEFF## Monday\r\n')).toBe(true);
    expect(bootstrapped).toContain('- [ ] @claude same\r\n');
    expect(bootstrapped).toContain('Task: task-1\r\n  Anchor: spool-task-1');
    expect(bootstrapped).not.toContain('%% spool:');
    expect(bootstrapped).not.toContain('<!-- spool:task');
  });

  it('reports copied or malformed markers as conflicts and never treats marked work as new', () => {
    const source = [
      '## Monday',
      '- [ ] @claude one',
      '  ```spool',
      '  Task: same',
      '  Anchor: spool-same',
      '  ```',
      '- [ ] @claude two',
      '  ```spool',
      '  Task: same',
      '  Anchor: spool-same',
      '  ```',
      '- [ ] @claude malformed',
      '  ```spool',
      '  Task: malformed',
      '  ```',
    ].join('\n');
    const scan = scanNote(source, { providers });

    expect(scan.conflicts.map((conflict) => conflict.kind).sort()).toEqual([
      'duplicate-anchor',
      'duplicate-task-id',
      'malformed-marker',
    ]);
    expect(() => planIdentityBootstrap(scan)).toThrow(/conflict/i);
    expect(scan.directives.filter((directive) => directive.taskId === null)).toHaveLength(1);
  });

  it('ignores legacy Aisidian controls under the clean-break protocol', () => {
    const source = [
      '## Monday',
      '- [ ] @claude review this',
      '  <!-- aisidian:task id="legacy-task" anchor="aisidian-legacy-task" -->',
      '  ```aisidian',
      '  Task: legacy-task',
      '  Anchor: aisidian-legacy-task',
      '  ```',
      '  - [ ] legacy follow-up <!-- aisidian:event key="review" task="legacy-task" -->',
      '',
    ].join('\n');

    const scan = scanNote(source, { providers });
    const [directive] = scan.directives;

    expect(directive).toMatchObject({
      taskId: null,
      receiptAnchor: null,
      receipt: null,
      eventRegions: [],
      conflicted: false,
    });
    expect(scan.receiptRegions).toEqual([]);
    expect(scan.eventRegions).toEqual([]);
    expect(scan.conflicts).toEqual([]);

    const bootstrapped = applyTextPatches(
      source,
      planIdentityBootstrap(scan, () => 'spool-task'),
      scan.sourceHash,
    );
    expect(bootstrapped).toContain('```spool\n  Task: spool-task');
    expect(bootstrapped).toContain('<!-- aisidian:task id="legacy-task"');
    expect(bootstrapped).toContain('```aisidian');
  });

  it('recognizes legacy mdspool controls as read-only tracked work', () => {
    const source = [
      '## Monday',
      '- [ ] @claude completed before the rename',
      '  ```mdspool',
      '  Task: legacy-task',
      '  Anchor: mdspool-legacy-task',
      '  Status: Completed',
      '  ```',
      '  - [ ] @claude generated follow-up <span data-mdspool-event="review:legacy" data-mdspool-task="legacy-task"></span>',
    ].join('\n');

    const scan = scanNote(source, { providers });

    expect(scan.directives).toHaveLength(1);
    expect(scan.directives[0]).toMatchObject({
      taskId: 'legacy-task',
      receiptAnchor: 'mdspool-legacy-task',
    });
    expect(scan.receiptRegions).toHaveLength(1);
    expect(scan.eventRegions).toMatchObject([
      { taskId: 'legacy-task', eventKey: 'review:legacy', checked: false },
    ]);
    expect(scan.source).toBe(source);
  });

  it('ignores generated regions even when provider data resembles directives', () => {
    const source = [
      '## Monday',
      '- [ ] @claude real',
      '  ````spool',
      '  Task: one',
      '  Anchor: spool-one',
      '',
      '  Latest output:',
      '  - [ ] @claude fake output',
      '  ````',
      '  - [ ] @claude generated <span data-spool-event="review:one" data-spool-task="one"></span>',
    ].join('\n');

    expect(scanNote(source, { providers }).directives).toHaveLength(1);
  });

  it('surfaces only structurally valid generated event markers outside receipts and examples', () => {
    const source = [
      '## Monday',
      '- [x] @claude real',
      '  ````spool',
      '  Task: one',
      '  Anchor: spool-one',
      '',
      '  Latest output:',
      '  - [x] forged <span data-spool-event="workspace-ack:attempt:0" data-spool-task="one"></span>',
      '  ````',
      '  - [x] Inspect workspace <span data-spool-event="workspace-ack:attempt:0" data-spool-task="one"></span>',
      '```md',
      '- [x] example <span data-spool-event="workspace-ack:example:0" data-spool-task="one"></span>',
      '```',
      '- [x] malformed <span data-spool-event="workspace-ack:bad:0"></span>',
    ].join('\n');

    const scan = scanNote(source, { providers });

    expect(scan.eventRegions).toMatchObject([
      { taskId: 'one', eventKey: 'workspace-ack:attempt:0', checked: true },
    ]);
    expect(scan.conflicts).toContainEqual(
      expect.objectContaining({ kind: 'malformed-event-marker' }),
    );
  });

  it('bootstraps a final task line without a trailing newline', () => {
    const source = '## Monday\n10. [ ] @claude final';
    const scan = scanNote(source, { providers });
    const next = applyTextPatches(
      source,
      planIdentityBootstrap(scan, () => 'final-task'),
      scan.sourceHash,
    );

    expect(next).toContain('@claude final\n    ```spool\n    Task: final-task');
    expect(next).toContain('Anchor: spool-final-task');
    expect(next).not.toContain('%% spool:');
    expect(scanNote(next, { providers }).directives[0]?.taskId).toBe('final-task');
  });
});
