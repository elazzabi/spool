import { randomUUID } from 'node:crypto';

import type { NoteScanOptions } from './directives.js';
import { scanNote } from './parse.js';
import { applyTextPatches, optimisticAtomicUpdate, type TextPatch } from './patch.js';
import { renderReceipt } from './render.js';

const validIdentity = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export { receiptAnchorFor } from './anchor.js';

export function planIdentityBootstrap(
  scan: ReturnType<typeof scanNote>,
  idFactory: () => string = randomUUID,
): TextPatch[] {
  if (scan.conflicts.length > 0) {
    throw new Error(`Cannot bootstrap a note with marker conflicts: ${scan.conflicts[0]?.message}`);
  }
  const seen = new Set(
    scan.directives.flatMap((directive) => (directive.taskId ? [directive.taskId] : [])),
  );
  return scan.directives
    .filter((directive) => directive.taskId === null)
    .map((directive): TextPatch => {
      let taskId = idFactory();
      while (seen.has(taskId)) {
        taskId = idFactory();
      }
      if (!validIdentity.test(taskId)) {
        throw new Error(`Identity factory returned an invalid task ID: ${taskId}`);
      }
      seen.add(taskId);
      const indentation = directive.childIndentation;
      const newline = scan.newline;
      const receipt = renderReceipt(
        {
          taskId,
          sessionId: null,
          status: 'Queued',
          updatedAt: new Date().toISOString(),
          context: 'Awaiting ledger claim after identity bootstrap.',
        },
        newline,
      )
        .split(newline)
        .map((line) => `${indentation}${line}`)
        .join(newline);
      const text = [receipt, ''].join(newline);
      return {
        start: directive.identityInsertOffset,
        end: directive.identityInsertOffset,
        text: `${directive.taskSpan.lineEnding ? '' : newline}${text}`,
      };
    });
}

export async function bootstrapNoteIdentities(
  path: string,
  options: NoteScanOptions,
  idFactory: () => string = randomUUID,
): Promise<{ changed: boolean; taskIds: string[] }> {
  let taskIds: string[] = [];
  const result = await optimisticAtomicUpdate(path, (source) => {
    const scan = scanNote(source, options);
    const patches = planIdentityBootstrap(scan, idFactory);
    if (patches.length === 0) {
      taskIds = scan.directives.flatMap((directive) =>
        directive.taskId ? [directive.taskId] : [],
      );
      return source;
    }
    const next = applyTextPatches(source, patches, scan.sourceHash);
    taskIds = scanNote(next, options).directives.flatMap((directive) =>
      directive.taskId ? [directive.taskId] : [],
    );
    return next;
  });
  return { changed: result.changed, taskIds };
}
