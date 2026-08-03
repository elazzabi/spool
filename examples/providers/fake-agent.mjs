#!/usr/bin/env node

import { Buffer } from 'node:buffer';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { setTimeout } from 'node:timers';

const args = process.argv.slice(2);
const scenario = lastOption('--scenario') ?? 'complete';
const statePath = lastOption('--state');

if (args[0] === '--inspect' || args[0] === '--resume' || args[0] === '--cancel') {
  process.stdout.write(`${args[0]} ${args[1] ?? ''}\n`);
  process.exit(0);
}

const prompt = await readStdin();

switch (scenario) {
  case 'duplicate': {
    const session = {
      type: 'session',
      event_id: 'session:duplicate',
      session_id: 'fake-duplicate',
    };
    emit(session);
    emit(session);
    emit({
      type: 'terminal',
      event_id: 'terminal:duplicate',
      status: 'completed',
      proof: 'fake-result',
    });
    break;
  }
  case 'capture':
    emit({ type: 'session', event_id: 'session:capture', session_id: 'fake-capture' });
    emit({
      type: 'output',
      event_id: 'output:capture',
      text: JSON.stringify({
        argv: args,
        cwd: process.cwd(),
        env: {
          allowed: process.env.SPOOL_ALLOWED_FOR_TEST,
          explicit: process.env.SPOOL_EXPLICIT_FOR_TEST,
          notAllowed: process.env.SPOOL_NOT_ALLOWED_FOR_TEST,
        },
        promptBase64: prompt.toString('base64'),
      }),
      ignored_future_field: { okay: true },
    });
    emit({
      type: 'terminal',
      event_id: 'terminal:capture',
      status: 'completed',
      proof: 'fake-result',
    });
    break;
  case 'partial': {
    const event = `${JSON.stringify({
      type: 'session',
      event_id: 'session:partial',
      session_id: 'fake-partial',
    })}\n`;
    process.stdout.write(event.slice(0, 11));
    await delay(20);
    process.stdout.write(event.slice(11));
    emit({ type: 'state', event_id: 'state:partial', status: 'working' });
    emit({ type: 'output', event_id: 'output:partial', text: 'partial stream joined' });
    emit({
      type: 'terminal',
      event_id: 'terminal:partial',
      status: 'completed',
      proof: 'fake-result',
    });
    break;
  }
  case 'complete':
    emit({ type: 'session', event_id: 'session:complete', session_id: 'fake-complete' });
    emit({ type: 'state', event_id: 'state:complete', status: 'working' });
    emit({ type: 'output', event_id: 'output:complete', text: 'Review complete.' });
    emit({
      type: 'terminal',
      event_id: 'terminal:complete',
      status: 'completed',
      proof: 'fake-result',
    });
    break;
  case 'fail':
    emit({ type: 'session', event_id: 'session:fail', session_id: 'fake-fail' });
    emit({ type: 'output', event_id: 'output:fail', text: 'Fixture failure.' });
    emit({
      type: 'terminal',
      event_id: 'terminal:fail',
      status: 'failed',
      proof: 'fake-result',
    });
    process.exitCode = 2;
    break;
  case 'silent':
    break;
  case 'malformed':
    emit({ type: 'session', event_id: 'session:malformed' });
    emit({
      type: 'terminal',
      event_id: 'terminal:malformed',
      status: 'completed',
      proof: 'fake-result',
    });
    break;
  case 'no-terminal':
    emit({ type: 'session', event_id: 'session:no-terminal', session_id: 'fake-no-terminal' });
    emit({ type: 'state', event_id: 'state:no-terminal', status: 'working' });
    break;
  case 'stderr-fail':
    process.stderr.write('\u001b]0;hostile\u0007\u001b[31mfailed\u001b[0m\u202e\n');
    process.exitCode = 3;
    break;
  case 'wait-cancel':
    emit({ type: 'session', event_id: 'session:cancel', session_id: 'fake-cancel' });
    emit({ type: 'state', event_id: 'state:cancel', status: 'working' });
    process.on('SIGTERM', () => {
      emit({
        type: 'terminal',
        event_id: 'terminal:cancel',
        status: 'cancelled',
        proof: 'fake-signal-handler',
      });
      process.exit(0);
    });
    await delay(30_000);
    break;
  case 'truncated':
    process.stdout.write(
      `${JSON.stringify({ type: 'output', event_id: 'output:huge', text: 'x'.repeat(4096) })}\n`,
    );
    emit({
      type: 'terminal',
      event_id: 'terminal:truncated',
      status: 'completed',
      proof: 'fake-result',
    });
    break;
  case 'lifecycle': {
    const phase = readPhase(statePath);
    emit({ type: 'session', event_id: `session:lifecycle:${phase}`, session_id: 'fake-lifecycle' });
    emit({ type: 'state', event_id: `state:working:${phase}`, status: 'working' });
    if (phase < 2) {
      emit({
        type: 'state',
        event_id: `state:needs-input:${phase}`,
        status: 'needs_input',
        episode_id: `episode-${phase + 1}`,
        message: `Need fixture input ${phase + 1}`,
      });
      writePhase(statePath, phase + 1);
    } else {
      emit({ type: 'output', event_id: 'output:lifecycle', text: 'Lifecycle complete.' });
      emit({
        type: 'terminal',
        event_id: 'terminal:lifecycle',
        status: 'completed',
        proof: 'fake-result',
      });
      writePhase(statePath, phase + 1);
    }
    break;
  }
  default:
    process.stderr.write(`Unknown fake scenario: ${scenario}\n`);
    process.exitCode = 64;
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function lastOption(name) {
  let value;
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === name) value = args[index + 1];
  }
  return value;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks)));
    process.stdin.on('error', reject);
  });
}

function readPhase(file) {
  if (!file || !existsSync(file)) return 0;
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  return Number.isSafeInteger(parsed.phase) ? parsed.phase : 0;
}

function writePhase(file, phase) {
  if (file) writeFileSync(file, `${JSON.stringify({ phase })}\n`, { mode: 0o600 });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
