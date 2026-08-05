import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { SpoolConfig } from '../../src/config/schema.js';
import { openLedgerDatabase } from '../../src/ledger/database.js';
import { OutboxRepository } from '../../src/ledger/outbox.js';
import { LedgerRepository } from '../../src/ledger/repositories.js';
import { FakeProvider } from '../../src/providers/fake.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import type { ProviderRunResult } from '../../src/providers/types.js';
import { AttemptObserver } from '../../src/scheduler/observer.js';
import { VaultWatcher } from '../../src/scheduler/watcher.js';
import { MarkdownNoteScanner } from '../../src/scheduler/scanner.js';
import { NoteProjector } from '../../src/scheduler/projector.js';
import { Reconciler, type ReconciliationPassResult } from '../../src/scheduler/reconciler.js';
import { ReconciliationService } from '../../src/scheduler/service.js';

describe('Markdown note scanner ownership barrier', () => {
  it('processes an arbitrarily titled Markdown note without touching a text sibling', async () => {
    const vault = mkdtempSync(path.join(tmpdir(), 'spool-scanner-markdown-'));
    const note = path.join(vault, 'Project Launch.md');
    const control = path.join(vault, 'Project Launch.txt');
    const controlSource = '## Saturday\n\n- [ ] @fake Leave this file alone\n';
    writeFileSync(note, '## Saturday\n\n- [ ] @fake Review this launch\n');
    writeFileSync(control, controlSource);
    const scanner = new MarkdownNoteScanner({
      vaults: [vault],
      providers: { fake: '@fake' },
      idFactory: () => 'arbitrary-markdown-task',
    });

    const first = await scanner.scan();
    const second = await scanner.scan();

    expect(first.notePaths).toEqual([note]);
    expect(first.bootstrappedTaskIds).toEqual(['arbitrary-markdown-task']);
    expect(second.claimable).toHaveLength(1);
    expect(second.claimable[0]).toMatchObject({
      notePath: note,
      directive: { taskId: 'arbitrary-markdown-task' },
    });
    expect(readFileSync(control, 'utf8')).toBe(controlSource);
  });

  it('recursively discovers Markdown notes with case-insensitive extensions', async () => {
    const vault = mkdtempSync(path.join(tmpdir(), 'spool-scanner-nested-'));
    const projects = path.join(vault, 'Projects');
    const note = path.join(projects, 'Launch Notes.MD');
    mkdirSync(projects);
    writeFileSync(note, '## Saturday\n\n- [ ] @fake Review this nested note\n');
    const scanner = new MarkdownNoteScanner({
      vaults: [vault],
      providers: { fake: '@fake' },
      idFactory: () => 'nested-markdown-task',
    });

    const first = await scanner.scan();
    const second = await scanner.scan();

    expect(first.notePaths).toEqual([note]);
    expect(second.claimable).toEqual([expect.objectContaining({ notePath: note })]);
  });

  it('does not follow Markdown file or directory symlinks', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'spool-scanner-symlink-'));
    const vault = path.join(root, 'vault');
    const external = path.join(root, 'external');
    mkdirSync(vault);
    mkdirSync(external);
    const externalNote = path.join(external, 'External.md');
    writeFileSync(externalNote, '## Saturday\n\n- [ ] @fake Do not discover this\n');
    symlinkSync(externalNote, path.join(vault, 'Linked.md'));
    symlinkSync(external, path.join(vault, 'Linked Directory'));
    const scanner = new MarkdownNoteScanner({
      vaults: [vault],
      providers: { fake: '@fake' },
      idFactory: () => 'symlink-task',
    });

    const result = await scanner.scan();

    expect(result.notePaths).toEqual([]);
    expect(result.bootstrappedTaskIds).toEqual([]);
    expect(readFileSync(externalNote, 'utf8')).not.toContain('Task:');
  });

  it('deduplicates canonical note paths below overlapping watched roots', async () => {
    const vault = mkdtempSync(path.join(tmpdir(), 'spool-scanner-overlap-'));
    const projects = path.join(vault, 'Projects');
    const note = path.join(projects, 'Project Launch.md');
    mkdirSync(projects);
    writeFileSync(note, '## Saturday\n\n- [ ] @fake Review this once\n');
    const scanner = new MarkdownNoteScanner({
      vaults: [vault, projects],
      providers: { fake: '@fake' },
      idFactory: () => 'overlapping-root-task',
    });

    const first = await scanner.scan();
    const second = await scanner.scan();

    expect(first.notePaths).toEqual([note]);
    expect(first.bootstrappedTaskIds).toEqual(['overlapping-root-task']);
    expect(second.claimable).toHaveLength(1);
    expect(second.claimable[0]?.notePath).toBe(note);
  });

  it('keeps scanning sibling Markdown notes when a descendant cannot be read', async () => {
    const vault = mkdtempSync(path.join(tmpdir(), 'spool-scanner-unreadable-'));
    const unavailable = path.join(vault, 'Unavailable');
    const note = path.join(vault, 'Project Launch.md');
    mkdirSync(unavailable);
    writeFileSync(
      path.join(unavailable, 'Hidden.md'),
      '## Saturday\n\n- [ ] @fake Do not stop siblings\n',
    );
    writeFileSync(note, '## Saturday\n\n- [ ] @fake Review this launch\n');
    const scanner = new MarkdownNoteScanner({
      vaults: [vault],
      providers: { fake: '@fake' },
      idFactory: () => 'sibling-markdown-task',
      filesystem: {
        readdir: async (directory, options) => {
          if (directory === unavailable) throw new Error('simulated read failure');
          return fs.readdir(directory, options);
        },
        lstat: fs.lstat,
        realpath: fs.realpath,
      },
    });

    const first = await scanner.scan();
    const second = await scanner.scan();

    expect(first.notePaths).toEqual([note]);
    expect(first.diagnostics).toHaveLength(1);
    expect(first.diagnostics[0]?.notePath).toBe(unavailable);
    expect(first.diagnostics[0]?.message).toContain(
      'Unable to read directory: simulated read failure',
    );
    expect(second.claimable).toEqual([expect.objectContaining({ notePath: note })]);
  });

  it('bootstraps an unmarked directive and only exposes it after a later re-read', async () => {
    const vault = mkdtempSync(path.join(tmpdir(), 'spool-scanner-'));
    const note = path.join(vault, 'Week 29 of 2026.md');
    writeFileSync(note, '## Saturday\n\n- [ ] @fake Review this PR\n');
    const scanner = new MarkdownNoteScanner({
      vaults: [vault],
      providers: { fake: '@fake' },
      idFactory: () => 'task-owned-in-this-process',
    });

    const first = await scanner.scan();
    expect(first.claimable).toEqual([]);
    expect(first.bootstrappedTaskIds).toEqual(['task-owned-in-this-process']);
    expect(readFileSync(note, 'utf8')).toContain('Task: task-owned-in-this-process');
    expect(readFileSync(note, 'utf8')).toContain('Anchor: spool-task-owned-in-this-process');

    const second = await scanner.scan();
    expect(second.claimable).toHaveLength(1);
    expect(second.claimable[0]).toMatchObject({
      notePath: note,
      directive: { taskId: 'task-owned-in-this-process', provider: 'fake' },
    });
  });

  it('keeps a pre-existing marker with no ledger ownership inert after restart', async () => {
    const vault = mkdtempSync(path.join(tmpdir(), 'spool-scanner-orphan-'));
    const note = path.join(vault, 'Week 29 of 2026.md');
    writeFileSync(
      note,
      [
        '## Saturday',
        '',
        '- [ ] @fake Never infer ownership',
        '  ```spool',
        '  Task: orphan-task',
        '  Anchor: spool-orphan-task',
        '  ```',
        '',
      ].join('\n'),
    );

    const scanner = new MarkdownNoteScanner({
      vaults: [vault],
      providers: { fake: '@fake' },
    });
    const result = await scanner.scan();

    expect(result.claimable).toEqual([]);
    expect(result.orphanedMarkers).toEqual([
      expect.objectContaining({ taskId: 'orphan-task', notePath: note }),
    ]);
  });

  it('bootstraps a trailing directive and strips the dispatch tag from agent context', async () => {
    const vault = mkdtempSync(path.join(tmpdir(), 'spool-scanner-trailing-'));
    const note = path.join(vault, 'Week 29 of 2026.md');
    writeFileSync(
      note,
      '## Saturday\n\n- [ ] Review https://github.com/acme/widgets/pull/42 carefully @fake\n',
    );
    const scanner = new MarkdownNoteScanner({
      vaults: [vault],
      providers: { fake: '@fake' },
      idFactory: () => 'trailing-scanner-task',
    });

    const first = await scanner.scan();
    const second = await scanner.scan();

    expect(first.bootstrappedTaskIds).toEqual(['trailing-scanner-task']);
    expect(second.claimable).toHaveLength(1);
    expect(second.claimable[0]?.directive).toMatchObject({
      taskId: 'trailing-scanner-task',
      provider: 'fake',
      providerDirective: '@fake',
      directiveText: 'Review https://github.com/acme/widgets/pull/42 carefully',
    });
    expect(second.claimable[0]?.context).toContain(
      'Instruction (direct): Review https://github.com/acme/widgets/pull/42 carefully',
    );
    expect(second.claimable[0]?.context).not.toContain('carefully @fake');
  });

  it('propagates an immutable repository alias lookup into canonical scanned context', async () => {
    const vault = mkdtempSync(path.join(tmpdir(), 'spool-scanner-repository-alias-'));
    const note = path.join(vault, 'Tasks.md');
    writeFileSync(
      note,
      [
        '- WooPayments',
        '  - [ ] @fake Review',
        '    ```spool',
        '    Task: alias-task',
        '    Anchor: spool-alias-task',
        '    ```',
      ].join('\n'),
    );
    const repositoryAliases = new Map([['woopayments', 'example/widget']]);
    const scanner = new MarkdownNoteScanner({
      vaults: [vault],
      providers: { fake: '@fake' },
      repositoryAliases,
    });
    repositoryAliases.set('woopayments', 'other/repository');

    const result = await scanner.scan(new Set(['alias-task']));

    expect(result.claimable).toHaveLength(1);
    expect(result.claimable[0]?.directive.context.repository).toEqual({
      provenance: 'ancestor',
      repository: 'example/widget',
    });
    expect(result.claimable[0]?.context).toContain('Repository (ancestor): example/widget');
    expect(result.claimable[0]?.context).not.toContain('Repository (ancestor): woopayments');
  });

  it('does not refresh repository context for a terminal job after alias resolution changes', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'spool-terminal-repository-alias-'));
    const vault = path.join(root, 'vault');
    const state = path.join(root, 'state');
    mkdirSync(vault);
    mkdirSync(state);
    const note = path.join(vault, 'Tasks.md');
    writeFileSync(
      note,
      [
        '- WooPayments',
        '  - [ ] @fake Review',
        '    ```spool',
        '    Task: terminal-alias-task',
        '    Anchor: spool-terminal-alias-task',
        '    ```',
      ].join('\n'),
    );
    const database = openLedgerDatabase(state);
    const ledger = new LedgerRepository(database);
    const outbox = new OutboxRepository(database);
    const config = projectorConfig(root, vault, state);
    config.repositories = [{ repository: 'example/widget', alias: 'woopayments', clones: [] }];
    const job = ledger.claimJob({
      sourceMarker: 'terminal-alias-task',
      sourcePath: note,
      provider: 'fake',
      directive: 'Original directive',
      context: 'Original context',
      repository: null,
    });
    ledger.requestCancellation(job.id);
    const reconciler = new Reconciler({
      config,
      database,
      ledger,
      outbox,
      providers: new ProviderRegistry([new FakeProvider({ executable: process.execPath })]),
    });

    await reconciler.runPass();

    expect(ledger.getJob(job.id)).toMatchObject({
      state: 'Cancelled',
      directive: 'Original directive',
      context: 'Original context',
      repository: null,
    });
    await reconciler.shutdown();
    database.close();
  });
});

