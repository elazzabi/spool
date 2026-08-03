import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import { compilePromptContext } from '../notes/context.js';
import type { ParsedDirective } from '../notes/directives.js';
import { bootstrapNoteIdentities } from '../notes/identity.js';
import { isMarkdownNotePath } from '../notes/markdown.js';
import { scanNote } from '../notes/parse.js';

export interface MarkdownNoteScannerOptions {
  vaults: readonly string[];
  providers: Readonly<Record<string, string>>;
  idFactory?: () => string;
  filesystem?: MarkdownNoteFilesystem;
}

/**
 * The small discovery seam keeps a single inaccessible path from making the whole vault
 * unavailable, and lets callers exercise that behavior without permission-dependent tests.
 */
export interface MarkdownNoteFilesystem {
  readdir(
    directory: string,
    options: { withFileTypes: true },
  ): Promise<readonly { name: string }[]>;
  lstat(entryPath: string): Promise<{
    isSymbolicLink(): boolean;
    isDirectory(): boolean;
    isFile(): boolean;
  }>;
  realpath(entryPath: string): Promise<string>;
}

export interface ScannedDirective {
  notePath: string;
  directive: ParsedDirective;
  context: string;
}

export interface OrphanedMarker {
  notePath: string;
  taskId: string;
  reason: string;
}

export interface ScannerDiagnostic {
  notePath: string;
  message: string;
}

export interface WorkspaceActionEvidence {
  notePath: string;
  taskId: string;
  eventKey: string;
  checked: boolean;
}

export interface MarkdownNoteScanResult {
  notePaths: string[];
  bootstrappedTaskIds: string[];
  claimable: ScannedDirective[];
  tracked: ScannedDirective[];
  workspaceActions?: WorkspaceActionEvidence[];
  orphanedMarkers: OrphanedMarker[];
  diagnostics: ScannerDiagnostic[];
}

/**
 * Scanner-local ownership is intentionally not reconstructed from disk. A marker written by this
 * process becomes claimable on a later scan; a marker that predates the process is only usable when
 * the durable ledger already owns it.
 */
export class MarkdownNoteScanner {
  readonly #vaults: readonly string[];
  readonly #providers: Readonly<Record<string, string>>;
  readonly #idFactory: (() => string) | undefined;
  readonly #filesystem: MarkdownNoteFilesystem;
  readonly #bootstrappedHere = new Set<string>();

  constructor(options: MarkdownNoteScannerOptions) {
    this.#vaults = [...options.vaults];
    this.#providers = { ...options.providers };
    this.#idFactory = options.idFactory;
    this.#filesystem = options.filesystem ?? defaultMarkdownNoteFilesystem;
  }

