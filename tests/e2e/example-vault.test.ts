import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { MDSpoolConfig } from '../../src/config/schema.js';
import { openLedgerDatabase } from '../../src/ledger/database.js';
import { OutboxRepository } from '../../src/ledger/outbox.js';
import { LedgerRepository } from '../../src/ledger/repositories.js';
import { FakeProvider } from '../../src/providers/fake.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import type {
  ProviderAdapter,
  ProviderEvidence,
  ProviderRunCallbacks,
  ProviderRunResult,
} from '../../src/providers/types.js';
import { JobDispatcher, type ProviderRunner } from '../../src/scheduler/dispatcher.js';
import { AttemptObserver } from '../../src/scheduler/observer.js';
import { NoteProjector, providerDirectives } from '../../src/scheduler/projector.js';
import { Reconciler } from '../../src/scheduler/reconciler.js';
import { runUntilConverged } from '../../src/scheduler/service.js';
import { MarkdownNoteScanner } from '../../src/scheduler/scanner.js';
import { WorkspacePool } from '../../src/workspaces/pool.js';

const repository = 'example/widget';
const now = () => new Date('2026-07-20T10:00:00.000Z');

describe('realistic copied example vault', () => {
  it('processes a pre-existing directive in a nested arbitrary Markdown note exactly once', async () => {
    const fixture = createFixture(1, false);
    const projects = path.join(fixture.vault, 'Projects');
    const sourceNote = path.join(projects, 'Project Launch.md');
    const controlFile = path.join(projects, 'Project Launch.txt');
    const currentNote = path.join(fixture.vault, 'Week 30 of 2026.md');
    const controlSource = [
      '# Text control',
      '',
      '- PR https://github.com/example/widget/pull/300',
      '  - [ ] @codex Never process this file',
      '',
    ].join('\n');
    mkdirSync(projects);
    writeFileSync(
      sourceNote,
      [
        '# Project Launch',
        '',
        '## Monday',
        '',
        '- Repository https://github.com/example/widget',
        '  - [ ] @codex Review the launch plan',
        '',
      ].join('\n'),
    );
    writeFileSync(controlFile, controlSource);
    let launches = 0;
    const delegatedPrompts: string[] = [];
    const runtime = createRuntime(fixture.config, async (request, callbacks) => {
      launches += 1;
      delegatedPrompts.push(Buffer.from(request.prompt).toString('utf8'));
      return fakeRun(3, callbacks);
    });

    const bootstrap = await runtime.reconciler.runPass();
    expect(bootstrap.claimedJobIds).toEqual([]);
    expect(bootstrap.scan.bootstrappedTaskIds).toHaveLength(1);
    await runUntilConverged(runtime.reconciler);

    const jobs = runtime.ledger.listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      sourcePath: sourceNote,
      provider: 'codex',
      repository,
      state: 'Completed',
    });
    expect(launches).toBe(1);
    expect(delegatedPrompts).toHaveLength(1);
    expect(delegatedPrompts[0]).toContain('Repository (ancestor): example/widget');
    expect(delegatedPrompts[0]).not.toContain('PR (ancestor):');
    expect(delegatedPrompts[0]).toContain(
      'MDSpool delegated this task from a Markdown source note.',
    );
    const transformedSource = readFileSync(sourceNote, 'utf8');
    const transformedCurrent = readFileSync(currentNote, 'utf8');
    expect(transformedSource).toContain('- [x] @codex Review the launch plan');
    expect(transformedSource).toContain('Status: Completed');
    expect(transformedSource).toContain('Latest output:');
    expect(transformedSource).toContain('Actionable fake review 3.');
    expect(transformedSource.match(/Task: /g)).toHaveLength(1);
    expect(transformedSource.match(/Anchor: mdspool-/g)).toHaveLength(1);
    expect(transformedSource).toContain(`Inspect: cd ${fixture.clones[0]} && `);
    expect(transformedCurrent).toContain('- [ ] Check agent output using command');
    expect(transformedCurrent).toContain(
      `- [ ] Check agent output using command \`cd ${fixture.clones[0]} && `,
    );
    expect(transformedCurrent).toContain('[source](<Projects/Project%20Launch.md>)');
    expect(transformedCurrent.match(/Check agent output using command/g)).toHaveLength(1);
    expect(readFileSync(controlFile, 'utf8')).toBe(controlSource);

    await runUntilConverged(runtime.reconciler);

    expect(runtime.ledger.listJobs()).toHaveLength(1);
    expect(launches).toBe(1);
    expect(readFileSync(sourceNote, 'utf8')).toBe(transformedSource);
    expect(readFileSync(currentNote, 'utf8')).toBe(transformedCurrent);
    expect(readFileSync(controlFile, 'utf8')).toBe(controlSource);

    await runtime.reconciler.shutdown();
    runtime.database.close();
  });

  it('preserves ordinary notes while fake agents exercise lifecycle, pool queueing, failure, and rollover', async () => {
    const fixture = createFixture(2, true);
    const sourceNote = path.join(fixture.vault, 'Week 29 of 2026.md');
    const currentNote = path.join(fixture.vault, 'Week 30 of 2026.md');
    const original = readFileSync(sourceNote, 'utf8');
    const prompts: Array<{ cwd: string; prompt: string }> = [];
    let launches = 0;
    let active = 0;
    let maximumActive = 0;
    const runner: ProviderRunner = async (request, callbacks) => {
      launches += 1;
      const sequence = launches;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      prompts.push({
        cwd: request.target.cwd.canonicalPath,
        prompt: Buffer.from(request.prompt).toString('utf8'),
      });
      await delay(750);
      const result = await fakeRun(sequence, callbacks);
      active -= 1;
      return result;
    };
    const runtime = createRuntime(fixture.config, runner);

    const bootstrap = await runtime.reconciler.runPass();
    expect(bootstrap.claimedJobIds).toEqual([]);
    expect(bootstrap.scan.bootstrappedTaskIds).toHaveLength(5);
    const passes = await runUntilConverged(runtime.reconciler);

    expect(runtime.ledger.listJobs()).toHaveLength(5);
    expect(runtime.ledger.listJobs().map((job) => job.provider)).toContain('pi');
    expect(runtime.ledger.listJobs().map((job) => job.state)).toEqual([
      'Completed',
      'Failed',
      'Completed',
      'Completed',
      'Completed',
    ]);
    expect(runtime.ledger.listInterventions(runtime.ledger.listJobs()[0]!.id)).toHaveLength(2);
    expect(maximumActive).toBe(2);
    expect(
      passes.some((pass) =>
        pass.dispatches.some((dispatch) => dispatch.queuedForCapacity.length > 0),
      ),
    ).toBe(true);

    const transformedSource = readFileSync(sourceNote, 'utf8');
    const transformedCurrent = readFileSync(currentNote, 'utf8');
    expect(transformedSource).toContain('- [x] Plan the week');
    expect(transformedSource).toContain('- [ ] Send the design notes to the team');
    expect(transformedSource).toContain('This paragraph mentions @claude in prose');
    expect(transformedSource).toContain('- [x] @codex This checked directive is already done');
    expect(transformedSource.match(/Anchor: mdspool-/g)).toHaveLength(5);
    expect(transformedSource.match(/Agent needs input:/g)).toHaveLength(2);
    expect(transformedSource.match(/Check agent output using command/g)).toBeNull();
    expect(transformedCurrent.match(/Agent needs input:/g)).toHaveLength(2);
    expect(transformedCurrent.match(/Check agent output using command/g)).toHaveLength(4);
    const sourceCommandLines = [
      ...transformedSource.matchAll(/- \[[ x]\] Agent needs input:[^\n]+/g),
    ].map(([line]) => line);
    expect(sourceCommandLines).toHaveLength(2);
    expect(sourceCommandLines.every((line) => line.includes(`cd ${prompts[0]!.cwd} && `))).toBe(
      true,
    );

    const currentCommandLines = [
      ...transformedCurrent.matchAll(
        /- \[[ x]\] (?:Agent needs input:|Check agent output using command|Inspect failed agent session using command)[^\n]+/g,
      ),
    ].map(([line]) => line);
    expect(currentCommandLines).toHaveLength(7);
    for (const [index, item] of prompts.entries()) {
      const sessionLines = currentCommandLines.filter((line) =>
        line.includes(`fake-session-${String(index + 1)}`),
      );
      expect(sessionLines).not.toHaveLength(0);
      expect(sessionLines.every((line) => line.includes(`cd ${item.cwd} && `))).toBe(true);
    }
    expect(transformedCurrent).toContain('[source](<Week%2029%20of%202026.md>)');
    expect(transformedCurrent).toContain('- [ ] Prepare the team sync');
    expect(original).toContain('- [ ] Prepare the demo outline');

    expect(prompts).toHaveLength(5);
    for (const item of prompts) {
      expect(item.prompt).toContain(`Source note: ${sourceNote}`);
      expect(item.prompt).toContain(`Canonical workspace: ${item.cwd}`);
      expect(item.prompt).toContain('Return results to this local agent session by default');
      expect(item.prompt).toContain(
        'Do not create GitHub comments, reviews, approvals, requests for changes, issues, or any other GitHub write unless the task explicitly asks you to do so.',
      );
      expect(item.prompt).toContain('A pull-request URL provides context only');
      expect(item.prompt).not.toContain('read-only review task');
      expect(item.prompt).not.toContain('Do not mutate the local workspace');
      expect(item.prompt).toMatch(
        /PR \((?:ancestor|direct)\): https:\/\/github\.com\/example\/widget\/pull\//,
      );
      expect(git(item.cwd, ['status', '--porcelain'])).toBe('');
    }
    expect(prompts.filter((item) => item.prompt.includes('PR (ancestor):'))).toHaveLength(4);
    expect(new Set(prompts.map((item) => item.cwd))).toEqual(new Set(fixture.clones));

    await runtime.reconciler.shutdown();
    runtime.database.close();
  }, 15_000);

  it('binds an existing queued directive after a GitHub repository URL is added', async () => {
    const fixture = createFixture(1, false);
    const sourceNote = path.join(fixture.vault, 'Tasks.md');
    writeFileSync(sourceNote, '- [ ] Update the README @codex\n');
    let launches = 0;
    const runtime = createRuntime(fixture.config, async (request, callbacks) => {
      launches += 1;
      return fakeRun(7, callbacks);
    });

    await runtime.reconciler.runPass();
    await runUntilConverged(runtime.reconciler);

    const queued = runtime.ledger.listJobs()[0];
    expect(queued).toMatchObject({ repository: null, state: 'Queued' });
    expect(launches).toBe(0);

    const withRepository = readFileSync(sourceNote, 'utf8').replace(
      'Update the README @codex',
      'Update the README https://github.com/example/widget @codex',
    );
    writeFileSync(sourceNote, withRepository);
    await runUntilConverged(runtime.reconciler);

    expect(runtime.ledger.listJobs()[0]).toMatchObject({
      id: queued?.id,
      repository,
      state: 'Completed',
    });
    expect(launches).toBe(1);
    expect(readFileSync(sourceNote, 'utf8')).toContain('Repository (direct): example/widget');

    await runtime.reconciler.shutdown();
    runtime.database.close();
  });

  it('skips a manually dirty clone without touching it and uses the next pool member', async () => {
    const fixture = createFixture(2, false);
    const dirtyClone = fixture.clones[0]!;
    const cleanClone = fixture.clones[1]!;
    const manualFile = path.join(dirtyClone, 'manual-work.txt');
    writeFileSync(manualFile, 'keep this manual work\n');
    const sourceNote = path.join(fixture.vault, 'Week 29 of 2026.md');
    writeFileSync(
      sourceNote,
      [
        '# Week 29 of 2026',
        '',
        '## Tuesday',
        '',
        '- [ ] PR https://github.com/example/widget/pull/200',
        '  - [ ] @codex Review without changing the clone',
        '',
      ].join('\n'),
    );
    const launchedFrom: string[] = [];
    const runtime = createRuntime(fixture.config, async (request, callbacks) => {
      launchedFrom.push(request.target.cwd.canonicalPath);
      return fakeRun(9, callbacks);
    });

    await runtime.reconciler.runPass();
    await runUntilConverged(runtime.reconciler);

    expect(launchedFrom).toEqual([cleanClone]);
    expect(readFileSync(manualFile, 'utf8')).toBe('keep this manual work\n');
    expect(git(dirtyClone, ['status', '--porcelain'])).toContain('?? manual-work.txt');
    expect(git(cleanClone, ['status', '--porcelain'])).toBe('');

    await runtime.reconciler.shutdown();
    runtime.database.close();
  });
});

