import { createHash } from 'node:crypto';

import type { Heading, ListItem, Nodes, PhrasingContent, Root } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

import { receiptAnchorFor } from './anchor.js';
import { findGitHubTarget } from './context.js';
import {
  configuredDirectives,
  type EventRegion,
  type NoteConflict,
  type NoteScan,
  type NoteScanOptions,
  type ParsedDirective,
  type ReceiptRegion,
  type SourceSpan,
} from './directives.js';

interface IdentityMarker extends SourceSpan {
  taskId: string;
  anchor: string;
  receipt: ReceiptRegion;
}

interface SpoolBlock extends SourceSpan {
  taskId: string | null;
  anchor: string | null;
}

interface HeadingPosition {
  heading: string;
  offset: number;
}

const eventMarkers = [
  /<span[\t ]+data-spool-event="([^"\r\n]+)"[\t ]+data-spool-task="([^"\r\n]+)"[\t ]*><\/span>/g,
  /<span[\t ]+data-mdspool-event="([^"\r\n]+)"[\t ]+data-mdspool-task="([^"\r\n]+)"[\t ]*><\/span>/g,
];
const potentialEventMarker =
  /<span\b[^>\r\n]*data-(?:md)?spool-(?:event|task)[^>\r\n]*>(?:<\/span>)?/g;

export function hashNoteSource(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

function offsetOf(node: Nodes, side: 'start' | 'end'): number | null {
  return node.position?.[side].offset ?? null;
}

function lineStart(source: string, offset: number): number {
  const prior = source.lastIndexOf('\n', Math.max(0, offset - 1));
  return prior === -1 ? 0 : prior + 1;
}

function lineEnd(source: string, offset: number): number {
  const next = source.indexOf('\n', offset);
  return next === -1 ? source.length : next + 1;
}

function lineEndingAt(source: string, end: number): string {
  if (end >= 2 && source.slice(end - 2, end) === '\r\n') return '\r\n';
  if (end >= 1 && source[end - 1] === '\n') return '\n';
  return '';
}

function duplicateIdentityConflicts(markers: readonly IdentityMarker[]): NoteConflict[] {
  const conflicts: NoteConflict[] = [];
  const duplicateField = (field: 'taskId' | 'anchor', kind: NoteConflict['kind']): void => {
    const groups = new Map<string, IdentityMarker[]>();
    for (const marker of markers) {
      const members = groups.get(marker[field]) ?? [];
      members.push(marker);
      groups.set(marker[field], members);
    }
    for (const [value, members] of groups) {
      const first = members[0];
      if (members.length < 2 || !first) continue;
      conflicts.push({
        kind,
        message: `Duplicate ${field} marker: ${value}`,
        span: first,
        ...(field === 'taskId' ? { taskId: value } : {}),
      });
    }
  };
  duplicateField('taskId', 'duplicate-task-id');
  duplicateField('anchor', 'duplicate-anchor');
  return conflicts;
}

function parseEventRegions(
  source: string,
  excluded: readonly SourceSpan[],
): { regions: EventRegion[]; conflicts: NoteConflict[] } {
  const regions: EventRegion[] = [];
  const validMarkerSpans: SourceSpan[] = [];
  for (const pattern of eventMarkers) {
    for (const match of source.matchAll(pattern)) {
      if (match.index === undefined || !match[0] || !match[1] || !match[2]) continue;
      if (excluded.some((span) => isWithin(match.index, span))) continue;
      validMarkerSpans.push({ start: match.index, end: match.index + match[0].length });
      const start = lineStart(source, match.index);
      const end = lineEnd(source, match.index + match[0].length);
      const line = source.slice(start, end);
      regions.push({
        taskId: match[2],
        eventKey: match[1],
        start,
        end,
        lineEnding: lineEndingAt(source, end),
        indentation: /^[\t ]*/.exec(line)?.[0] ?? '',
        checked: /^[\t ]*(?:[-+*]|\d+[.)])[\t ]+\[[xX]\]/.test(line),
      });
    }
  }
  const conflicts: NoteConflict[] = [];
  for (const match of source.matchAll(potentialEventMarker)) {
    if (match.index === undefined || !match[0]) continue;
    if (excluded.some((span) => isWithin(match.index, span))) continue;
    if (
      validMarkerSpans.some(
        (span) => span.start === match.index && span.end === match.index + match[0].length,
      )
    ) {
      continue;
    }
    conflicts.push({
      kind: 'malformed-event-marker',
      message: 'A generated spool event marker is malformed.',
      span: { start: match.index, end: match.index + match[0].length },
    });
  }
  return { regions: regions.sort((left, right) => left.start - right.start), conflicts };
}

function isWithin(offset: number, span: SourceSpan): boolean {
  return offset >= span.start && offset < span.end;
}

function textFromPhrasing(node: PhrasingContent): string {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value;
  if ('children' in node) return node.children.map(textFromPhrasing).join('');
  if (node.type === 'image') return node.alt ?? '';
  return '';
}

function directListItemText(item: ListItem): string {
  const paragraph = item.children.find((child) => child.type === 'paragraph');
  if (!paragraph || paragraph.type !== 'paragraph') return '';
  return paragraph.children.map(textFromPhrasing).join('').trim();
}

function headingText(heading: Heading): string {
  return heading.children.map(textFromPhrasing).join('').trim();
}

function collectH2(root: Root): HeadingPosition[] {
  return root.children.flatMap((child) => {
    const offset = offsetOf(child, 'start');
    return child.type === 'heading' && child.depth === 2 && offset !== null
      ? [{ heading: headingText(child), offset }]
      : [];
  });
}

function collectCodeSpans(node: Nodes, result: SourceSpan[] = []): SourceSpan[] {
  if (node.type === 'code' || node.type === 'inlineCode') {
    const start = offsetOf(node, 'start');
    const end = offsetOf(node, 'end');
    if (start !== null && end !== null) result.push({ start, end });
    return result;
  }
  if ('children' in node) {
    for (const child of node.children) collectCodeSpans(child, result);
  }
  return result;
}

function collectSpoolBlocks(source: string, node: Nodes, result: SpoolBlock[] = []): SpoolBlock[] {
  if (node.type === 'code') {
    if (node.lang !== 'spool' && node.lang !== 'mdspool') return result;
    const start = offsetOf(node, 'start');
    const end = offsetOf(node, 'end');
    if (start === null || end === null) return result;
    const lines = node.value.split(/\r?\n/);
    const task = /^Task: ([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/.exec(lines[0] ?? '');
    const anchor = /^Anchor: ((?:md)?spool-[A-Za-z0-9-]+)$/.exec(lines[1] ?? '');
    const taskId = task?.[1] ?? null;
    const currentAnchor = taskId ? receiptAnchorFor(taskId) : null;
    const legacyAnchor = currentAnchor?.replace(/^spool-/, 'mdspool-') ?? null;
    result.push({
      taskId,
      anchor:
        taskId && (anchor?.[1] === currentAnchor || anchor?.[1] === legacyAnchor)
          ? anchor[1]
          : null,
      start: lineStart(source, start),
      end: lineEnd(source, end),
    });
    return result;
  }
  if ('children' in node) {
    for (const child of node.children) collectSpoolBlocks(source, child, result);
  }
  return result;
}

function dayAt(offset: number, headings: readonly HeadingPosition[]): string | null {
  let current: string | null = null;
  for (const heading of headings) {
    if (heading.offset >= offset) break;
    current = heading.heading;
  }
  return current;
}

function firstLineTask(
  source: string,
  item: ListItem,
): {
  indentation: string;
  taskText: string;
  taskStart: number;
  taskEnd: number;
  insertOffset: number;
  checkboxStart: number;
  checkboxEnd: number;
  lineEnding: string;
  continuationIndentation: string;
} | null {
  const start = offsetOf(item, 'start');
  if (start === null) return null;
  const physicalStart = lineStart(source, start);
  const end = lineEnd(source, start);
  const line = source.slice(physicalStart, end);
  const match = /^([\t ]*)(?:[-+*]|\d+[.)])([\t ]+)\[([ xX])\]([\t ]+)(.*?)(?:\r?\n)?$/.exec(line);
  if (
    !match ||
    match[1] === undefined ||
    match[2] === undefined ||
    match[4] === undefined ||
    match[5] === undefined
  )
    return null;
  const checkboxRelative = line.indexOf('[', match[1].length);
  const lineEnding = line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : '';
  return {
    indentation: match[1],
    taskText: match[5],
    taskStart: physicalStart,
    taskEnd: end - lineEnding.length,
    insertOffset: end,
    checkboxStart: physicalStart + checkboxRelative,
    checkboxEnd: physicalStart + checkboxRelative + 3,
    lineEnding,
    continuationIndentation: `${match[1]}${' '.repeat(
      Math.max(0, checkboxRelative - match[1].length),
    )}`,
  };
}

function directSpoolBlocks(item: ListItem, blocks: readonly SpoolBlock[]): SpoolBlock[] {
  const directCodeSpans = item.children.flatMap((child) => {
    const start = offsetOf(child, 'start');
    const end = offsetOf(child, 'end');
    return child.type === 'code' && start !== null && end !== null ? [{ start, end }] : [];
  });
  return blocks.filter((block) =>
    directCodeSpans.some((span) => block.start <= span.start && block.end >= span.end),
  );
}

function visitListItems(
  nodes: readonly Nodes[],
  ancestors: readonly string[],
  visitor: (item: ListItem, ancestors: readonly string[]) => void,
): void {
  for (const node of nodes) {
    if (node.type === 'list') {
      for (const item of node.children) {
        visitor(item, ancestors);
        const ownText = directListItemText(item).replace(/^\[[ xX]\][\t ]*/, '');
        visitListItems(item.children, [...ancestors, ownText], visitor);
      }
    } else if ('children' in node && node.type !== 'listItem') {
      visitListItems(node.children, ancestors, visitor);
    }
  }
}

function matchProviderDirective(
  taskText: string,
  configured: ReturnType<typeof configuredDirectives>,
): { provider: string; providerDirective: string; directiveText: string } | null {
  const leading = configured.find(
    (candidate) =>
      taskText.startsWith(candidate.directive) &&
      (taskText.length === candidate.directive.length ||
        /\s/.test(taskText[candidate.directive.length] ?? '')),
  );
  if (leading) {
    return {
      provider: leading.provider,
      providerDirective: leading.directive,
      directiveText: taskText.slice(leading.directive.length).trim(),
    };
  }

  const trimmed = taskText.trimEnd();
  const trailing = configured.find((candidate) => {
    if (!trimmed.endsWith(candidate.directive)) return false;
    const directiveStart = trimmed.length - candidate.directive.length;
    return directiveStart === 0 || /\s/.test(trimmed[directiveStart - 1] ?? '');
  });
  if (!trailing) return null;
  return {
    provider: trailing.provider,
    providerDirective: trailing.directive,
    directiveText: trimmed.slice(0, -trailing.directive.length).trim(),
  };
}

export function scanNote(source: string, options: NoteScanOptions): NoteScan {
  const parseSource = source.startsWith('\uFEFF') ? ` ${source.slice(1)}` : source;
  const root = unified().use(remarkParse).use(remarkGfm).parse(parseSource);
  const codeSpans = collectCodeSpans(root);
  const spoolBlocks = collectSpoolBlocks(source, root);
  const embeddedMarkers: IdentityMarker[] = spoolBlocks.flatMap((block) =>
    block.taskId && block.anchor
      ? [
          {
            taskId: block.taskId,
            anchor: block.anchor,
            start: block.start,
            end: block.end,
            receipt: { taskId: block.taskId, start: block.start, end: block.end },
          },
        ]
      : [],
  );
  const markers = embeddedMarkers;
  const receiptRegions = embeddedMarkers.map((marker) => marker.receipt);
  const parsedEvents = parseEventRegions(source, [...codeSpans, ...receiptRegions]);
  const eventRegions = parsedEvents.regions;
  const conflicts = [...duplicateIdentityConflicts(markers), ...parsedEvents.conflicts];
  const headings = collectH2(root);
  const directives: ParsedDirective[] = [];
  const trackedTasks: ParsedDirective[] = [];
  const configured = configuredDirectives(options.providers);

  visitListItems(root.children, [], (item, ancestors) => {
    if (item.checked !== false && item.checked !== true) return;
    const task = firstLineTask(source, item);
    const itemStart = offsetOf(item, 'start');
    const itemEnd = offsetOf(item, 'end');
    if (!task || itemStart === null || itemEnd === null) return;
    if (eventRegions.some((region) => isWithin(itemStart, region))) return;
    if (receiptRegions.some((region) => isWithin(itemStart, region))) return;

    const directive = matchProviderDirective(task.taskText, configured);
    if (!directive) return;
    const ownBlocks = directSpoolBlocks(item, spoolBlocks);
    const ownEmbeddedMarkers = embeddedMarkers.filter((marker) =>
      ownBlocks.some((block) => marker.start === block.start && marker.end === block.end),
    );
    const ownMarkers = ownEmbeddedMarkers;
    if (ownBlocks.some((block) => block.taskId === null || block.anchor === null)) {
      conflicts.push({
        kind: 'malformed-marker',
        message: 'A spool receipt is missing a valid Task or Anchor header.',
        span: { start: itemStart, end: itemEnd },
      });
    }
    if (item.checked === true && ownMarkers.length === 0) return;
    if (ownMarkers.length > 1) {
      conflicts.push({
        kind: 'ambiguous-task-marker',
        message: 'A provider task has more than one identity marker.',
        span: { start: itemStart, end: itemEnd },
      });
    }
    const marker = ownMarkers.length === 1 ? ownMarkers[0] : undefined;
    const markerConflict = marker
      ? conflicts.some(
          (conflict) =>
            conflict.taskId === marker.taskId ||
            (conflict.span.start >= itemStart && conflict.span.start < itemEnd),
        )
      : conflicts.some(
          (conflict) => conflict.span.start >= itemStart && conflict.span.start < itemEnd,
        );
    const githubTarget = findGitHubTarget(
      directive.directiveText,
      ancestors,
      options.repositoryAliases,
    );
    const listAncestors = ancestors.filter(Boolean);
    const dayHeading = dayAt(itemStart, headings);
    const childIndentation = task.continuationIndentation;
    const parsed: ParsedDirective = {
      taskId: marker?.taskId ?? null,
      receiptAnchor: marker?.anchor ?? null,
      provider: directive.provider,
      providerDirective: directive.providerDirective,
      directiveText: directive.directiveText,
      taskSpan: {
        start: task.taskStart,
        end: task.taskEnd,
        lineEnding: task.lineEnding,
        indentation: task.indentation,
      },
      itemSpan: { start: itemStart, end: itemEnd },
      checkboxSpan: { start: task.checkboxStart, end: task.checkboxEnd },
      dayHeading,
      listAncestors,
      context: {
        dayHeading,
        ancestors: listAncestors,
        ...(githubTarget?.repository ? { repository: githubTarget.repository } : {}),
        ...(githubTarget?.pr ? { pr: githubTarget.pr } : {}),
      },
      identityInsertOffset: task.insertOffset,
      childIndentation,
      receipt: marker?.receipt ?? null,
      eventRegions:
        marker === undefined
          ? []
          : eventRegions.filter((region) => region.taskId === marker.taskId),
      conflicted: markerConflict || ownMarkers.length > 1,
      sourceChecked: item.checked === true,
    };
    if (item.checked === false) {
      directives.push(parsed);
    } else {
      trackedTasks.push(parsed);
    }
  });

  return {
    source,
    sourceHash: hashNoteSource(source),
    newline: source.includes('\r\n') ? '\r\n' : '\n',
    hasBom: source.startsWith('\uFEFF'),
    directives,
    trackedTasks,
    conflicts,
    receiptRegions,
    eventRegions,
  };
}
