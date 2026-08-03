import path from 'node:path';

export function isMarkdownNotePath(notePath: string): boolean {
  return path.extname(notePath).toLowerCase() === '.md';
}
