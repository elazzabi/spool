#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { pathToFileURL } from 'node:url';

export const supportedProviders = ['claude', 'codex', 'cursor', 'pi'];

export function parseProviderWaiver(value) {
  const waiver = new Set(
    (value ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const name of waiver) {
    if (!supportedProviders.includes(name)) throw new Error(`Unknown provider waiver: ${name}`);
  }
  return waiver;
}

export function selectSmokeProviders(waiver) {
  const selected = supportedProviders.filter((name) => !waiver.has(name));
  if (selected.length === 0) {
    throw new Error('Every provider was waived; there is no live support claim to verify');
  }
  return selected;
}

export async function runProviderSmoke() {
  const waiver = parseProviderWaiver(process.env.SPOOL_SMOKE_WAIVE);
  const selected = selectSmokeProviders(waiver);
  const root = mkdtempSync(path.join(tmpdir(), 'spool-live-smoke-'));
  let runtime;
  try {
    const { loadConfig } = await import('../dist/config/load.js');
    const { openSpoolRuntime } = await import('../dist/scheduler/service.js');
    const { weeklyNoteFilename } = await import('../dist/notes/week.js');
    const bin = path.join(root, 'bin');
    const vault = path.join(root, 'vault');
    const state = path.join(root, 'state');
    mkdirSync(bin);
    mkdirSync(vault);
    mkdirSync(state);

    const resolved = Object.fromEntries(
      supportedProviders.map((name) => [name, findExecutable(executableName(name))]),
    );
    const missing = selected.filter((name) => !resolved[name]);
    if (missing.length > 0) {
      throw new Error(
        `Required provider executables are unavailable: ${missing.join(', ')}. ` +
          'Use SPOOL_SMOKE_WAIVE only for an explicit local support exclusion.',
      );
    }
    const invocationLogs = new Map();
    const clones = new Map();
    const providerConfig = {};
    const repositories = [];
    for (const name of selected) {
      const invocationLog = path.join(root, `${name}-argv.jsonl`);
      invocationLogs.set(name, invocationLog);
      const wrapper = path.join(bin, name);
      writeExecutableWrapper(wrapper, resolved[name], invocationLog);
      const clone = initializeClone(path.join(root, `${name}-repo`), name);
      clones.set(name, clone);
      providerConfig[name] = {
        enabled: true,
        executable: wrapper,
        directive: `@${name}`,
        defaultArgs: smokeFlags(name),
      };
      repositories.push({
        repository: `spool-smoke/${name}`,
        clones: [clone],
      });
    }

    const ghLog = path.join(root, 'gh-argv.jsonl');
    writeGhShim(path.join(bin, 'gh'), ghLog);
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ''}`;

    const now = new Date();
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const noteName = weeklyNoteFilename(now, timeZone);
    const day = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone }).format(now);
    const notePath = path.join(vault, noteName);
    writeFileSync(notePath, renderSmokeNote(selected, day));
    const configPath = path.join(root, 'spool.config.json');
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          vaults: [vault],
          stateDirectory: state,
          timeZone,
          pollIntervalSeconds: 1,
          dayAliases: { [day.toLowerCase()]: [day] },
          providers: providerConfig,
          repositories,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );

    const config = loadConfig(configPath);
    runtime = await openSpoolRuntime(config);
    if (runtime.warnings.some((warning) => /unsupported|unavailable|failed/i.test(warning))) {
      throw new Error(`Provider preflight failed: ${runtime.warnings.join('; ')}`);
    }

    const deadline = Date.now() + 5 * 60 * 1_000;
    let jobs = [];
    while (true) {
      await runtime.reconciler.runPass({ awaitLaunched: true });
      jobs = runtime.ledger.listJobs();
      const uncertain = jobs.flatMap((job) => {
        const attempt = runtime.ledger.listAttempts(job.id).at(-1);
        return attempt?.state === 'Uncertain'
          ? [`${job.provider}: ${attempt.uncertaintyReason ?? 'uncertain provider outcome'}`]
          : [];
      });
      if (uncertain.length > 0) {
        throw new Error(`Provider smoke became uncertain: ${uncertain.join('; ')}`);
      }
      if (
        jobs.length === selected.length &&
        jobs.every((job) => ['Completed', 'Failed', 'Cancelled'].includes(job.state))
      ) {
        break;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Provider smoke timed out: ${describeJobs(jobs)}`);
      }
      await delay(2_000);
    }

    const verified = [];
    const jobsByProvider = new Map(jobs.map((job) => [job.provider, job]));
    for (const name of selected) {
      const job = jobsByProvider.get(name);
      if (!job) throw new Error(`${name} did not produce a durable job`);
      const attempt = runtime.ledger.listAttempts(job.id).at(-1);
      if (!attempt?.sessionId) throw new Error(`${name} did not capture a session ID`);
      if (attempt.state !== 'Terminal' || job.state !== 'Completed') {
        throw new Error(
          `${name} did not complete successfully (${job.state}/${attempt.state}): ${attempt.uncertaintyReason ?? 'no additional detail'}`,
        );
      }
      const adapter = runtime.providers.get(name);
      const inspect = adapter?.inspectCommand(attempt.sessionId);
      if (!inspect) throw new Error(`${name} did not expose an inspect command`);
      const latestResponse = attempt.latestOutput;
      if (!latestResponse?.trim()) throw new Error(`${name} did not expose a latest response`);
      const expectedMarker = `SPOOL_SMOKE_${name.toUpperCase()}`;
      if (!latestResponse.includes(expectedMarker)) {
        throw new Error(`${name} latest response omitted ${expectedMarker}`);
      }
      const argvEntries = readJsonLines(invocationLogs.get(name));
      const launch = argvEntries.find((entry) => isLaunchInvocation(name, entry.argv));
      if (!launch) throw new Error(`${name} launch argv was not captured`);
      for (const flag of smokeFlags(name)) {
        if (!launch.argv.includes(flag))
          throw new Error(`${name} launch omitted configured flag ${flag}`);
      }
      const clone = clones.get(name);
      if (name === 'cursor') {
        if (!launch.argv.includes('--trust')) {
          throw new Error('cursor launch omitted adapter-enforced --trust');
        }
        if (launch.argv.includes('--mode')) {
          throw new Error('cursor smoke must use the default agent mode');
        }
      }
      if (name === 'pi') {
        assertPiSmokeEvidence({
          launchArgv: launch.argv,
          inspectArgs: inspect.args,
          sessionId: attempt.sessionId,
          stateDirectory: state,
          workspaceDirectories: [...clones.values()],
        });
      }
      if (git(clone, ['status', '--porcelain']) !== '') {
        throw new Error(`${name} changed its read-only smoke workspace`);
      }
      verified.push({
        provider: name,
        state: job.state,
        attemptState: attempt.state,
        sessionId: attempt.sessionId,
        latestResponse: latestResponse.trim().slice(0, 500),
        configuredFlags: smokeFlags(name),
        inspectCommand: [path.basename(inspect.executable), ...inspect.args],
        workspaceClean: true,
        ...(name === 'pi' ? { managedSessionsOwnerOnly: true } : {}),
      });
    }

    const ghCalls = existsSync(ghLog) ? readJsonLines(ghLog) : [];
    const writeCalls = ghCalls.filter((entry) => isGitHubWrite(entry.argv));
    if (writeCalls.length > 0) {
      throw new Error(`A provider attempted a GitHub write: ${JSON.stringify(writeCalls)}`);
    }
    const transformedNote = readFileSync(notePath, 'utf8');
    const completedReceipts = transformedNote.match(/^\s*Status: Completed$/gm) ?? [];
    if (completedReceipts.length !== selected.length) {
      throw new Error(
        `Expected ${selected.length} completed receipts, found ${completedReceipts.length}`,
      );
    }
    for (const name of selected) {
      if (!hasCompletedTaskReceipt(transformedNote, name)) {
        throw new Error(`The weekly note did not receive ${name} completion evidence`);
      }
    }
    if ((statSync(state).mode & 0o777) !== 0o700) {
      throw new Error('State directory is not owner-only');
    }

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          verified,
          waived: [...waiver].sort(),
          githubWriteCalls: writeCalls.length,
          stateOwnerOnly: true,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await runtime?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runProviderSmoke();
}

