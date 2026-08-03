export function receiptAnchorFor(taskId: string): string {
  const compact = taskId
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
  return `spool-${compact || 'task'}`;
}
