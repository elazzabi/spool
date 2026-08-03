import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import type { NoteScanOptions, ParsedDirective } from './directives.js';
import { findUniqueDayHeading } from './day-heading.js';
import { isMarkdownNotePath } from './markdown.js';
import { hashNoteSource, scanNote } from './parse.js';
import { renderFollowUpTodo, renderReceipt, safeMarkerValue, type ReceiptModel } from './render.js';
import { inNoteWriteLane } from './write-lane.js';
import { isWeeklyNotePath } from './week.js';

export interface TextPatch {
  start: number;
  end: number;
  text: string;
}

export interface AtomicUpdateResult {
  changed: boolean;
  sourceHash: string;
}

export interface ProjectionResult extends AtomicUpdateResult {
  blocked: boolean;
  reason?: string;
}

export type NoteProjectionIntent =
  | { kind: 'receipt'; taskId: string; receipt: ReceiptModel }
  | { kind: 'check-source'; taskId: string }
  | {
      kind: 'follow-up';
      taskId: string;
      eventKey: string;
      checked: boolean;
      text: string;
      command?: readonly string[];
      commandDirectory?: string;
    }
  | {
      kind: 'resolve-follow-up';
      taskId: string;
      eventKey: string;
      checked: boolean;
      text: string;
      command?: readonly string[];
      commandDirectory?: string;
    }
  | {
      kind: 'complete';
      taskId: string;
      eventKey: string;
      reviewText: string;
      inspectCommand?: readonly string[];
      inspectCommandDirectory?: string;
    };

export interface CurrentWeekFollowUp {
  currentNotePath: string;
  sourceNotePath: string;
  dayHeading: string;
  eventKey: string;
  taskId: string;
  checked: boolean;
  text: string;
  command?: readonly string[];
  commandDirectory?: string;
}

export function applyTextPatches(
  source: string,
  patches: readonly TextPatch[],
  expectedHash: string,
): string {
  if (hashNoteSource(source) !== expectedHash) {
    throw new Error('Note changed before its patch could be applied.');
  }
  const descending = [...patches].sort((left, right) => right.start - left.start);
  let priorStart = source.length + 1;
  let output = source;
  for (const patch of descending) {
    if (
      patch.start < 0 ||
      patch.end < patch.start ||
      patch.end > source.length ||
      patch.end > priorStart
    ) {
      throw new Error('Refusing an invalid or overlapping note patch.');
    }
    output = `${output.slice(0, patch.start)}${patch.text}${output.slice(patch.end)}`;
    priorStart = patch.start;
  }
  return output;
}

interface WriteTarget {
  requestedPath: string;
  canonicalPath: string;
  parentPath: string;
  parentDevice: bigint | number;
  parentInode: bigint | number;
  targetDevice: bigint | number;
  targetInode: bigint | number;
  mode: number;
}

async function resolveWriteTarget(path: string): Promise<WriteTarget> {
  const requestedPath = resolve(path);
  const requestedParent = dirname(requestedPath);
  const parentPath = await realpath(requestedParent);
  const canonicalPath = join(parentPath, basename(requestedPath));
  const target = await lstat(canonicalPath, { bigint: true });
  if (!target.isFile() || target.isSymbolicLink()) {
    throw new Error(`Refusing to write a non-regular note: ${requestedPath}`);
  }
  const canonicalTarget = await realpath(canonicalPath);
  if (canonicalTarget !== canonicalPath) {
    throw new Error(`Refusing to write through a note symlink: ${requestedPath}`);
  }
  const parent = await stat(parentPath, { bigint: true });
  return {
    requestedPath,
    canonicalPath,
    parentPath,
    parentDevice: parent.dev,
    parentInode: parent.ino,
    targetDevice: target.dev,
    targetInode: target.ino,
    mode: Number(target.mode & 0o7777n),
  };
}

async function targetStillMatches(target: WriteTarget): Promise<boolean> {
  const [parentPath, parent, file] = await Promise.all([
    realpath(dirname(target.requestedPath)),
    stat(target.parentPath, { bigint: true }),
    lstat(target.canonicalPath, { bigint: true }),
  ]);
  return (
    parentPath === target.parentPath &&
    parent.dev === target.parentDevice &&
    parent.ino === target.parentInode &&
    file.isFile() &&
    !file.isSymbolicLink() &&
    file.dev === target.targetDevice &&
    file.ino === target.targetInode
  );
}