function createFixture(
  cloneCount: number,
  copyExample: boolean,
): {
  root: string;
  vault: string;
  state: string;
  clones: string[];
  config: MDSpoolConfig;
} {
  const root = mkdtempSync(path.join(tmpdir(), 'mdspool-example-vault-'));
  const vault = path.join(root, 'vault');
  const state = path.join(root, 'state');
  mkdirSync(vault);
  mkdirSync(state);
  if (copyExample) cpSync(path.resolve('examples/vault'), vault, { recursive: true });
  else writeFileSync(path.join(vault, 'Week 30 of 2026.md'), '## Monday\n\n- [ ] Ordinary todo\n');
  const clones = Array.from({ length: cloneCount }, (_, index) =>
    initializeClone(path.join(root, `clone-${String(index + 1)}`)),
  );
  return {
    root,
    vault,
    state,
    clones,
    config: {
      configPath: path.join(root, 'mdspool.config.yaml'),
      vaults: [vault],
      stateDirectory: state,
      timeZone: 'Europe/Istanbul',
      pollIntervalSeconds: 1,
      dayAliases: { monday: ['Monday'] },
      providers: ['claude', 'codex', 'cursor', 'pi'].map((name) => ({
        name,
        enabled: true,
        executable: process.execPath,
        executableResolved: true,
        directive: `@${name}`,
        defaultArgs: [`--fixture-${name}`],
      })),
      repositories: [{ repository, clones }],
    },
  };
}

