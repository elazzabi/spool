import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createProgram, isMainEntrypoint } from '../../src/cli/index.js';
import { loadConfig } from '../../src/config/load.js';
import { openLedgerDatabase } from '../../src/ledger/database.js';
import { currentProcessStartIdentity, DaemonLock } from '../../src/ledger/daemon-lock.js';
import { LedgerRepository } from '../../src/ledger/repositories.js';
import {
  OPERATIONAL_ACTIVE_FILE,
  OPERATIONAL_LOG_DIRECTORY,
  OperationalLogStore,
} from '../../src/logging/store.js';
import { WORKSPACE_SENTINEL_NAME, WorkspaceSentinelManager } from '../../src/workspaces/lease.js';
import { WorkspacePool } from '../../src/workspaces/pool.js';
import { parseWorkspaceCliAcknowledgmentRequest } from '../../src/workspaces/acknowledgment.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('operator CLI commands', () => {
  it('uses MDSpool branding with the spool executable name', () => {
    const program = createProgram();

    expect(program.name()).toBe('spool');
    expect(program.description()).toContain('Markdown');
  });

  it('retains both the short and full CLI names', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { name?: string; bin?: Record<string, string> };

    expect(manifest.name).toBe('mdspool');
    expect(manifest.bin).toEqual({
      spool: 'dist/cli/index.js',
      mdspool: 'dist/cli/index.js',
    });
  });

  it('exposes the documented managed lifecycle commands', () => {
    const program = createProgram();
    const update = program.commands.find((command) => command.name() === 'update');
    const uninstall = program.commands.find((command) => command.name() === 'uninstall');

    expect(update?.description()).toContain('installer-owned');
    expect(update?.helpInformation()).toContain('--version');
    expect(uninstall?.description()).toContain('preserving user data');
  });

  it('describes init as guided setup and exposes the accessible plain mode', () => {
    const init = createProgram().commands.find((command) => command.name() === 'init');

    expect(init?.description()).toContain('guided');
    expect(init?.helpInformation()).toContain('--plain');
    expect(init?.helpInformation()).toContain('line-oriented');
  });

  it('registers a human-only logs command with follow mode', () => {
    const logs = createProgram().commands.find((command) => command.name() === 'logs');

    expect(logs?.description()).toContain('operational logs');
    expect(logs?.helpInformation()).toContain('--follow');
    expect(logs?.helpInformation()).not.toContain('--json');
  });

  it('shows empty or retained operational history without mutating it', async () => {
    const fixture = cliFixture();
    const output = captureStdout();

    await createProgram().parseAsync(['node', 'mdspool', '--config', fixture.configPath, 'logs']);
    expect(output.text()).toBe('No operational logs found.\n');
    expect(readdirSync(fixture.state)).toEqual([]);

    chmodSync(fixture.state, 0o700);
    const runtimeId = randomUUID();
    const jobId = randomUUID();
    const store = new OperationalLogStore({
      stateDirectory: fixture.state,
      runtimeId,
      mode: 'daemon',
    });
    expect(await store.activate()).toBe(true);
    expect(await store.runtimeStarted()).toBe(true);
    expect(await store.jobClaimed(jobId, 'codex')).toBe(true);
    await store.close();
    const active = path.join(fixture.state, OPERATIONAL_LOG_DIRECTORY, OPERATIONAL_ACTIVE_FILE);
    const before = readFileSync(active);

    output.clear();
    await createProgram().parseAsync(['node', 'mdspool', '--config', fixture.configPath, 'logs']);

    expect(output.text()).toContain('runtime.started');
    expect(output.text()).toContain(`runtime=${runtimeId}`);
    expect(output.text()).toContain(`job=${jobId}`);
    expect(readFileSync(active)).toEqual(before);
  });

  it('recognizes a symlinked executable as the CLI entrypoint', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mdspool-linked-cli-'));
    const target = path.join(root, 'index.js');
    const linkedExecutable = path.join(root, 'mdspool');
    writeFileSync(target, '#!/usr/bin/env node\n');
    symlinkSync(target, linkedExecutable);

    expect(isMainEntrypoint(pathToFileURL(target).href, linkedExecutable)).toBe(true);
  });

  it('renders actionable durable status, cancels by task ID, and lists workspaces', async () => {
    const fixture = cliFixture();
    const database = openLedgerDatabase(fixture.state);
    const ledger = new LedgerRepository(database);
    const job = ledger.claimJob({
      sourceMarker: 'cli-task',
      sourcePath: path.join(fixture.vault, 'Week 29 of 2026.md'),
      provider: 'fake',
      directive: 'Review',
      context: 'Repository (direct): example/widget',
      repository: 'example/widget',
    });
    const attempt = ledger.prepareAttempt(job.id, path.join(fixture.state, 'logs', 'cli.log'));
    ledger.transitionAttempt(attempt.id, 'Launching');
    ledger.markAttemptUncertain(attempt.id, 'fixture lost launch acknowledgement');
    database.close();
    const output = captureStdout();

    await createProgram().parseAsync(['node', 'mdspool', '--config', fixture.configPath, 'status']);
    expect(output.text()).toContain('MDSpool status');
    expect(output.text()).toContain('Jobs');
    expect(output.text()).toContain('Task: cli-task');
    expect(output.text()).toContain(`Job ID: ${job.id}`);
    expect(output.text()).toContain('Provider: fake');
    expect(output.text()).toContain('State: Queued');
    expect(output.text()).toContain(`Attempt: ${attempt.id}`);
    expect(output.text()).toContain('Attempt state: Uncertain');
    expect(output.text()).toContain('fixture lost launch acknowledgement');
    expect(output.text()).toContain('cli.log');
    expect(output.text()).toContain('Workspaces');
    expect(output.text()).toContain('Status inspection complete');

    output.clear();
    await createProgram().parseAsync([
      'node',
      'mdspool',
      '--config',
      fixture.configPath,
      'status',
      '--json',
    ]);
    expect(JSON.parse(output.text())).toMatchObject({
      jobs: [{ jobId: job.id, attemptId: attempt.id }],
    });

    output.clear();
    await createProgram().parseAsync([
      'node',
      'mdspool',
      '--config',
      fixture.configPath,
      'cancel',
      'cli-task',
    ]);
    expect(output.text()).toContain('Cancellation requested for cli-task');

    output.clear();
    await createProgram().parseAsync([
      'node',
      'mdspool',
      '--config',
      fixture.configPath,
      'workspace',
      'list',
    ]);
    expect(output.text()).toContain('MDSpool workspaces');
    expect(output.text()).toContain('Repositories');
    expect(output.text()).toContain('1 configured repository');
    expect(output.text()).toContain('example/widget pool');
    expect(compactStaticPresentation(output.text())).toContain(fixture.clone);
    expect(output.text()).toContain('Status: eligible');
    expect(output.text()).toContain('Detail: Workspace is eligible');
    expect(output.text()).toContain('Leases');
    expect(output.text()).toContain('Workspace inspection complete');
    expect(output.text()).not.toContain('"repositories"');

    output.clear();
    await createProgram().parseAsync([
      'node',
      'mdspool',
      '--config',
      fixture.configPath,
      'workspace',
      'list',
      '--json',
    ]);
    const workspaceJson = JSON.parse(output.text()) as {
      repositories: Array<{ repository: string; candidates: Array<{ code: string }> }>;
      leases: unknown[];
    };
    expect(workspaceJson).toMatchObject({
      repositories: [
        {
          repository: 'example/widget',
          candidates: [{ code: 'eligible' }],
        },
      ],
      leases: [],
    });
    expect(output.text()).not.toContain('MDSpool workspaces');
  });

  it('presents explicit empty states for durable status', async () => {
    const fixture = cliFixture();
    const output = captureStdout();

    await createProgram().parseAsync(['node', 'mdspool', '--config', fixture.configPath, 'status']);
    expect(output.text()).toContain('No durable jobs.');
    expect(output.text()).toContain('No workspace leases.');
  });

  it('acknowledges a safe legacy quarantine before closing its database', async () => {
    const fixture = cliFixture();
    await createLegacyQuarantine(fixture, 'cli-acknowledge');
    const output = captureStdout();

    await createProgram().parseAsync([
      'node',
      'mdspool',
      '--config',
      fixture.configPath,
      'workspace',
      'acknowledge',
      fixture.clone,
    ]);

    expect(output.text()).toContain(`Released workspace ${fixture.clone}`);
    const database = openLedgerDatabase(fixture.state);
    expect(new LedgerRepository(database).getLease(fixture.clone)?.state).toBe('Released');
    database.close();
    expect(git(fixture.clone, ['branch', '--show-current'])).toBe('main');
    expect(
      git(fixture.clone, ['show-ref', '--verify', 'refs/heads/cli-acknowledge-reviewed']),
    ).toContain('refs/heads/cli-acknowledge-reviewed');
    expect(() => statSync(path.join(fixture.clone, '.git', WORKSPACE_SENTINEL_NAME))).toThrow();
  });

  it('queues a live-daemon acknowledgment without touching the sentinel', async () => {
    const fixture = cliFixture();
    await createLegacyQuarantine(fixture, 'cli-live-daemon');
    const output = captureStdout();
    const sentinel = path.join(fixture.clone, '.git', WORKSPACE_SENTINEL_NAME);
    const before = readFileSync(sentinel);
    const daemonDatabase = openLedgerDatabase(fixture.state);
    const daemonLock = new DaemonLock(daemonDatabase);
    const daemonOwner = {
      nonce: 'fixture-live-daemon',
      pid: process.pid,
      processStartIdentity: currentProcessStartIdentity(),
    };
    daemonLock.acquire(daemonOwner, 30_000);

    await createProgram().parseAsync([
      'node',
      'mdspool',
      '--config',
      fixture.configPath,
      'workspace',
      'acknowledge',
      fixture.clone,
    ]);

    expect(output.text()).toContain(`Requested workspace acknowledgment for ${fixture.clone}`);
    expect(output.text()).toContain('next daemon pass');
    expect(readFileSync(sentinel)).toEqual(before);
    const ledger = new LedgerRepository(daemonDatabase);
    expect(
      parseWorkspaceCliAcknowledgmentRequest(ledger.getLease(fixture.clone)?.disposition ?? null),
    ).toMatchObject({
      phase: 'requested',
      canonicalWorkspace: fixture.clone,
    });

    output.clear();
    await createProgram().parseAsync([
      'node',
      'mdspool',
      '--config',
      fixture.configPath,
      'workspace',
      'list',
    ]);
    expect(output.text()).toContain('Acknowledgment: requested');

    ledger.refuseWorkspaceCliAcknowledgment(fixture.clone, 'fixture refusal');
    output.clear();
    await createProgram().parseAsync(['node', 'mdspool', '--config', fixture.configPath, 'status']);
    expect(output.text()).toContain('Acknowledgment: refused');
    expect(output.text()).toContain('Reason: fixture refusal');
    daemonLock.release(daemonOwner);
    daemonDatabase.close();
  });

  it('reports inert orphan markers from run-once instead of silently ignoring them', async () => {
    const fixture = cliFixture();
    const note = path.join(fixture.vault, 'Week 29 of 2026.md');
    writeFileSync(
      note,
      [
        '## Saturday',
        '',
        '- [ ] @fake Review https://github.com/example/widget/pull/1',
        '  ```mdspool',
        '  Task: orphan-cli',
        '  Anchor: mdspool-orphan-cli',
        '  ```',
        '',
      ].join('\n'),
    );
    const output = captureStdout();

    await createProgram().parseAsync([
      'node',
      'mdspool',
      '--config',
      fixture.configPath,
      'run-once',
      '--json',
    ]);
    const report = JSON.parse(output.text()) as { warnings: string[]; launched: number };
    expect(report.launched).toBe(0);
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Provider fake has no built-in adapter'),
        expect.stringContaining('task orphan-cli'),
      ]),
    );

    output.clear();
    await createProgram().parseAsync([
      'node',
      'mdspool',
      '--config',
      fixture.configPath,
      'run-once',
    ]);
    expect(output.text()).toContain('MDSpool reconciliation');
    expect(output.text()).toContain('Summary');
    expect(output.text()).toContain('Passes:');
    expect(output.text()).toContain('Claimed jobs:');
    expect(output.text()).toContain('Launched attempts:');
    expect(output.text()).toContain('Applied projections:');
    expect(output.text()).toContain('Blocked projections:');
    expect(output.text()).toContain('Provider fake has no built-in adapter');
    expect(output.text()).toContain('Reconciliation complete');
  });

  it('manages watched folders and refuses removal while durable work references one', async () => {
    const fixture = cliFixture();
    const output = captureStdout();

    await createProgram().parseAsync([
      'node',
      'mdspool',
      '--config',
      fixture.configPath,
      'config',
      'watch',
      'add',
      fixture.secondVault,
    ]);
    expect(output.text()).toContain('Now watching 2 folders');

    output.clear();
    await createProgram().parseAsync([
      'node',
      'mdspool',
      '--config',
      fixture.configPath,
      'config',
      'watch',
      'list',
      '--json',
    ]);
    expect(JSON.parse(output.text())).toEqual(
      expect.arrayContaining([fixture.vault, fixture.secondVault]),
    );

    output.clear();
    await createProgram().parseAsync([
      'node',
      'mdspool',
      '--config',
      fixture.configPath,
      'config',
      'watch',
      'list',
    ]);
    expect(output.text()).toContain('MDSpool watched folders');
    expect(output.text()).toContain('Folders');
    expect(compactStaticPresentation(output.text())).toContain(fixture.vault);
    expect(compactStaticPresentation(output.text())).toContain(fixture.secondVault);
    expect(output.text()).toContain('Watch inspection complete');

    const remove = () =>
      createProgram().parseAsync([
        'node',
        'mdspool',
        '--config',
        fixture.configPath,
        'config',
        'watch',
        'remove',
        fixture.secondVault,
      ]);
    const daemonDatabase = openLedgerDatabase(fixture.state);
    const daemonLock = new DaemonLock(daemonDatabase);
    const daemonOwner = {
      nonce: 'fixture-daemon',
      pid: process.pid,
      processStartIdentity: currentProcessStartIdentity(),
    };
    daemonLock.acquire(daemonOwner, 30_000);
    await expect(remove()).rejects.toThrow(/another MDSpool daemon/i);
    daemonLock.release(daemonOwner);
    daemonDatabase.close();

    const database = openLedgerDatabase(fixture.state);
    const ledger = new LedgerRepository(database);
    const job = ledger.claimJob({
      sourceMarker: 'watched-folder-job',
      sourcePath: path.join(fixture.secondVault, 'Week 29 of 2026.md'),
      provider: 'fake',
      directive: 'Review',
      context: 'fixture',
    });
    ledger.recordProjection(job.id, 'projection:watched-folder-job');
    database.close();

    await expect(remove()).rejects.toThrow(/unfinished job/i);

    const terminalDatabase = openLedgerDatabase(fixture.state);
    const terminalLedger = new LedgerRepository(terminalDatabase);
    terminalLedger.requestCancellation(job.id);
    terminalDatabase.close();
    await expect(remove()).rejects.toThrow(/undelivered projection/i);

    const drainedDatabase = openLedgerDatabase(fixture.state);
    new LedgerRepository(drainedDatabase).transitionProjection(
      'projection:watched-folder-job',
      'Applied',
    );
    drainedDatabase.close();
    await expect(remove()).resolves.toBeDefined();
  });

  it('redacts credential-shaped provider arguments from text and JSON config output', async () => {
    const fixture = cliFixture();
    const source = readFileSync(fixture.configPath, 'utf8').replace(
      '    defaultArgs: []',
      '    defaultArgs: ["--token=private-inline", "--header", "Bearer private-paired", "--model", "safe-model"]',
    );
    writeFileSync(fixture.configPath, source);
    const output = captureStdout();

    for (const json of [false, true]) {
      await createProgram().parseAsync([
        'node',
        'mdspool',
        '--config',
        fixture.configPath,
        'config',
        'show',
        ...(json ? ['--json'] : []),
      ]);
      expect(output.text()).not.toContain('private-inline');
      expect(output.text()).not.toContain('private-paired');
      expect(output.text()).toContain('[REDACTED]');
      expect(output.text()).toContain('safe-model');
      output.clear();
    }
  });

  it('presents config show as an ordered branded hierarchy', async () => {
    const fixture = cliFixture();
    writeFileSync(
      fixture.configPath,
      readFileSync(fixture.configPath, 'utf8').replace(
        'providers:\n',
        [
          'providers:',
          '  paused:',
          '    enabled: false',
          `    executable: ${JSON.stringify(process.execPath)}`,
          '    directive: "@paused"',
          '    defaultArgs: []',
          '',
        ].join('\n'),
      ),
    );
    const output = captureStdout();

    await createProgram().parseAsync([
      'node',
      'mdspool',
      '--config',
      fixture.configPath,
      'config',
      'show',
    ]);

    const rendered = output.text();
    const headings = [
      'MDSpool configuration',
      'General',
      'Watched folders',
      'Providers',
      'Repository pools',
      'Configuration inspection complete',
    ];
    expect(headings.every((heading) => rendered.includes(heading))).toBe(true);
    expect(headings.map((heading) => rendered.indexOf(heading))).toEqual(
      [...headings].map((heading) => rendered.indexOf(heading)).sort((left, right) => left - right),
    );
    const compact = compactStaticPresentation(rendered);
    expect(compact).toContain(`Config:${fixture.configPath}`);
    expect(compact).toContain(`State:${fixture.state}`);
    expect(rendered).toContain('Time zone: Europe/Istanbul');
    expect(rendered).toContain('Poll interval: 45 seconds');
    expect(compact).toContain(fixture.vault);
    expect(rendered).toContain('paused | disabled | no flags');
    expect(rendered).toContain('fake | enabled | no flags');
    expect(rendered).toContain('example/widget');
    expect(compact).toContain(fixture.clone);
  });

  it('presents standalone doctor status and preserves its failing exit code', async () => {
    const fixture = cliFixture();
    const output = captureStdout();
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      await createProgram().parseAsync([
        'node',
        'mdspool',
        '--config',
        fixture.configPath,
        'doctor',
      ]);

      expect(output.text()).toContain('MDSpool doctor');
      expect(output.text()).toContain('Overall: attention needed');
      expect(output.text()).toContain('fake: unavailable');
      expect(output.text()).toContain('no runtime adapter is registered for this provider');
      expect(output.text()).toContain('Doctor inspection complete');
      expect(process.exitCode).toBe(1);

      output.clear();
      process.exitCode = undefined;
      await createProgram().parseAsync([
        'node',
        'mdspool',
        '--config',
        fixture.configPath,
        'doctor',
        '--json',
      ]);
      const jsonOutput = output.text();
      expect(JSON.parse(jsonOutput)).toMatchObject({
        ok: false,
        configPath: fixture.configPath,
        stateDirectory: fixture.state,
        providers: [{ name: 'fake', available: false }],
      });
      expect(jsonOutput).toBe(`${JSON.stringify(JSON.parse(jsonOutput), null, 2)}\n`);
      expect(jsonOutput).not.toContain('MDSpool doctor');
      expect(jsonOutput).not.toContain('\u001b');
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('adds a distinct repository pool through an explicit config and reports it through config show', async () => {
    const fixture = cliFixture();
    const addedClone = createGitClone(
      fixture.root,
      'added-clone',
      'https://github.com/example/new-repo.git',
    );
    const output = captureStdout();

    await createProgram().parseAsync([
      'node',
      'mdspool',
      '--config',
      fixture.configPath,
      'config',
      'repository',
      'add',
      addedClone,
    ]);

    expect(output.text()).toContain(`Added ${addedClone} to example/new-repo.`);
    expect(output.text()).toContain('Restart a running daemon to apply this change.');
    expect(loadConfig(fixture.configPath).repositories).toEqual([
      { repository: 'example/widget', clones: [fixture.clone] },
      { repository: 'example/new-repo', clones: [addedClone] },
    ]);

    output.clear();
    await createProgram().parseAsync([
      'node',
      'mdspool',
      '--config',
      fixture.configPath,
      'config',
      'show',
    ]);
    expect(output.text()).toContain('example/new-repo');
    expect(compactStaticPresentation(output.text())).toContain(addedClone);
  });

  it('merges a relative same-origin clone into the existing pool without rewriting its identity', async () => {
    const fixture = cliFixture();
    const addedClone = createGitClone(
      fixture.root,
      'same-origin-clone',
      'https://github.com/Example/Widget.git',
    );
    const original = readFileSync(fixture.configPath, 'utf8').replace(
      'repository: example/widget',
      'repository: https://github.com/Example/Widget.git',
    );
    writeFileSync(fixture.configPath, original);
    const output = captureStdout();
    const previousCwd = process.cwd();
    try {
      process.chdir(fixture.root);
      await createProgram().parseAsync([
        'node',
        'mdspool',
        '--config',
        fixture.configPath,
        'config',
        'repository',
        'add',
        path.basename(addedClone),
      ]);
    } finally {
      process.chdir(previousCwd);
    }

    const source = readFileSync(fixture.configPath, 'utf8');
    expect(source).toContain('repository: https://github.com/Example/Widget.git');
    expect(loadConfig(fixture.configPath).repositories).toEqual([
      { repository: 'example/widget', clones: [fixture.clone, addedClone] },
    ]);
    expect(output.text()).toContain(`Added ${addedClone} to example/widget.`);
  });

  it.each([
    {
      name: 'a missing path',
      requestedPath: (fixture: ReturnType<typeof cliFixture>) => path.join(fixture.root, 'missing'),
      expected: /Unable to inspect clone/,
    },
    {
      name: 'a nested worktree directory',
      requestedPath: (fixture: ReturnType<typeof cliFixture>) => {
        const nested = path.join(fixture.clone, 'nested');
        mkdirSync(nested);
        return nested;
      },
      expected: /Unable to derive a GitHub origin/,
    },
    {
      name: 'an already configured clone',
      requestedPath: (fixture: ReturnType<typeof cliFixture>) => fixture.clone,
      expected: /already configured/,
    },
    {
      name: 'a repository without origin',
      requestedPath: (fixture: ReturnType<typeof cliFixture>) =>
        createGitClone(fixture.root, 'missing-origin'),
      expected: /Unable to derive a GitHub origin/,
    },
    {
      name: 'a bare repository',
      requestedPath: (fixture: ReturnType<typeof cliFixture>) =>
        createBareRepository(fixture.root, 'bare-repository'),
      expected: /Unable to derive a GitHub origin/,
    },
  ])('rejects $name without changing the config', async ({ requestedPath, expected }) => {
    const fixture = cliFixture();
    const before = readFileSync(fixture.configPath, 'utf8');

    await expect(
      createProgram().parseAsync([
        'node',
        'mdspool',
        '--config',
        fixture.configPath,
        'config',
        'repository',
        'add',
        requestedPath(fixture),
      ]),
    ).rejects.toThrow(expected);
    expect(readFileSync(fixture.configPath, 'utf8')).toBe(before);
  });

  it('rejects an overlapping configured clone without changing the config', async () => {
    const fixture = cliFixture();
    const addedClone = createGitClone(
      fixture.root,
      'overlap-root',
      'git@github.com:example/overlap.git',
    );
    const configuredDescendant = path.join(addedClone, 'configured-descendant');
    mkdirSync(configuredDescendant);
    const source = readFileSync(fixture.configPath, 'utf8').replace(
      JSON.stringify(fixture.clone),
      JSON.stringify(configuredDescendant),
    );
    writeFileSync(fixture.configPath, source);
    const before = readFileSync(fixture.configPath, 'utf8');

    await expect(
      createProgram().parseAsync([
        'node',
        'mdspool',
        '--config',
        fixture.configPath,
        'config',
        'repository',
        'add',
        addedClone,
      ]),
    ).rejects.toThrow(/clone paths overlap/i);
    expect(readFileSync(fixture.configPath, 'utf8')).toBe(before);
  });

  it('does not expose credential-bearing non-GitHub origins or mutate the config', async () => {
    const fixture = cliFixture();
    const secret = 'private-cli-token';
    const addedClone = createGitClone(
      fixture.root,
      'private-origin',
      `https://operator:${secret}@gitlab.example.com/example/private.git`,
    );
    const before = readFileSync(fixture.configPath, 'utf8');

    let caught: unknown;
    try {
      await createProgram().parseAsync([
        'node',
        'mdspool',
        '--config',
        fixture.configPath,
        'config',
        'repository',
        'add',
        addedClone,
      ]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('Unable to derive a GitHub origin');
    expect((caught as Error).message).not.toContain(secret);
    expect(readFileSync(fixture.configPath, 'utf8')).toBe(before);
  });

  it('verifies the config target before inspecting Git and refuses a live config writer lock', async () => {
    const fixture = cliFixture();
    const clone = createGitClone(fixture.root, 'locked-add', 'git@github.com:example/locked.git');
    const invalidClone = path.join(fixture.clone, 'not-a-worktree-root');
    mkdirSync(invalidClone);
    const missingConfig = path.join(fixture.root, 'missing-config.yaml');
    await expect(
      createProgram().parseAsync([
        'node',
        'mdspool',
        '--config',
        missingConfig,
        'config',
        'repository',
        'add',
        invalidClone,
      ]),
    ).rejects.toThrow(/configuration/i);

    writeFileSync(`${fixture.configPath}.lock`, 'locked\n');
    const before = readFileSync(fixture.configPath, 'utf8');
    await expect(
      createProgram().parseAsync([
        'node',
        'mdspool',
        '--config',
        fixture.configPath,
        'config',
        'repository',
        'add',
        clone,
      ]),
    ).rejects.toThrow(/another MDSpool configuration update/i);
    expect(readFileSync(fixture.configPath, 'utf8')).toBe(before);
  });

  it('documents repository addition in nested help', () => {
    const config = createProgram().commands.find((command) => command.name() === 'config');
    const repository = config?.commands.find((command) => command.name() === 'repository');
    const add = repository?.commands.find((command) => command.name() === 'add');

    expect(config?.helpInformation()).toContain('repository');
    expect(repository?.helpInformation()).toContain('add <path>');
    expect(add?.description()).toContain('GitHub');
  });

  it('sanitizes hostile clone paths in repository-add success output', async () => {
    const fixture = cliFixture();
    const hostileName = 'hostile\u001b[31m-clone';
    const clone = createGitClone(fixture.root, hostileName, 'git@github.com:example/hostile.git');
    const output = captureStdout();

    await createProgram().parseAsync([
      'node',
      'mdspool',
      '--config',
      fixture.configPath,
      'config',
      'repository',
      'add',
      clone,
    ]);

    expect(output.text()).not.toContain('\u001b');
    expect(output.text()).toContain('hostile[31m-clone');
    expect(output.text()).toContain('example/hostile');
  });
});

function cliFixture(): {
  root: string;
  vault: string;
  state: string;
  clone: string;
  secondVault: string;
  configPath: string;
} {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'mdspool-cli-')));
  const vault = path.join(root, 'vault');
  const state = path.join(root, 'state');
  const clone = path.join(root, 'clone');
  const secondVault = path.join(root, 'second-vault');
  mkdirSync(vault);
  mkdirSync(secondVault);
  mkdirSync(state);
  mkdirSync(clone);
  git(clone, ['init']);
  git(clone, ['config', 'user.email', 'fixture@example.com']);
  git(clone, ['config', 'user.name', 'Fixture']);
  writeFileSync(path.join(clone, 'tracked.txt'), 'fixture\n');
  git(clone, ['add', 'tracked.txt']);
  git(clone, ['commit', '-m', 'fixture']);
  git(clone, ['remote', 'add', 'origin', 'git@github.com:example/widget.git']);
  writeFileSync(path.join(vault, 'Week 29 of 2026.md'), '## Saturday\n\n- [ ] unrelated\n');
  const configPath = path.join(root, 'mdspool.config.yaml');
  writeFileSync(
    configPath,
    [
      `vaults: [${JSON.stringify(vault)}]`,
      `stateDirectory: ${JSON.stringify(state)}`,
      'timeZone: Europe/Istanbul',
      'pollIntervalSeconds: 45',
      'dayAliases:',
      '  saturday: [Saturday]',
      'providers:',
      '  fake:',
      `    executable: ${JSON.stringify(process.execPath)}`,
      '    directive: "@fake"',
      '    defaultArgs: []',
      'repositories:',
      '  - repository: example/widget',
      `    clones: [${JSON.stringify(clone)}]`,
      '',
    ].join('\n'),
  );
  return { root, vault, secondVault, state, clone, configPath };
}

