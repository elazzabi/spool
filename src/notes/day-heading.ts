import type { Heading, Nodes } from 'mdast';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

export interface DayHeadingMatch {
  heading: string;
  start: number;
  contentStart: number;
  end: number;
}

function nodeText(node: Nodes): string {
  if ('value' in node && typeof node.value === 'string') return node.value;
  if ('children' in node) return node.children.map(nodeText).join('');
  return '';
}

export function findUniqueDayHeading(source: string, heading: string): DayHeadingMatch | null {
  const root = unified().use(remarkParse).parse(source);
  const headings = root.children.filter(
    (node): node is Heading => node.type === 'heading' && node.depth === 2,
  );
  const normalized = heading.trim().toLocaleLowerCase('en-US');
  const matches = headings.filter(
    (node) => nodeText(node).trim().toLocaleLowerCase('en-US') === normalized,
  );
  const match = matches[0];
  const start = match?.position?.start.offset;
  const headingEnd = match?.position?.end.offset;
  if (
    matches.length !== 1 ||
    match === undefined ||
    start === undefined ||
    headingEnd === undefined
  ) {
    return null;
  }
  let contentStart = headingEnd;
  if (source.startsWith('\r\n', contentStart)) {
    contentStart += 2;
  } else if (source.startsWith('\n', contentStart)) {
    contentStart += 1;
  }
  const next = headings.find((candidate) => (candidate.position?.start.offset ?? -1) > start);
  return {
    heading: nodeText(match).trim(),
    start,
    contentStart,
    end: next?.position?.start.offset ?? source.length,
  };
}
