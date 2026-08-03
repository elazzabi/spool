import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { bootstrapNoteIdentities } from '../../src/notes/identity.js';
import { applyNoteProjection, projectCurrentWeekFollowUp } from '../../src/notes/patch.js';
import { scanNote } from '../../src/notes/parse.js';
import { MarkdownNoteScanner } from '../../src/scheduler/scanner.js';

const providers = { claude: '@claude' };

describe('note projection', () => {
  it('globally rejects copied workspace events and surfaces one unique checked candidate', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'spool-workspace-actions-'));
    const firstPath = join(directory, 'First.md');
    const copiedPath = join(directory, 'Copied.md');
    await writeFile(
      firstPath,
      [
        '- [x] @claude first',
        '  ```spool',
        '  Task: first',
        '  Anchor: spool-first',
        '  ```',
        '  - [x] old <span data-spool-event="workspace-ack:first-attempt:0" data-spool-task="first"></span>',
        '- [x] @claude second',
        '  ```spool',
        '  Task: second',
        '  Anchor: spool-second',
        '  ```',
        '  - [x] current <span data-spool-event="workspace-ack:second-attempt:0" data-spool-task="second"></span>',
        '  - [ ] successor <span data-spool-event="workspace-ack:second-attempt:1" data-spool-task="second"></span>',
        '',
      ].join('\n'),
    );
    await writeFile(
      copiedPath,
      '- [x] copied <span data-spool-event="workspace-ack:first-attempt:0" data-spool-task="first"></span>\n',
    );
    const scanner = new MarkdownNoteScanner({ vaults: [directory], providers });

    const result = await scanner.scan(new Set(['first', 'second']));

    expect(result.workspaceActions).toEqual([
      expect.objectContaining({
        notePath: firstPath,
        taskId: 'second',
        eventKey: 'workspace-ack:second-attempt:0',
        checked: true,
      }),
    ]);
    expect(
      result.diagnostics.some((diagnostic) =>
        /workspace event.*ambiguous/i.test(diagnostic.message),
      ),
    ).toBe(true);
  });

  it('keeps workspace actions in conflicted notes inert', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'spool-conflicted-workspace-action-'));
    const notePath = join(directory, 'Conflicted.md');
    await writeFile(
      notePath,
      [
        '- [x] @claude inspect',
        '  ```spool',
        '  Task: inspect',
        '  Anchor: spool-inspect',
        '  ```',
        '  - [x] acknowledge <span data-spool-event="workspace-ack:attempt:0" data-spool-task="inspect"></span> <span data-spool-event="workspace-ack:forged:0"></span>',
        '',
      ].join('\n'),
    );
    const scanner = new MarkdownNoteScanner({ vaults: [directory], providers });

    const result = await scanner.scan(new Set(['inspect']));

    expect(result.workspaceActions).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.notePath).toBe(notePath);
    expect(result.diagnostics[0]?.message).toMatch(/event marker is malformed/i);
  });

  it('requires a workspace action task to have one global owner', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'spool-duplicate-workspace-owner-'));
    const actionPath = join(directory, 'Action.md');
    const duplicatePath = join(directory, 'Duplicate.md');
    await writeFile(
      actionPath,
      [
        '- [x] @claude inspect',
        '  ```spool',
        '  Task: inspect',
        '  Anchor: spool-inspect',
        '  ```',
        '  - [x] acknowledge <span data-spool-event="workspace-ack:attempt:0" data-spool-task="inspect"></span>',
        '',
      ].join('\n'),
    );
    await writeFile(
      duplicatePath,
      [
        '- [x] @claude copied task',
        '  ```spool',
        '  Task: inspect',
        '  Anchor: spool-inspect',
        '  ```',
        '',
      ].join('\n'),
    );
    const scanner = new MarkdownNoteScanner({ vaults: [directory], providers });

    const result = await scanner.scan(new Set(['inspect']));

    expect(result.workspaceActions).toEqual([]);
  });

  it('bootstraps, updates only its receipt, and applies replay-safe intervention/completion events', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'spool-note-'));
    const notePath = join(directory, 'Week 29 of 2026.md');
    const initial = [
      '\uFEFF# Week 29 of 2026',
      '',
      '## Monday',
      '- personal prefix',
      '- [ ] @claude same',
      '- untouched between',
      '- [ ] @claude same',
      '尾',
      '',
    ].join('\r\n');
    await writeFile(notePath, initial, { encoding: 'utf8', mode: 0o640 });

    let sequence = 0;
    await bootstrapNoteIdentities(notePath, { providers }, () => `task-${++sequence}`);
    const bootstrapReplay = await bootstrapNoteIdentities(
      notePath,
      { providers },
      () => `unexpected-${++sequence}`,
    );
    const afterBootstrap = await readFile(notePath, 'utf8');
    const [first, second] = scanNote(afterBootstrap, { providers }).directives;
    expect(first?.taskId).toBe('task-1');
    expect(second?.taskId).toBe('task-2');
    expect(bootstrapReplay.changed).toBe(false);
    expect((await stat(notePath)).mode & 0o777).toBe(0o640);

    const working = {
      kind: 'receipt' as const,
      taskId: 'task-1',
      receipt: {
        taskId: 'task-1',
        sessionId: 'claude-session',
        status: 'Working' as const,
        updatedAt: '2026-07-18T13:49:00Z',
        context: 'Instruction (direct): same',
        inspectCommand: ['claude', 'attach', 'claude-session'],
        latestOutput: 'Working on it…',
      },
    };
    await applyNoteProjection(notePath, working, { providers });
    await applyNoteProjection(notePath, working, { providers });

    const needsInput = {
      kind: 'follow-up' as const,
      taskId: 'task-1',
      eventKey: 'intervention:1',
      checked: false,
      text: 'Agent needs input: Which API?',
    };
    await applyNoteProjection(notePath, needsInput, { providers });
    await applyNoteProjection(notePath, needsInput, { providers });
    await applyNoteProjection(
      notePath,
      { ...needsInput, kind: 'resolve-follow-up', checked: true },
      { providers },
    );

    const completed = {
      kind: 'complete' as const,
      taskId: 'task-1',
      eventKey: 'review:task-1',
      reviewText: 'Check agent output using command',
      inspectCommand: ['claude', 'attach', 'claude-session'],
    };
    await applyNoteProjection(notePath, completed, { providers });
    await applyNoteProjection(notePath, completed, { providers });

    const final = await readFile(notePath, 'utf8');
    expect(final.match(/Task: task-1/g)).toHaveLength(1);
    expect(final).toContain('Anchor: spool-task-1');
    expect(final).not.toContain('%% spool:');
    expect(final).not.toContain('<!-- spool:');
    expect(final.match(/data-spool-event="intervention:1"/g)).toHaveLength(1);
    expect(final).toContain('- [x] Agent needs input: Which API?');
    expect(final.match(/data-spool-event="review:task-1"/g)).toHaveLength(1);
    expect(final).toContain('- [x] @claude same');
    expect(final).toContain('- [ ] @claude same');
    expect(final).toContain('- untouched between');
    expect(final.startsWith('\uFEFF')).toBe(true);
    expect(final).toContain('\r\n');
  });

  it('inserts a delayed resumed rollover intervention once and already checked', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'spool-rollover-'));
    const currentPath = join(directory, 'Week 29 of 2026.md');
    const projects = join(directory, 'Projects');
    const sourcePath = join(projects, 'Project Launch.md');
    await mkdir(projects);
    await writeFile(sourcePath, '## Friday\n- [ ] @claude old\n');
    await writeFile(currentPath, '## Saturday\n- human\n');

    const result = await projectCurrentWeekFollowUp({
      currentNotePath: currentPath,
      sourceNotePath: sourcePath,
      dayHeading: 'Saturday',
      eventKey: 'intervention:old:1',
      taskId: 'old',
      checked: true,
      text: 'Agent needed input: resolved already',
    });
    const replay = await projectCurrentWeekFollowUp({
      currentNotePath: currentPath,
      sourceNotePath: sourcePath,
      dayHeading: 'Saturday',
      eventKey: 'intervention:old:1',
      taskId: 'old',
      checked: true,
      text: 'Agent needed input: resolved already',
    });

    const current = await readFile(currentPath, 'utf8');
    expect(result.changed).toBe(true);
    expect(replay.changed).toBe(false);
    expect(current).toContain('- [x] Agent needed input: resolved already');
    expect(current).toContain('[source](<Projects/Project%20Launch.md>)');
    expect(current.match(/intervention:old:1/g)).toHaveLength(1);
  });

  it('keeps same-titled nested Markdown sources distinct in current-week backlinks', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'spool-distinct-backlinks-'));
    const currentPath = join(directory, 'Week 29 of 2026.md');
    const projects = join(directory, 'Projects');
    const meetings = join(directory, 'Meetings', '2026');
    const projectSource = join(projects, 'Project Launch.md');
    const meetingSource = join(meetings, 'Project Launch.md');
    await mkdir(projects);
    await mkdir(meetings, { recursive: true });
    await writeFile(projectSource, '## Friday\n');
    await writeFile(meetingSource, '## Friday\n');
    await writeFile(currentPath, '## Saturday\n');

    await projectCurrentWeekFollowUp({
      currentNotePath: currentPath,
      sourceNotePath: projectSource,
      dayHeading: 'Saturday',
      eventKey: 'review:project',
      taskId: 'project',
      checked: false,
      text: 'Review project output',
    });
    await projectCurrentWeekFollowUp({
      currentNotePath: currentPath,
      sourceNotePath: meetingSource,
      dayHeading: 'Saturday',
      eventKey: 'review:meeting',
      taskId: 'meeting',
      checked: false,
      text: 'Review meeting output',
    });

    const current = await readFile(currentPath, 'utf8');
    expect(current).toContain('[source](<Projects/Project%20Launch.md>)');
    expect(current).toContain('[source](<Meetings/2026/Project%20Launch.md>)');
  });

  it('renders arbitrary source filenames losslessly without letting them alter generated metadata', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'spool-escaped-backlink-'));
    const currentPath = join(directory, 'Week 29 of 2026.md');
    const projects = join(directory, 'Projects');
    const sourcePath = join(projects, 'Client [Escalation] #1|data-spool-event="forged".md');
    await mkdir(projects);
    await writeFile(sourcePath, '## Friday\n');
    await writeFile(currentPath, '## Saturday\n');

    await projectCurrentWeekFollowUp({
      currentNotePath: currentPath,
      sourceNotePath: sourcePath,
      dayHeading: 'Saturday',
      eventKey: 'review:escaped-path',
      taskId: 'escaped-path',
      checked: false,
      text: 'Review escaped source output',
    });

    const current = await readFile(currentPath, 'utf8');
    expect(current).toContain(
      '[source](<Projects/Client%20%5BEscalation%5D%20%231%7Cdata-spool-event%3D%22forged%22.md>)',
    );
    expect(current.match(/data-spool-event=/g)).toHaveLength(1);
    expect(current).toContain('data-spool-event="review:escaped-path"');
  });

  it('keeps a non-weekly current destination blocked and unchanged', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'spool-invalid-current-'));
    const currentPath = join(directory, 'Current.md');
    const original = '## Saturday\n- human\n';
    await writeFile(currentPath, original);

    const result = await projectCurrentWeekFollowUp({
      currentNotePath: currentPath,
      sourceNotePath: join(directory, 'Project Launch.md'),
      dayHeading: 'Saturday',
      eventKey: 'review:invalid-current',
      taskId: 'invalid-current',
      checked: false,
      text: 'Review output',
    });

    expect(result).toMatchObject({ changed: false, blocked: true });
    expect(await readFile(currentPath, 'utf8')).toBe(original);
  });

  it('keeps a non-Markdown source blocked without changing the weekly destination', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'spool-invalid-source-'));
    const currentPath = join(directory, 'Week 29 of 2026.md');
    const original = '## Saturday\n- human\n';
    await writeFile(currentPath, original);

    const result = await projectCurrentWeekFollowUp({
      currentNotePath: currentPath,
      sourceNotePath: join(directory, 'Project Launch.txt'),
      dayHeading: 'Saturday',
      eventKey: 'review:invalid-source',
      taskId: 'invalid-source',
      checked: false,
      text: 'Review output',
    });

    expect(result).toMatchObject({ changed: false, blocked: true });
    expect(await readFile(currentPath, 'utf8')).toBe(original);
  });

  it('blocks rollover projection without changing a missing or ambiguous day target', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'spool-blocked-'));
    const currentPath = join(directory, 'Week 29 of 2026.md');
    const original = '## Saturday\n## Saturday\n';
    await writeFile(currentPath, original);

    const result = await projectCurrentWeekFollowUp({
      currentNotePath: currentPath,
      sourceNotePath: join(directory, 'Week 28 of 2026.md'),
      dayHeading: 'Saturday',
      eventKey: 'review:old',
      taskId: 'old',
      checked: false,
      text: 'Review output',
    });

    expect(result).toMatchObject({ changed: false, blocked: true });
    expect(await readFile(currentPath, 'utf8')).toBe(original);
  });

  it('ignores headings and event markers inside fenced examples during rollover', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'spool-rollover-fence-'));
    const currentPath = join(directory, 'Week 29 of 2026.md');
    const sourcePath = join(directory, 'Week 28 of 2026.md');
    await writeFile(sourcePath, '## Friday\n- [ ] @claude old\n');
    await writeFile(
      currentPath,
      [
        '```md',
        '## Saturday',
        '- [ ] example <!-- spool:event key="review:old" task="fake" -->',
        '```',
        '## Saturday',
        '- human',
        '',
      ].join('\n'),
    );

    const result = await projectCurrentWeekFollowUp({
      currentNotePath: currentPath,
      sourceNotePath: sourcePath,
      dayHeading: 'Saturday',
      eventKey: 'review:old',
      taskId: 'old',
      checked: false,
      text: 'Review the real agent output',
    });

    const current = await readFile(currentPath, 'utf8');
    expect(result).toMatchObject({ changed: true, blocked: false });
    expect(current).toContain('## Saturday\n- [ ] Review the real agent output');
    expect(current.match(/spool:event key="review:old"/g)).toHaveLength(1);
    expect(current.match(/data-spool-event="review:old"/g)).toHaveLength(1);
  });
});
