import { lstat } from 'node:fs/promises';
import path from 'node:path';

export type GitOperationKind =
  | 'rebase'
  | 'merge'
  | 'cherry-pick'
  | 'revert'
  | 'bisect'
  | 'sequencer'
  | 'index-lock'
  | 'head-lock'
  | 'config-lock'
  | 'packed-refs-lock';

export interface GitOperationMarker {
  kind: GitOperationKind;
  path: string;
}

export type MarkerExists = (candidate: string) => Promise<boolean>;

const markerNames: ReadonlyArray<{
  kind: GitOperationKind;
  root: 'git' | 'common';
  relativePath: string;
}> = [
  { kind: 'rebase', root: 'git', relativePath: 'rebase-merge' },
  { kind: 'rebase', root: 'git', relativePath: 'rebase-apply' },
  { kind: 'merge', root: 'git', relativePath: 'MERGE_HEAD' },
  { kind: 'cherry-pick', root: 'git', relativePath: 'CHERRY_PICK_HEAD' },
  { kind: 'revert', root: 'git', relativePath: 'REVERT_HEAD' },
  { kind: 'bisect', root: 'git', relativePath: 'BISECT_LOG' },
  { kind: 'bisect', root: 'git', relativePath: 'BISECT_START' },
  { kind: 'sequencer', root: 'git', relativePath: 'sequencer' },
  { kind: 'index-lock', root: 'git', relativePath: 'index.lock' },
  { kind: 'head-lock', root: 'git', relativePath: 'HEAD.lock' },
  { kind: 'config-lock', root: 'common', relativePath: 'config.lock' },
  { kind: 'packed-refs-lock', root: 'common', relativePath: 'packed-refs.lock' },
];

export async function inspectGitOperations(
  gitDirectory: string,
  commonDirectory: string,
  exists: MarkerExists = pathExists,
): Promise<GitOperationMarker[]> {
  const markers: GitOperationMarker[] = [];
  const visited = new Set<string>();
  for (const marker of markerNames) {
    const root = marker.root === 'git' ? gitDirectory : commonDirectory;
    const candidate = path.resolve(root, marker.relativePath);
    if (visited.has(candidate)) continue;
    visited.add(candidate);
    if (await exists(candidate)) markers.push({ kind: marker.kind, path: candidate });
  }
  return markers.sort((left, right) =>
    `${left.kind}:${left.path}`.localeCompare(`${right.kind}:${right.path}`),
  );
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