  async scan(ledgerOwnedMarkers: ReadonlySet<string> = new Set()): Promise<MarkdownNoteScanResult> {
    for (const marker of ledgerOwnedMarkers) this.#bootstrappedHere.delete(marker);
    const eligibleFromEarlierRead = new Set(this.#bootstrappedHere);
    const discovered = await scanMarkdownNoteFiles(this.#vaults, this.#filesystem);
    const notePaths = discovered.notePaths;
    const bootstrappedTaskIds: string[] = [];
    const diagnostics: ScannerDiagnostic[] = [...discovered.diagnostics];

    for (const notePath of notePaths) {
      const source = await readFile(notePath, 'utf8');
      const before = scanNote(source, { providers: this.#providers });
      if (before.conflicts.length > 0) {
        diagnostics.push(
          ...before.conflicts.map((conflict) => ({ notePath, message: conflict.message })),
        );
        continue;
      }
      const unmarked = before.directives.filter((directive) => directive.taskId === null);
      if (unmarked.length === 0) continue;
      const existing = new Set(
        [...before.directives, ...before.trackedTasks].flatMap((directive) =>
          directive.taskId ? [directive.taskId] : [],
        ),
      );
      const result = await bootstrapNoteIdentities(
        notePath,
        { providers: this.#providers },
        this.#idFactory,
      );
      if (!result.changed) continue;
      for (const taskId of result.taskIds) {
        if (existing.has(taskId)) continue;
        this.#bootstrappedHere.add(taskId);
        bootstrappedTaskIds.push(taskId);
      }
    }

    const candidates: ScannedDirective[] = [];
    const tracked: ScannedDirective[] = [];
    const scannedNotes: Array<{ notePath: string; note: ReturnType<typeof scanNote> }> = [];
    for (const notePath of notePaths) {
      const source = await readFile(notePath, 'utf8');
      const note = scanNote(source, { providers: this.#providers });
      scannedNotes.push({ notePath, note });
      if (note.conflicts.length > 0) {
        if (!diagnostics.some((diagnostic) => diagnostic.notePath === notePath)) {
          diagnostics.push(
            ...note.conflicts.map((conflict) => ({ notePath, message: conflict.message })),
          );
        }
        continue;
      }
      candidates.push(
        ...note.directives
          .filter((directive) => directive.taskId !== null && !directive.conflicted)
          .map((directive) => ({
            notePath,
            directive,
            context: compilePromptContext(directive),
          })),
      );
      tracked.push(
        ...note.trackedTasks
          .filter((directive) => directive.taskId !== null && !directive.conflicted)
          .map((directive) => ({
            notePath,
            directive,
            context: compilePromptContext(directive),
          })),
      );
    }

    const markerCounts = new Map<string, number>();
    for (const item of [...candidates, ...tracked]) {
      const taskId = item.directive.taskId;
      if (taskId) markerCounts.set(taskId, (markerCounts.get(taskId) ?? 0) + 1);
    }
    const claimable = candidates.filter(({ directive }) => {
      const taskId = directive.taskId;
      return (
        taskId !== null &&
        markerCounts.get(taskId) === 1 &&
        (eligibleFromEarlierRead.has(taskId) || ledgerOwnedMarkers.has(taskId))
      );
    });
    const orphanedMarkers = candidates.flatMap(({ notePath, directive }) => {
      const taskId = directive.taskId;
      if (taskId === null || ledgerOwnedMarkers.has(taskId) || this.#bootstrappedHere.has(taskId)) {
        return [];
      }
      return [
        {
          notePath,
          taskId,
          reason:
            markerCounts.get(taskId) === 1
              ? 'Marker has no durable ledger owner and was not bootstrapped by this process'
              : 'Marker is duplicated and therefore ambiguous',
        },
      ];
    });
    const taskOwners = new Map<string, string[]>();
    const workspaceEventOccurrences = new Map<
      string,
      Array<{
        notePath: string;
        taskId: string;
        eventKey: string;
        checked: boolean;
        conflicted: boolean;
      }>
    >();
    for (const { notePath, note } of scannedNotes) {
      for (const directive of [...note.directives, ...note.trackedTasks]) {
        if (directive.taskId === null) continue;
        const owners = taskOwners.get(directive.taskId) ?? [];
        owners.push(notePath);
        taskOwners.set(directive.taskId, owners);
      }
      for (const event of note.eventRegions) {
        if (!event.eventKey.startsWith('workspace-')) continue;
        const key = workspaceEventIdentity(event.taskId, event.eventKey);
        const occurrences = workspaceEventOccurrences.get(key) ?? [];
        occurrences.push({
          notePath,
          taskId: event.taskId,
          eventKey: event.eventKey,
          checked: event.checked,
          conflicted: note.conflicts.length > 0,
        });
        workspaceEventOccurrences.set(key, occurrences);
      }
    }
    const workspaceActions: WorkspaceActionEvidence[] = [];
    for (const occurrences of workspaceEventOccurrences.values()) {
      const first = occurrences[0];
      if (!first) continue;
      if (occurrences.length !== 1) {
        diagnostics.push({
          notePath: first.notePath,
          message: `Workspace event marker is ambiguous for task ${boundedDiagnosticValue(first.taskId)} and event ${boundedDiagnosticValue(first.eventKey)}.`,
        });
        continue;
      }
      const owners = taskOwners.get(first.taskId) ?? [];
      if (
        first.conflicted ||
        owners.length !== 1 ||
        owners[0] !== first.notePath ||
        !first.checked
      ) {
        continue;
      }
      workspaceActions.push({
        notePath: first.notePath,
        taskId: first.taskId,
        eventKey: first.eventKey,
        checked: first.checked,
      });
    }
    workspaceActions.sort(
      (left, right) =>
        left.notePath.localeCompare(right.notePath) || left.eventKey.localeCompare(right.eventKey),
    );

    return {
      notePaths,
      bootstrappedTaskIds,
      claimable,
      tracked,
      workspaceActions,
      orphanedMarkers,
      diagnostics,
    };
  }
}

function workspaceEventIdentity(taskId: string, eventKey: string): string {
  return JSON.stringify([taskId, eventKey]);
}

function boundedDiagnosticValue(value: string): string {
  const normalized = [...value]
    .map((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point <= 0x1f || (point >= 0x7f && point <= 0x9f) ? ' ' : character;
    })
    .join('')
    .replace(/\s+/gu, ' ')
    .trim();
  return normalized.length <= 80 ? normalized : `${normalized.slice(0, 79)}…`;
}

export async function listMarkdownNoteFiles(vaults: readonly string[]): Promise<string[]> {
  return (await scanMarkdownNoteFiles(vaults)).notePaths;
}

export async function scanMarkdownNoteFiles(
  vaults: readonly string[],
  filesystem: MarkdownNoteFilesystem = defaultMarkdownNoteFilesystem,
): Promise<{ notePaths: string[]; diagnostics: ScannerDiagnostic[] }> {
  const notePathsByCanonicalPath = new Map<string, string>();
  const diagnostics: ScannerDiagnostic[] = [];

  // Shallow roots run first so an overlapping, deeper root is the later owner of a note.
  const roots = [...vaults].sort(
    (left, right) =>
      path.resolve(left).split(path.sep).length - path.resolve(right).split(path.sep).length,
  );
  for (const root of roots) {
    await collectMarkdownNoteFiles(root, notePathsByCanonicalPath, diagnostics, filesystem);
  }

  return {
    notePaths: [...notePathsByCanonicalPath.values()].sort((left, right) =>
      left.localeCompare(right),
    ),
    diagnostics,
  };
}

async function collectMarkdownNoteFiles(
  directory: string,
  notePathsByCanonicalPath: Map<string, string>,
  diagnostics: ScannerDiagnostic[],
  filesystem: MarkdownNoteFilesystem,
): Promise<void> {
  let entries: readonly { name: string }[];
  try {
    entries = await filesystem.readdir(directory, { withFileTypes: true });
  } catch (error) {
    diagnostics.push({
      notePath: directory,
      message: `Unable to read directory: ${errorMessage(error)}`,
    });
    return;
  }

  entries = [...entries].sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    let identity: Awaited<ReturnType<MarkdownNoteFilesystem['lstat']>>;
    try {
      identity = await filesystem.lstat(entryPath);
    } catch (error) {
      diagnostics.push({
        notePath: entryPath,
        message: `Unable to inspect path: ${errorMessage(error)}`,
      });
      continue;
    }
    if (identity.isSymbolicLink()) continue;
    if (identity.isDirectory()) {
      await collectMarkdownNoteFiles(entryPath, notePathsByCanonicalPath, diagnostics, filesystem);
      continue;
    }
    if (!identity.isFile() || !isMarkdownNotePath(entry.name)) continue;
    let canonicalPath: string;
    try {
      canonicalPath = await filesystem.realpath(entryPath);
    } catch (error) {
      diagnostics.push({
        notePath: entryPath,
        message: `Unable to resolve path: ${errorMessage(error)}`,
      });
      continue;
    }
    notePathsByCanonicalPath.set(canonicalPath, entryPath);
  }
}

const defaultMarkdownNoteFilesystem: MarkdownNoteFilesystem = { readdir, lstat, realpath };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