function createRuntime(config: MDSpoolConfig, runner: ProviderRunner) {
  const database = openLedgerDatabase(config.stateDirectory);
  const ledger = new LedgerRepository(database, { now });
  const outbox = new OutboxRepository(database, { now });
  const providers = new ProviderRegistry(
    config.providers.map((provider) => aliasFakeProvider(provider.name, provider.defaultArgs)),
  );
  const workspaces = new WorkspacePool({ repositories: config.repositories, ledger });
  const scanner = new MarkdownNoteScanner({
    vaults: config.vaults,
    providers: providerDirectives(config),
  });
  const projector = new NoteProjector({ config, ledger, outbox, now });
  const observer = new AttemptObserver({ config, ledger, projector, now });
  const dispatcher = new JobDispatcher({
    config,
    ledger,
    providers,
    workspaces,
    observer,
    projector,
    runner,
  });
  const reconciler = new Reconciler({
    config,
    database,
    ledger,
    outbox,
    providers,
    workspaces,
    scanner,
    projector,
    observer,
    dispatcher,
    now,
  });
  return { database, ledger, reconciler };
}

function aliasFakeProvider(name: string, defaultArgs: readonly string[]): ProviderAdapter {
  const fake = new FakeProvider({ executable: process.execPath, defaultArgs });
  return {
    name,
    capabilities: fake.capabilities,
    sessionIdPolicy: fake.sessionIdPolicy,
    createLaunch: (input) => fake.createLaunch(input),
    parseEvent: (value) => fake.parseEvent(value),
    inspectCommand: (sessionId) => fake.inspectCommand(sessionId),
    resumeCommand: (sessionId) => fake.resumeCommand(sessionId),
    cancelCommand: (sessionId) => fake.cancelCommand(sessionId),
  };
}