function captureStdout(): { text(): string; clear(): void } {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(
    (
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      const complete = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
      complete?.();
      return true;
    },
  );
  return {
    text: () => chunks.join(''),
    clear: () => {
      chunks.length = 0;
    },
  };
}

function compactStaticPresentation(value: string): string {
  return value.replaceAll(/[^\x20-\x7e]|\s/gu, '');
}

async function createLegacyQuarantine(
  fixture: ReturnType<typeof cliFixture>,
  taskId: string,
): Promise<void> {
  const database = openLedgerDatabase(fixture.state);
  const ledger = new LedgerRepository(database);
  const job = ledger.claimJob({
    sourceMarker: taskId,
    sourcePath: path.join(fixture.vault, 'Week 29 of 2026.md'),
    provider: 'fake',
    directive: 'Review',
    context: 'fixture',
    repository: 'example/widget',
  });
  const attempt = ledger.prepareAttempt(job.id, path.join(fixture.state, 'logs', `${taskId}.log`));
  const processIdentity = {
    current: () =>
      Promise.resolve({
        pid: 2_147_483_646,
        startIdentity: 'fixture-stopped-daemon',
      }),
    compare: () => Promise.resolve<'not-running'>('not-running'),
  };
  const pool = new WorkspacePool({
    repositories: [{ repository: 'example/widget', clones: [fixture.clone] }],
    ledger,
    sentinels: new WorkspaceSentinelManager({
      ownerNonce: 'fixture-stopped-daemon',
      processIdentity,
    }),
  });
  const acquired = await pool.acquire({
    repository: 'example/widget',
    jobId: job.id,
    attemptId: attempt.id,
  });
  if (acquired.kind !== 'acquired') throw new Error('Expected fixture workspace acquisition');
  git(fixture.clone, ['checkout', '-b', `${taskId}-reviewed`]);
  await pool.reconcileDisposition(acquired.handle);
  database.close();
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function createGitClone(root: string, name: string, origin?: string): string {
  const clone = path.join(root, name);
  mkdirSync(clone);
  git(clone, ['init']);
  git(clone, ['config', 'user.email', 'fixture@example.com']);
  git(clone, ['config', 'user.name', 'Fixture']);
  writeFileSync(path.join(clone, 'tracked.txt'), 'fixture\n');
  git(clone, ['add', 'tracked.txt']);
  git(clone, ['commit', '-m', 'fixture']);
  if (origin !== undefined) git(clone, ['remote', 'add', 'origin', origin]);
  return realpathSync(clone);
}

function createBareRepository(root: string, name: string): string {
  const repository = path.join(root, name);
  git(root, ['init', '--bare', repository]);
  return realpathSync(repository);
}