function executableName(provider) {
  return provider === 'cursor' ? 'cursor-agent' : provider;
}

function findExecutable(name) {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      if (statSync(candidate).isFile()) return realpathSync(candidate);
    } catch {
      // Continue searching PATH.
    }
  }
  return null;
}

export function smokeFlags(provider) {
  if (provider === 'claude') return ['--permission-mode', 'plan'];
  if (provider === 'codex') {
    return ['--model', 'gpt-5.4-mini', '--sandbox', 'read-only'];
  }
  if (provider === 'pi') {
    return [
      '--offline',
      '--tools',
      'read,grep,find,ls',
      '--no-extensions',
      '--no-context-files',
      '--no-skills',
      '--no-prompt-templates',
    ];
  }
  return [];
}

export function hasCompletedTaskReceipt(source, provider) {
  const escapedProvider = provider.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const task = new RegExp(`^\\s*- \\[[ xX]\\] @${escapedProvider}\\b[^\\n]*`, 'm').exec(source);
  if (!task || task.index === undefined) return false;
  const afterTask = source.slice(task.index + task[0].length);
  const nextTask = /\n\s*- \[[ xX]\] @\w+\b/.exec(afterTask);
  const region = nextTask?.index === undefined ? afterTask : afterTask.slice(0, nextTask.index);
  return /```spool[\s\S]*?\bStatus: Completed\b[\s\S]*?```/.test(region);
}

function writeExecutableWrapper(target, executable, logPath) {
  const source = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ argv }) + '\\n', { mode: 0o600 });
const result = spawnSync(${JSON.stringify(executable)}, argv, { stdio: 'inherit', env: process.env });
if (result.error) { process.stderr.write(result.error.message + '\\n'); process.exit(1); }
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
`;
  writeFileSync(target, source, { mode: 0o700 });
  chmodSync(target, 0o700);
}

function writeGhShim(target, logPath) {
  const source = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ argv }) + '\\n', { mode: 0o600 });
process.stderr.write('GitHub CLI is disabled inside the spool smoke boundary.\\n');
process.exit(97);
`;
  writeFileSync(target, source, { mode: 0o700 });
  chmodSync(target, 0o700);
}

