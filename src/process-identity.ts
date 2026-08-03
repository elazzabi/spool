import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export function readProcessStartIdentity(pid: number): string | null {
  try {
    process.kill(pid, 0);
  } catch {
    return null;
  }

  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
      const closingParenthesis = stat.lastIndexOf(')');
      const fieldsAfterName = stat
        .slice(closingParenthesis + 1)
        .trim()
        .split(/\s+/);
      const startTicks = fieldsAfterName[19];
      if (startTicks) return `linux:${startTicks}`;
    } catch {
      return null;
    }
  }

  if (process.platform === 'darwin' || process.platform === 'freebsd') {
    try {
      const startedAt = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return startedAt ? `${process.platform}:${startedAt}` : null;
    } catch {
      return null;
    }
  }

  // The PID still provides a liveness guard on platforms without a process birth-time source.
  return `pid:${String(pid)}`;
}

export function currentProcessStartIdentity(): string {
  return readProcessStartIdentity(process.pid) ?? `self:${String(process.pid)}`;
}