async function fakeRun(
  sequence: number,
  callbacks: ProviderRunCallbacks = {},
): Promise<ProviderRunResult> {
  const sessionId = `fake-session-${String(sequence)}`;
  const failed = sequence === 2;
  const events: ProviderEvidence[] = [
    { kind: 'session', eventKey: `session-${String(sequence)}`, sessionId },
    { kind: 'state', eventKey: `working-${String(sequence)}-1`, state: 'working' },
    ...(sequence === 1
      ? ([
          {
            kind: 'state',
            eventKey: 'needs-one',
            state: 'needs_input',
            episodeId: 'episode-one',
            message: 'Which compatibility target?',
          },
          { kind: 'state', eventKey: 'resume-one', state: 'working' },
          {
            kind: 'state',
            eventKey: 'needs-two',
            state: 'needs_input',
            episodeId: 'episode-two',
            message: 'Which API version?',
          },
          { kind: 'state', eventKey: 'resume-two', state: 'working' },
        ] satisfies ProviderEvidence[])
      : []),
    {
      kind: 'output',
      eventKey: `output-${String(sequence)}`,
      text: failed
        ? 'Fixture review failed safely.'
        : `Actionable fake review ${String(sequence)}.`,
    },
    {
      kind: 'terminal',
      eventKey: `terminal-${String(sequence)}`,
      state: failed ? 'failed' : 'completed',
      proof: `fake-proof-${String(sequence)}`,
    },
  ];
  await callbacks.onProcessStarted?.({
    pid: 50_000 + sequence,
    processStartIdentity: `fake-process-${String(sequence)}`,
  });
  await callbacks.onSessionIdentity?.({ sessionId });
  for (const event of events) await callbacks.onEvidence?.(event);
  const terminalState = failed ? 'failed' : 'completed';
  const latestOutput = events.findLast((event) => event.kind === 'output');
  return {
    launchState: 'started',
    processIdentity: {
      pid: 50_000 + sequence,
      processStartIdentity: `fake-process-${String(sequence)}`,
    },
    terminalState,
    observation: {
      sessionId,
      state: terminalState,
      latestOutput:
        latestOutput?.kind === 'output'
          ? { text: latestOutput.text, hash: `fake-hash-${String(sequence)}` }
          : null,
      terminalProof: { state: terminalState, proof: `fake-proof-${String(sequence)}` },
      events,
    },
    exit: { code: failed ? 2 : 0, signal: null },
    diagnostics: [],
    cancelRequested: false,
    timedOut: false,
    log: { path: `/fixture/${String(sequence)}.log`, bytesWritten: 0, truncated: false },
  };
}

function initializeClone(directory: string): string {
  mkdirSync(directory);
  git(directory, ['init', '--initial-branch=main']);
  git(directory, ['config', 'user.name', 'MDSpool Fixture']);
  git(directory, ['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(path.join(directory, 'README.md'), '# Disposable review fixture\n');
  git(directory, ['add', 'README.md']);
  git(directory, ['commit', '-m', 'Initial fixture']);
  git(directory, ['remote', 'add', 'origin', `https://github.com/${repository}.git`]);
  return realpathSync(directory);
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