function initializeClone(directory, provider) {
  mkdirSync(directory);
  git(directory, ['init', '--initial-branch=main']);
  git(directory, ['config', 'user.name', 'spool Smoke']);
  git(directory, ['config', 'user.email', 'smoke@example.invalid']);
  writeFileSync(
    path.join(directory, 'README.md'),
    `# spool ${provider} smoke\n\nMarker: SPOOL_SMOKE_${provider.toUpperCase()}\n`,
  );
  git(directory, ['add', 'README.md']);
  git(directory, ['commit', '-m', 'Initial disposable smoke fixture']);
  git(directory, ['remote', 'add', 'origin', `https://github.com/spool-smoke/${provider}.git`]);
  return realpathSync(directory);
}

function renderSmokeNote(providers, day) {
  const lines = [`# spool live provider smoke`, '', `## ${day}`, ''];
  for (const provider of providers) {
    lines.push(`- [ ] PR https://github.com/spool-smoke/${provider}/pull/1`);
    lines.push(
      `  - [ ] @${provider} Do not use the network or any GitHub tool. Read local README.md only, make no changes, and reply with exactly SPOOL_SMOKE_${provider.toUpperCase()}.`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function readJsonLines(file) {
  if (!file || !existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function isLaunchInvocation(provider, argv) {
  if (provider === 'claude') {
    return argv.includes('-p') && argv.includes('--verbose') && argv.includes('stream-json');
  }
  if (provider === 'codex') return argv.includes('exec') && argv.includes('--json');
  if (provider === 'pi') return hasArgValue(argv, '--mode', 'json');
  return argv.includes('--print') && argv.includes('stream-json');
}

export function assertPiSmokeEvidence({
  launchArgv,
  inspectArgs,
  sessionId,
  stateDirectory,
  workspaceDirectories,
}) {
  for (const flag of [
    '--offline',
    '--no-extensions',
    '--no-context-files',
    '--no-skills',
    '--no-prompt-templates',
  ]) {
    if (!launchArgv.includes(flag)) throw new Error(`Pi launch omitted safe flag ${flag}`);
    if (!inspectArgs.includes(flag)) throw new Error(`Pi inspect omitted safe flag ${flag}`);
  }
  for (const argv of [launchArgv, inspectArgs]) {
    if (!hasArgValue(argv, '--tools', 'read,grep,find,ls')) {
      throw new Error('Pi invocation did not restrict tools to read,grep,find,ls');
    }
  }
  if (!hasArgValue(launchArgv, '--mode', 'json')) {
    throw new Error('Pi launch did not enable JSON mode');
  }
  if (!hasArgValue(inspectArgs, '--session', sessionId)) {
    throw new Error('Pi inspect command did not preserve the full session ID');
  }

  const configuredSessionDirectory = path.join(realpathSync(stateDirectory), 'pi', 'sessions');
  const sessionStats = lstatSync(configuredSessionDirectory);
  if (sessionStats.isSymbolicLink() || !sessionStats.isDirectory()) {
    throw new Error('Pi managed sessions are not stored in a real directory');
  }
  if ((sessionStats.mode & 0o777) !== 0o700) {
    throw new Error('Pi managed session directory is not owner-private');
  }
  if (typeof process.getuid === 'function' && sessionStats.uid !== process.getuid()) {
    throw new Error('Pi managed session directory is not owned by the current user');
  }
  const sessionDirectory = realpathSync(configuredSessionDirectory);
  if (sessionDirectory !== path.resolve(configuredSessionDirectory)) {
    throw new Error('Pi managed session directory resolves through a symbolic link');
  }
  if (!hasArgValue(launchArgv, '--session-dir', sessionDirectory)) {
    throw new Error('Pi launch did not use the managed session directory');
  }
  if (!hasArgValue(inspectArgs, '--session-dir', sessionDirectory)) {
    throw new Error('Pi inspect command did not use the managed session directory');
  }
  for (const workspace of workspaceDirectories) {
    if (pathsOverlap(sessionDirectory, realpathSync(workspace))) {
      throw new Error(`Pi managed sessions overlap a smoke workspace: ${workspace}`);
    }
  }
}

function hasArgValue(argv, flag, expected) {
  const index = argv.lastIndexOf(flag);
  return index >= 0 && argv[index + 1] === expected;
}

function pathsOverlap(left, right) {
  return pathWithin(left, right) || pathWithin(right, left);
}

function pathWithin(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function isGitHubWrite(argv) {
  const text = argv.join(' ').toLowerCase();
  return /\b(pr review|pr comment|issue comment|pr merge|pr close|issue create|api .*-(?:x|f)|api .*--method)\b/.test(
    text,
  );
}

function describeJobs(jobs) {
  return jobs.map((job) => `${job.provider}:${job.state}`).join(', ') || 'no jobs claimed';
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
