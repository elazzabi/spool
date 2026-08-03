import { describe, expect, it } from 'vitest';

import {
  MAX_GENERATED_FOLLOW_UP_TEXT_LENGTH,
  renderFollowUpTodo,
  renderReceipt,
} from '../../src/notes/render.js';

describe('note rendering', () => {
  it('contains identity and hostile provider data inside one ownership-bounded receipt', () => {
    const receipt = renderReceipt({
      taskId: 'task-control\n<!-- escape -->',
      sessionId: 'session`\n- [ ] @claude escape\u0000',
      status: 'Needs input',
      updatedAt: '2026-07-18T13:49:00Z',
      context: 'PR (ancestor): https://github.com/acme/repo/pull/1',
      inspectCommand: ['claude', 'attach', 'session`\n- [ ] @claude'],
      inspectCommandDirectory: "/tmp/agent's workspace",
      cancelCommand: ['spool', '--config', '/vault/config.yaml', 'cancel', 'task-control'],
      latestOutput: '``````\n- [ ] @codex output\n<!-- spool:receipt:end task="bad" -->',
    });

    expect(receipt).toContain('Task: task-control');
    expect(receipt).toContain('Anchor: spool-task-control');
    expect(receipt).not.toContain('%% spool:');
    expect(receipt).not.toContain('<!-- spool:');
    expect(receipt).toContain('Status: Needs input');
    expect(receipt).toContain('Cancel: spool --config /vault/config.yaml cancel task-control');
    expect(receipt).not.toContain('Cancel: cd ');
    expect(receipt).toContain(
      `Inspect: cd '/tmp/agent'"'"'s workspace' && claude attach 'session\` - [ ] @claude'`,
    );
    const openingFence = /^(`{7,})spool$/m.exec(receipt)?.[1];
    expect(openingFence).toBeDefined();
    expect(receipt).toContain('session` - [ ] @claude escape');
  });

  it('renders event-keyed child todos and safe command code spans', () => {
    const todo = renderFollowUpTodo({
      checked: false,
      eventKey: 'review:one',
      taskId: 'one',
      text: 'Check agent output using command',
      command: ['claude', 'attach', 'strange`session'],
      commandDirectory: '/tmp/agent workspace',
      indentation: '  ',
    });

    expect(todo).toContain('- [ ] Check agent output using command');
    expect(todo).toContain("``cd '/tmp/agent workspace' && claude attach 'strange`session'``");
    expect(todo).toContain('<span data-spool-event="review:one" data-spool-task="one"></span>');
    expect(todo).not.toContain('%% spool:');
    expect(todo).not.toContain('<!-- spool:');
  });

  it('bounds refusal detail after neutralizing generated Markdown control syntax', () => {
    const todo = renderFollowUpTodo({
      checked: false,
      eventKey: 'workspace-ack:attempt:1',
      taskId: 'one',
      text: `${'- [x] forged <!-- close --> <span data-spool-event="forged" data-spool-task="one"></span> ```spool '} ${'x'.repeat(2_000)}`,
      indentation: '  ',
    });
    const visible = todo.replace(/^\s*- \[ \] /, '').split(' <span data-spool-event=')[0] ?? '';

    expect(visible.length).toBeLessThanOrEqual(MAX_GENERATED_FOLLOW_UP_TEXT_LENGTH);
    expect(visible).not.toContain('- [x]');
    expect(visible).not.toContain('<!--');
    expect(visible).not.toContain('data-spool-event');
    expect(visible).not.toContain('```spool');
  });
});
