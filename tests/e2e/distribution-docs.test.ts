import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const readme = readFileSync(path.join(repositoryRoot, 'README.md'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')) as {
  packageManager?: string;
  publishConfig?: unknown;
  scripts: Record<string, string>;
};

describe('end-user distribution documentation', () => {
  it('leads from Node 24 and the one-line GitHub installer directly to setup', () => {
    const quickStart = section('Quick start');

    expect(quickStart).toContain('Node.js 24');
    expect(quickStart).toContain(
      'curl -fsSL https://raw.githubusercontent.com/elazzabi/spool/main/install.sh | sh',
    );
    expect(quickStart).toContain('spool --version');
    expect(quickStart).toContain('spool init');
    expect(quickStart).not.toMatch(/(?:^|\n)\s*(?:git clone|npm\s+(?:ci|install|link|publish)\b)/i);
  });

  it('documents selection, lifecycle, layout, recovery, and preserved user data', () => {
    expect(readme).toContain('sh -s -- --version 0.1.0');
    expect(readme).toContain('sh -s -- --prefix');
    expect(readme).toContain('spool update');
    expect(readme).toContain('spool update --version');
    expect(readme).toContain('spool uninstall');
    expect(readme).toContain('lib/spool/versions/');
    expect(readme).toContain('lib/spool/current');
    expect(readme).toContain('managed-install.json');
    expect(readme).toMatch(/rollback|restores? the previous/i);
    expect(readme).toMatch(/occupied|collision/i);
    expect(readme).toMatch(/npm is contributor tooling only/i);
    expect(readme).toContain('export PATH="$HOME/.local/bin:$PATH"');
    expect(readme).toMatch(/configuration.*state.*logs.*Markdown/is);
  });

  it('keeps npm only as contributor tooling and removes registry publication metadata', () => {
    const development = section('Development');
    expect(development).toContain('npm ci');
    expect(development).toContain('npm run build');
    expect(development).toContain('npm run check');
    expect(development).toMatch(/contributors/i);
    expect(manifest.packageManager).toMatch(/^npm@/);
    expect(manifest.publishConfig).toBeUndefined();
    expect(manifest.scripts.prepack).toBeUndefined();
    expect(manifest.scripts.prepublishOnly).toBeUndefined();
    expect(manifest.scripts['test:runtime']).toBeDefined();
    expect(readme).not.toMatch(/npm\s+(?:publish|link|install)\b|npmjs\.org/i);

    const workflows = readdirSync(path.join(repositoryRoot, '.github/workflows'))
      .filter((entry) => entry.endsWith('.yml') || entry.endsWith('.yaml'))
      .map((entry) => readFileSync(path.join(repositoryRoot, '.github/workflows', entry), 'utf8'))
      .join('\n');
    expect(workflows).not.toMatch(
      /npm\s+publish|registry-url|registry\.npmjs\.org|NPM_TOKEN|NODE_AUTH_TOKEN/i,
    );
  });
});

function section(heading: string) {
  const start = readme.indexOf(`## ${heading}`);
  if (start === -1) throw new Error(`README is missing ${heading}`);
  const end = readme.indexOf('\n## ', start + heading.length + 3);
  return readme.slice(start, end === -1 ? undefined : end);
}