describe('note projection delivery', () => {
  it('persists a projection error and releases it for a later reconciliation pass', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'spool-projector-error-'));
    const vault = path.join(root, 'vault');
    const state = path.join(root, 'state');
    mkdirSync(vault);
    mkdirSync(state);
    const database = openLedgerDatabase(state);
    const ledger = new LedgerRepository(database);
    const outbox = new OutboxRepository(database);
    const missing = path.join(vault, 'Week 29 of 2026.md');
    const job = ledger.claimJob({
      sourceMarker: 'missing-note',
      sourcePath: missing,
      provider: 'fake',
      directive: 'review',
      context: 'fixture',
    });
    const projector = new NoteProjector({
      config: projectorConfig(root, vault, state),
      ledger,
      outbox,
    });
    projector.enqueueSource(job, 'missing-note-receipt', {
      kind: 'receipt',
      taskId: job.sourceMarker,
      receipt: {
        taskId: job.sourceMarker,
        sessionId: null,
        status: 'Queued',
        updatedAt: job.createdAt,
        context: job.context,
      },
    });

    const delivered = await projector.deliver('writer');
    const persisted = database.raw
      .prepare('SELECT claim_owner, last_error FROM outbox WHERE semantic_key = ?')
      .get('missing-note-receipt') as { claim_owner: string | null; last_error: string | null };

    expect(delivered.errors[0]).toMatch(/missing-note-receipt/i);
    expect(ledger.getProjection('missing-note-receipt')).toMatchObject({ state: 'Blocked' });
    expect(persisted.claim_owner).toBeNull();
    expect(persisted.last_error).toMatch(/ENOENT/i);
    database.close();
  });

  it('defers a blocked rollover projection without stalling a later source receipt', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'spool-projector-'));
    const vault = path.join(root, 'vault');
    const state = path.join(root, 'state');
    const source = path.join(vault, 'Week 28 of 2026.md');
    const current = path.join(vault, 'Week 29 of 2026.md');
    mkdirSync(vault);
    mkdirSync(state);
    writeFileSync(source, trackedTask('task-projection'));
    writeFileSync(current, '## Friday\n\n- [ ] unrelated\n');
    const database = openLedgerDatabase(state);
    const ledger = new LedgerRepository(database);
    const outbox = new OutboxRepository(database, { now: () => new Date('2026-07-18T10:00:00Z') });
    const config = projectorConfig(root, vault, state);
    const job = ledger.claimJob({
      sourceMarker: 'task-projection',
      sourcePath: source,
      provider: 'fake',
      directive: 'review',
      context: 'fixture context',
      repository: 'example/widget',
    });
    const projector = new NoteProjector({
      config,
      ledger,
      outbox,
      now: () => new Date('2026-07-18T10:00:00Z'),
    });
    projector.enqueueCurrentWeek(job, 'blocked-first', {
      eventKey: 'needs-1',
      taskId: job.sourceMarker,
      checked: false,
      text: 'Agent needs input',
    });
    projector.enqueueSource(job, 'source-second', {
      kind: 'receipt',
      taskId: job.sourceMarker,
      receipt: {
        taskId: job.sourceMarker,
        sessionId: null,
        status: 'Queued',
        updatedAt: '2026-07-18T10:00:00Z',
        context: 'fixture context',
      },
    });

    const delivered = await projector.deliver('writer');
    expect(delivered).toMatchObject({ applied: 1, blocked: 1 });
    expect(readFileSync(source, 'utf8')).toContain('fixture context');
    expect(readFileSync(current, 'utf8')).not.toContain('Agent needs input');
    expect(outbox.claimNext('other', 30_000, new Date('2026-07-18T10:00:01Z'))).toBeNull();
    expect(outbox.claimNext('retry', 30_000, new Date('2026-07-18T10:00:31Z'))?.semanticKey).toBe(
      'blocked-first',
    );
    database.close();
  });

  it('deduplicates full-name day aliases that refer to the same H2', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'spool-projector-alias-'));
    const vault = path.join(root, 'vault');
    const state = path.join(root, 'state');
    const source = path.join(vault, 'Week 28 of 2026.md');
    const current = path.join(vault, 'Week 29 of 2026.md');
    mkdirSync(vault);
    mkdirSync(state);
    writeFileSync(source, trackedTask('task-alias'));
    writeFileSync(current, '## Saturday\n\n- [ ] unrelated\n');
    const database = openLedgerDatabase(state);
    const ledger = new LedgerRepository(database);
    const outbox = new OutboxRepository(database);
    const config = projectorConfig(root, vault, state);
    config.dayAliases.saturday = ['Saturday'];
    const job = ledger.claimJob({
      sourceMarker: 'task-alias',
      sourcePath: source,
      provider: 'fake',
      directive: 'review',
      context: 'fixture',
    });
    const projector = new NoteProjector({
      config,
      ledger,
      outbox,
      now: () => new Date('2026-07-18T10:00:00Z'),
    });
    projector.enqueueCurrentWeek(job, 'alias-event', {
      eventKey: 'review-1',
      taskId: job.sourceMarker,
      checked: false,
      text: 'Check agent output',
    });

    expect(await projector.deliver('writer')).toMatchObject({ applied: 1, blocked: 0 });
    expect(readFileSync(current, 'utf8')).toContain('Check agent output');
    expect(readFileSync(current, 'utf8')).toContain('[source](<Week%2028%20of%202026.md>)');
    database.close();
  });
});

