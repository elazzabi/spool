import { chmodSync, lstatSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ensurePiSessionDirectory,
  inspectPiSessionDirectory,
  piSessionDirectory,
} from '../../src/providers/pi-session.js';

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'mdspool-pi-session-'));
  const stateDirectory = path.join(root, 'state');
  const workspace = path.join(root, 'workspace');
  mkdirSync(stateDirectory, { mode: 0o700 });
  mkdirSync(workspace);
  return { root, stateDirectory, workspace };
}

describe('managed Pi session directory', () => {
  it('creates an owner-private directory beneath state and revalidates it', () => {
    const { stateDirectory, workspace } = fixture();

    const sessions = ensurePiSessionDirectory({
      stateDirectory,
      workspaceDirectories: [workspace],
    });

    expect(sessions).toBe(piSessionDirectory(stateDirectory));
    expect(lstatSync(path.join(stateDirectory, 'pi')).mode & 0o777).toBe(0o700);
    expect(lstatSync(sessions).mode & 0o777).toBe(0o700);
    expect(
      inspectPiSessionDirectory({ stateDirectory, workspaceDirectories: [workspace] }),
    ).toEqual({ sessionDirectory: sessions, error: null });
  });

  it.each([
    ['symlink', (sessions: string, target: string) => symlinkSync(target, sessions)],
    [
      'permissive directory',
      (sessions: string) => {
        mkdirSync(sessions, { mode: 0o700 });
        chmodSync(sessions, 0o750);
      },
    ],
    ['non-directory', (sessions: string) => writeFileSync(sessions, 'not a directory')],
  ])('rejects an existing %s instead of repairing it', (_kind, arrange) => {
    const { root, stateDirectory, workspace } = fixture();
    const piDirectory = path.join(stateDirectory, 'pi');
    const sessions = path.join(piDirectory, 'sessions');
    mkdirSync(piDirectory, { mode: 0o700 });
    arrange(sessions, root);

    expect(() =>
      ensurePiSessionDirectory({ stateDirectory, workspaceDirectories: [workspace] }),
    ).toThrow(/pi session directory/i);
  });

  it('rejects a symlinked Pi parent directory', () => {
    const { root, stateDirectory, workspace } = fixture();
    const target = path.join(root, 'elsewhere');
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, path.join(stateDirectory, 'pi'));

    expect(() =>
      ensurePiSessionDirectory({ stateDirectory, workspaceDirectories: [workspace] }),
    ).toThrow(/pi session parent/i);
  });

  it('rejects a managed session path that overlaps a leased repository workspace', () => {
    const { stateDirectory } = fixture();

    expect(() =>
      ensurePiSessionDirectory({ stateDirectory, workspaceDirectories: [stateDirectory] }),
    ).toThrow(/workspace/i);
  });
});