async function durableReplace(
  target: WriteTarget,
  source: string,
  expectedSourceHash: string,
): Promise<void> {
  const temporaryPath = join(
    target.parentPath,
    `.${basename(target.canonicalPath)}.mdspool-${process.pid}-${randomUUID()}.tmp`,
  );
  let temporaryCreated = false;
  try {
    const handle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      target.mode,
    );
    temporaryCreated = true;
    try {
      await handle.chmod(target.mode);
      await handle.writeFile(source, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (!(await targetStillMatches(target))) {
      throw new Error('Note path identity changed before atomic replace.');
    }
    const currentSource = await readFile(target.canonicalPath, 'utf8');
    if (hashNoteSource(currentSource) !== expectedSourceHash) {
      throw new Error('Note contents changed before atomic replace.');
    }
    await rename(temporaryPath, target.canonicalPath);
    temporaryCreated = false;
    const parentHandle = await open(target.parentPath, constants.O_RDONLY);
    try {
      await parentHandle.sync();
    } finally {
      await parentHandle.close();
    }
  } finally {
    if (temporaryCreated) {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

export async function optimisticAtomicUpdate(
  path: string,
  transform: (source: string) => string,
  expectedHash?: string,
): Promise<AtomicUpdateResult> {
  const initialTarget = await resolveWriteTarget(path);
  return inNoteWriteLane(initialTarget.canonicalPath, async () => {
    const target = await resolveWriteTarget(path);
    const source = await readFile(target.canonicalPath, 'utf8');
    const currentHash = hashNoteSource(source);
    if (expectedHash && currentHash !== expectedHash) {
      throw new Error('Note changed before the serialized write began.');
    }
    const next = transform(source);
    if (next === source) {
      return { changed: false, sourceHash: currentHash };
    }
    if (!(await targetStillMatches(target))) {
      throw new Error('Note path identity changed while preparing an update.');
    }
    await durableReplace(target, next, currentHash);
    return { changed: true, sourceHash: hashNoteSource(next) };
  });
}

function allTracked(scan: ReturnType<typeof scanNote>): ParsedDirective[] {
  return [...scan.directives, ...scan.trackedTasks];
}

function findOwnedTask(scan: ReturnType<typeof scanNote>, taskId: string): ParsedDirective | null {
  const matches = allTracked(scan).filter((directive) => directive.taskId === taskId);
  if (matches.length !== 1 || matches[0]?.conflicted) return null;
  return matches[0] ?? null;
}

function indentBlock(value: string, indentation: string, newline: string): string {
  return `${value
    .split(/\r?\n/)
    .map((line) => `${indentation}${line}`)
    .join(newline)}${newline}`;
}

function eventPatch(
  source: string,
  directive: ParsedDirective,
  eventKey: string,
  checked: boolean,
  text: string,
  command: readonly string[] | undefined,
  commandDirectory: string | undefined,
  newline: string,
): TextPatch | null {
  const existing = directive.eventRegions.filter((event) => event.eventKey === eventKey);
  if (existing.length > 1) {
    throw new Error(`Event marker ${eventKey} is ambiguous.`);
  }
  const current = existing[0];
  if (current) {
    if (current.checked === checked) return null;
    const line = source.slice(current.start, current.end);
    const match = /\[[ xX]\]/.exec(line);
    if (!match || match.index === undefined) {
      throw new Error(`Event marker ${eventKey} is not attached to a task todo.`);
    }
    return {
      start: current.start + match.index,
      end: current.start + match.index + 3,
      text: checked ? '[x]' : '[ ]',
    };
  }
  const insertion = directive.receipt?.end ?? directive.itemSpan.end;
  return {
    start: insertion,
    end: insertion,
    text: renderFollowUpTodo(
      {
        checked,
        eventKey,
        taskId: directive.taskId ?? 'unknown',
        text,
        ...(command ? { command } : {}),
        ...(commandDirectory ? { commandDirectory } : {}),
        indentation: directive.childIndentation,
      },
      newline,
    ),
  };
}

function projectSource(
  source: string,
  intent: NoteProjectionIntent,
  options: NoteScanOptions,
): { source: string; blocked: boolean; reason?: string } {
  const scan = scanNote(source, options);
  if (scan.conflicts.length > 0) {
    return { source, blocked: true, reason: scan.conflicts[0]?.message ?? 'Note marker conflict.' };
  }
  const directive = findOwnedTask(scan, intent.taskId);
  if (!directive) {
    return { source, blocked: true, reason: `Task ${intent.taskId} is missing or ambiguous.` };
  }
  const patches: TextPatch[] = [];
  if (intent.kind === 'receipt') {
    const rendered = indentBlock(
      renderReceipt(intent.receipt, scan.newline),
      directive.childIndentation,
      scan.newline,
    );
    const receiptStart = directive.receipt?.start ?? directive.itemSpan.end;
    const receiptEnd = directive.receipt?.end ?? directive.itemSpan.end;
    patches.push({ start: receiptStart, end: receiptEnd, text: rendered });
  } else if (intent.kind === 'check-source') {
    if (!directive.sourceChecked) {
      patches.push({
        start: directive.checkboxSpan.start,
        end: directive.checkboxSpan.end,
        text: '[x]',
      });
    }
  } else if (intent.kind === 'follow-up' || intent.kind === 'resolve-follow-up') {
    const patch = eventPatch(
      source,
      directive,
      intent.eventKey,
      intent.checked,
      intent.text,
      intent.command,
      intent.commandDirectory,
      scan.newline,
    );
    if (patch) patches.push(patch);
  } else {
    if (!directive.sourceChecked) {
      patches.push({
        start: directive.checkboxSpan.start,
        end: directive.checkboxSpan.end,
        text: '[x]',
      });
    }
    const followUp = eventPatch(
      source,
      directive,
      intent.eventKey,
      false,
      intent.reviewText,
      intent.inspectCommand,
      intent.inspectCommandDirectory,
      scan.newline,
    );
    if (followUp) patches.push(followUp);
  }
  return {
    source: patches.length === 0 ? source : applyTextPatches(source, patches, scan.sourceHash),
    blocked: false,
  };
}

export async function applyNoteProjection(
  path: string,
  intent: NoteProjectionIntent,
  options: NoteScanOptions,
): Promise<ProjectionResult> {
  let blocked = false;
  let reason: string | undefined;
  const result = await optimisticAtomicUpdate(path, (source) => {
    const projected = projectSource(source, intent, options);
    blocked = projected.blocked;
    reason = projected.reason;
    return projected.source;
  });
  return {
    ...result,
    blocked,
    ...(reason ? { reason } : {}),
  };
}

function patchExistingCurrentWeekEvent(
  source: string,
  eventKey: string,
  taskId: string,
  checked: boolean,
): TextPatch | null | 'ambiguous' {
  const scan = scanNote(source, { providers: {} });
  const events = scan.eventRegions.filter(
    (event) =>
      event.eventKey === safeMarkerValue(eventKey) && event.taskId === safeMarkerValue(taskId),
  );
  if (events.length > 1) return 'ambiguous';
  const event = events[0];
  if (!event) return null;
  const line = source.slice(event.start, event.end);
  const checkbox = /\[[ xX]\]/.exec(line);
  if (!checkbox || checkbox.index === undefined) return 'ambiguous';
  return event.checked === checked
    ? { start: event.start, end: event.start, text: '' }
    : {
        start: event.start + checkbox.index,
        end: event.start + checkbox.index + 3,
        text: checked ? '[x]' : '[ ]',
      };
}

/**
 * Renders a source-note path as a Markdown destination rather than a wikilink.
 * Encoding every segment preserves literal filename characters (such as `]`,
 * `#`, and `|`) while preventing them from changing the generated task syntax.
 */
function markdownSourceBacklink(sourceRelativePath: string): string {
  const encodedPath = sourceRelativePath
    .replaceAll(sep, '/')
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `[source](<${encodedPath}>)`;
}

export async function projectCurrentWeekFollowUp(
  input: CurrentWeekFollowUp,
): Promise<ProjectionResult> {
  if (!isWeeklyNotePath(input.currentNotePath) || !isMarkdownNotePath(input.sourceNotePath)) {
    return {
      changed: false,
      blocked: true,
      reason: 'Current-week projection requires an exact weekly destination and Markdown source.',
      sourceHash: '',
    };
  }
  try {
    let blocked = false;
    let reason: string | undefined;
    const result = await optimisticAtomicUpdate(input.currentNotePath, (source) => {
      const existing = patchExistingCurrentWeekEvent(
        source,
        input.eventKey,
        input.taskId,
        input.checked,
      );
      if (existing === 'ambiguous') {
        blocked = true;
        reason = `Event marker ${input.eventKey} is malformed or ambiguous.`;
        return source;
      }
      if (existing) {
        return existing.start === existing.end
          ? source
          : applyTextPatches(source, [existing], hashNoteSource(source));
      }
      const day = findUniqueDayHeading(source, input.dayHeading);
      if (!day) {
        blocked = true;
        reason = `Current note does not contain one unique ${input.dayHeading} H2.`;
        return source;
      }
      const newline = source.includes('\r\n') ? '\r\n' : '\n';
      const sourceRelativePath = relative(dirname(input.currentNotePath), input.sourceNotePath);
      const backlink = markdownSourceBacklink(sourceRelativePath);
      const todo = renderFollowUpTodo(
        {
          checked: input.checked,
          eventKey: input.eventKey,
          taskId: input.taskId,
          text: input.text,
          ...(input.command ? { command: input.command } : {}),
          ...(input.commandDirectory ? { commandDirectory: input.commandDirectory } : {}),
          indentation: '',
          backlink,
        },
        newline,
      );
      return applyTextPatches(
        source,
        [{ start: day.contentStart, end: day.contentStart, text: todo }],
        hashNoteSource(source),
      );
    });
    return { ...result, blocked, ...(reason ? { reason } : {}) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {
        changed: false,
        blocked: true,
        reason: 'Current weekly note does not exist; MDSpool will not create it.',
        sourceHash: '',
      };
    }
    throw error;
  }
}