describe('provider lifecycle projection', () => {
  it('retains two distinct needs-input episodes, resolves both, then completes once', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'spool-lifecycle-'));
    const vault = path.join(root, 'vault');
    const state = path.join(root, 'state');
    mkdirSync(vault);
    mkdirSync(state);
    const note = path.join(vault, 'Week 29 of 2026.md');
    writeFileSync(note, trackedTask('task-lifecycle'));
    const database = openLedgerDatabase(state);
    const ledger = new LedgerRepository(database);
    const outbox = new OutboxRepository(database);
    const config = projectorConfig(root, vault, state);
    const projector = new NoteProjector({
      config,
      ledger,
      outbox,
      now: () => new Date('2026-07-18T10:00:00Z'),
    });
    const observer = new AttemptObserver({
      config,
      ledger,
      projector,
      now: () => new Date('2026-07-18T10:00:00Z'),
    });
    const adapter = new FakeProvider({ executable: process.execPath });
    const job = ledger.claimJob({
      sourceMarker: 'task-lifecycle',
      sourcePath: note,
      provider: 'fake',
      directive: 'Review',
      context: 'Repository (direct): example/widget',
    });
    const logPath = path.join(state, 'logs', 'lifecycle.log');
    writeFileSync(logPath, '', { mode: 0o600 });
    const attempt = ledger.prepareAttempt(job.id, logPath);
    ledger.transitionAttempt(attempt.id, 'Launching');
    ledger.recordAttemptSession(attempt.id, 'fake', 'fake-lifecycle');
    ledger.transitionAttempt(attempt.id, 'Running');
    ledger.transitionJob(job.id, 'Working');

    observer.recordEvidence(attempt.id, adapter, {
      kind: 'state',
      eventKey: 'needs-one',
      state: 'needs_input',
      episodeId: 'episode-one',
      message: 'Which branch?',
    });
    observer.recordEvidence(attempt.id, adapter, {
      kind: 'state',
      eventKey: 'resume-one',
      state: 'working',
      message: 'Resumed after branch input',
    });
    observer.recordEvidence(attempt.id, adapter, {
      kind: 'state',
      eventKey: 'needs-two',
      state: 'needs_input',
      episodeId: 'episode-two',
      message: 'Which API?',
    });
    observer.recordEvidence(attempt.id, adapter, {
      kind: 'state',
      eventKey: 'resume-two',
      state: 'working',
      message: 'Resumed after API input',
    });
    observer.recordEvidence(attempt.id, adapter, {
      kind: 'output',
      eventKey: 'lifecycle-output',
      text: 'Lifecycle review complete.',
    });
    observer.recordEvidence(attempt.id, adapter, {
      kind: 'terminal',
      eventKey: 'lifecycle-terminal',
      state: 'completed',
      proof: 'fake-result',
    });
    observer.finalize(
      attempt.id,
      adapter,
      terminalResult(logPath, 'fake-lifecycle', 'Lifecycle review complete.'),
    );
    await projector.deliver('writer');

    expect(ledger.listInterventions(job.id)).toHaveLength(2);
    expect(ledger.listInterventions(job.id).every((event) => event.closedAt !== null)).toBe(true);
    expect(readFileSync(note, 'utf8').match(/- \[x\] Agent needs input:/g)).toHaveLength(2);
    expect(readFileSync(note, 'utf8')).toContain('--resume fake-lifecycle');
    expect(readFileSync(note, 'utf8').match(/Check agent output using command/g)).toHaveLength(1);
    expect(ledger.getJob(job.id)?.state).toBe('Completed');
    database.close();
  });

  it('keeps source history and routes rollover intervention/review actions to the current week', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'spool-current-week-lifecycle-'));
    const vault = path.join(root, 'vault');
    const state = path.join(root, 'state');
    mkdirSync(vault);
    mkdirSync(state);
    const projects = path.join(vault, 'Projects');
    const source = path.join(projects, 'Project Launch.md');
    const current = path.join(vault, 'Week 29 of 2026.md');
    mkdirSync(projects);
    writeFileSync(source, trackedTask('task-rollover'));
    writeFileSync(current, '## Saturday\n\n- [ ] unrelated\n');
    const database = openLedgerDatabase(state);
    const ledger = new LedgerRepository(database);
    const outbox = new OutboxRepository(database);
    const config = projectorConfig(root, vault, state);
    config.dayAliases.saturday = ['Saturday'];
    const now = () => new Date('2026-07-18T10:00:00Z');
    const projector = new NoteProjector({ config, ledger, outbox, now });
    const observer = new AttemptObserver({ config, ledger, projector, now });
    const adapter = new FakeProvider({ executable: process.execPath });
    const job = ledger.claimJob({
      sourceMarker: 'task-rollover',
      sourcePath: source,
      provider: 'fake',
      directive: 'Review',
      context: 'Repository (direct): example/widget',
    });
    const logPath = path.join(state, 'logs', 'rollover.log');
    writeFileSync(logPath, '', { mode: 0o600 });
    const attempt = ledger.prepareAttempt(job.id, logPath);
    ledger.transitionAttempt(attempt.id, 'Launching');
    ledger.recordAttemptSession(attempt.id, 'fake', 'fake-rollover');
    ledger.transitionAttempt(attempt.id, 'Running');
    ledger.transitionJob(job.id, 'Working');

    observer.recordEvidence(attempt.id, adapter, {
      kind: 'state',
      eventKey: 'rollover-needs',
      state: 'needs_input',
      episodeId: 'rollover-episode',
      message: 'Confirm rollover context',
    });
    await projector.deliver('writer');
    expect(readFileSync(current, 'utf8')).toContain('- [ ] Agent needs input:');
    observer.recordEvidence(attempt.id, adapter, {
      kind: 'state',
      eventKey: 'rollover-resume',
      state: 'working',
    });
    observer.recordEvidence(attempt.id, adapter, {
      kind: 'output',
      eventKey: 'rollover-output',
      text: 'Rollover complete.',
    });
    observer.recordEvidence(attempt.id, adapter, {
      kind: 'terminal',
      eventKey: 'rollover-terminal',
      state: 'completed',
      proof: 'fake-result',
    });
    observer.finalize(
      attempt.id,
      adapter,
      terminalResult(logPath, 'fake-rollover', 'Rollover complete.'),
    );
    await projector.deliver('writer');

    expect(readFileSync(source, 'utf8')).toContain('- [x] @fake Review');
    expect(readFileSync(source, 'utf8')).not.toContain('Check agent output using command');
    expect(readFileSync(current, 'utf8')).toContain('- [x] Agent needs input:');
    expect(readFileSync(current, 'utf8')).toContain('- [ ] Check agent output using command');
    expect(readFileSync(current, 'utf8')).toContain('[source](<Projects/Project%20Launch.md>)');
    database.close();
  });

  it('routes a nested source named like the current week by full path identity', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'spool-nested-current-name-'));
    const vault = path.join(root, 'vault');
    const archive = path.join(vault, 'Archive');
    const state = path.join(root, 'state');
    mkdirSync(vault);
    mkdirSync(archive);
    mkdirSync(state);
    const source = path.join(archive, 'Week 29 of 2026.md');
    const current = path.join(vault, 'Week 29 of 2026.md');
    writeFileSync(source, trackedTask('task-nested-current-name'));
    writeFileSync(current, '## Saturday\n');
    const database = openLedgerDatabase(state);
    const ledger = new LedgerRepository(database);
    const outbox = new OutboxRepository(database);
    const config = projectorConfig(root, vault, state);
    config.dayAliases.saturday = ['Saturday'];
    const now = () => new Date('2026-07-18T10:00:00Z');
    const projector = new NoteProjector({ config, ledger, outbox, now });
    const observer = new AttemptObserver({ config, ledger, projector, now });
    const adapter = new FakeProvider({ executable: process.execPath });
    const job = ledger.claimJob({
      sourceMarker: 'task-nested-current-name',
      sourcePath: source,
      provider: 'fake',
      directive: 'Review',
      context: 'Repository (direct): example/widget',
    });
    const logPath = path.join(state, 'nested-current-name.log');
    writeFileSync(logPath, '', { mode: 0o600 });
    const attempt = ledger.prepareAttempt(job.id, logPath);
    ledger.transitionAttempt(attempt.id, 'Launching');
    ledger.recordAttemptSession(attempt.id, 'fake', 'fake-nested-current-name');
    ledger.transitionAttempt(attempt.id, 'Running');
    ledger.transitionJob(job.id, 'Working');

    observer.recordEvidence(attempt.id, adapter, {
      kind: 'state',
      eventKey: 'nested-current-name-needs',
      state: 'needs_input',
      episodeId: 'nested-current-name-episode',
      message: 'Confirm nested context',
    });
    await projector.deliver('writer');

    expect(readFileSync(current, 'utf8')).toContain('- [ ] Agent needs input:');
    expect(readFileSync(current, 'utf8')).toContain('[source](<Archive/Week%2029%20of%202026.md>)');
    database.close();
  });

  it('uses the deepest overlapping watched root for the current-week destination', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'spool-deepest-vault-'));
    const vault = path.join(root, 'vault');
    const projects = path.join(vault, 'Projects');
    const notes = path.join(projects, 'Notes');
    const state = path.join(root, 'state');
    mkdirSync(vault);
    mkdirSync(projects);
    mkdirSync(notes);
    mkdirSync(state);
    const source = path.join(notes, 'Project Launch.md');
    const outerCurrent = path.join(vault, 'Week 29 of 2026.md');
    const innerCurrent = path.join(projects, 'Week 29 of 2026.md');
    writeFileSync(source, trackedTask('task-deepest-vault'));
    writeFileSync(outerCurrent, '## Saturday\n- outer\n');
    writeFileSync(innerCurrent, '## Saturday\n- inner\n');
    const database = openLedgerDatabase(state);
    const ledger = new LedgerRepository(database);
    const outbox = new OutboxRepository(database);
    const config = projectorConfig(root, vault, state);
    config.vaults = [vault, projects];
    config.dayAliases.saturday = ['Saturday'];
    const now = () => new Date('2026-07-18T10:00:00Z');
    const projector = new NoteProjector({ config, ledger, outbox, now });
    const job = ledger.claimJob({
      sourceMarker: 'task-deepest-vault',
      sourcePath: source,
      provider: 'fake',
      directive: 'Review',
      context: 'Repository (direct): example/widget',
    });
    projector.enqueueCurrentWeek(job, 'deepest-vault-review', {
      eventKey: 'review:deepest-vault',
      taskId: job.sourceMarker,
      checked: false,
      text: 'Review deepest-root output',
    });

    expect(await projector.deliver('writer')).toMatchObject({ applied: 1, blocked: 0 });
    expect(readFileSync(innerCurrent, 'utf8')).toContain('- [ ] Review deepest-root output');
    expect(readFileSync(innerCurrent, 'utf8')).toContain('[source](<Notes/Project%20Launch.md>)');
    expect(readFileSync(outerCurrent, 'utf8')).toBe('## Saturday\n- outer\n');
    database.close();
  });
});

describe('watcher alarms', () => {
  it('coalesces chunked saves into a wakeup while periodic reconciliation remains independent', async () => {
    const vault = mkdtempSync(path.join(tmpdir(), 'spool-watcher-'));
    const note = path.join(vault, 'Week 29 of 2026.md');
    writeFileSync(note, '## Saturday\n');
    let wakes = 0;
    const watcher = new VaultWatcher({
      vaults: [vault],
      stabilityThresholdMs: 50,
      wake: () => {
        wakes += 1;
      },
    });
    await watcher.start();
    writeFileSync(note, '## Saturday\n\n');
    writeFileSync(note, '## Saturday\n\n- [ ]');
    writeFileSync(note, '## Saturday\n\n- [ ] unrelated\n');
    await vi.waitFor(() => expect(wakes).toBe(1), { timeout: 1_000, interval: 10 });
    await watcher.close();
    expect(wakes).toBe(1);
  });
});

describe('reconciliation service diagnostics', () => {
  it('reports a background reconciliation failure once', async () => {
    const config = projectorConfig('/root', '/vault', '/state');
    const emptyResult: ReconciliationPassResult = {
      scan: {
        notePaths: [],
        bootstrappedTaskIds: [],
        claimable: [],
        tracked: [],
        orphanedMarkers: [],
        diagnostics: [],
      },
      claimedJobIds: [],
      dispatches: [],
      projected: 0,
      blockedProjections: 0,
      diagnostics: [],
    };
    let passes = 0;
    const reconciler = {
      runPass: () => {
        passes += 1;
        if (passes > 2) return Promise.reject(new Error('injected reconciliation failure'));
        return Promise.resolve(emptyResult);
      },
      shutdown: () => Promise.resolve(),
    } as unknown as Reconciler;
    const watcher = {
      start: () => Promise.resolve(),
      close: () => Promise.resolve(),
    } as unknown as VaultWatcher;
    const diagnostics: string[] = [];
    const service = new ReconciliationService({
      config,
      reconciler,
      watcher,
      onDiagnostic: (message) => diagnostics.push(message),
    });
    await service.start();

    service.wake();
    await vi.waitFor(() => expect(service.lastError()?.message).toMatch(/injected/));

    expect(diagnostics).toEqual(['Reconciliation failed: injected reconciliation failure']);
    await service.stop();
  });
});

function trackedTask(taskId: string): string {
  return [
    '## Saturday',
    '',
    '- [ ] @fake Review',
    '  ```spool',
    `  Task: ${taskId}`,
    `  Anchor: spool-${taskId}`,
    '  ```',
    '',
  ].join('\n');
}

function projectorConfig(root: string, vault: string, state: string): SpoolConfig {
  return {
    configPath: path.join(root, 'config.yaml'),
    vaults: [vault],
    stateDirectory: state,
    timeZone: 'Europe/Istanbul',
    pollIntervalSeconds: 45,
    dayAliases: {},
    providers: [
      {
        name: 'fake',
        enabled: true,
        executable: process.execPath,
        executableResolved: true,
        directive: '@fake',
        defaultArgs: [],
      },
    ],
    repositories: [],
  };
}

function terminalResult(logPath: string, sessionId: string, output: string): ProviderRunResult {
  return {
    launchState: 'started',
    processIdentity: { pid: 123, processStartIdentity: 'fixture-123' },
    terminalState: 'completed',
    observation: {
      sessionId,
      state: 'completed',
      latestOutput: { text: output, hash: 'fixture-output-hash' },
      terminalProof: { state: 'completed', proof: 'fake-result' },
      events: [],
    },
    exit: { code: 0, signal: null },
    diagnostics: [],
    cancelRequested: false,
    timedOut: false,
    log: { path: logPath, bytesWritten: 0, truncated: false },
  };
}
