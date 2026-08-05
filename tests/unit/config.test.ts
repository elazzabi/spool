import { mkdtempSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../../src/config/load.js';
import { defaultConfigPath, resolveConfigPath } from '../../src/config/paths.js';
import { normalizeGitHubRepository } from '../../src/config/schema.js';

interface Fixture {
  root: string;
  configPath: string;
  vault: string;
  state: string;
  cloneA: string;
  cloneB: string;
}

function createFixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), 'spool-config-'));
  const vault = path.join(root, 'vault');
  const state = path.join(root, 'state');
  const cloneA = path.join(root, 'clone-a');
  const cloneB = path.join(root, 'clone-b');
  for (const directory of [vault, state, cloneA, cloneB]) {
    mkdirSync(directory);
  }

  return {
    root,
    configPath: path.join(root, 'config.yaml'),
    vault,
    state,
    cloneA,
    cloneB,
  };
}

function validYaml(fixture: Fixture): string {
  return `
vaults:
  - ${JSON.stringify(fixture.vault)}
stateDirectory: ${JSON.stringify(fixture.state)}
timeZone: Europe/Istanbul
pollIntervalSeconds: 30
dayAliases:
  monday: [Monday, Mon]
providers:
  claude:
    enabled: true
    executable: claude
    directive: "@claude"
    defaultArgs: ["--permission-mode", "plan", "--model", "value; touch /tmp/nope"]
  cursor:
    enabled: false
    executable: cursor-agent
    defaultArgs: []
repositories:
  - repository: https://github.com/Example/Widget.git
    clones:
      - ${JSON.stringify(fixture.cloneA)}
      - ${JSON.stringify(fixture.cloneB)}
`;
}

describe('configuration', () => {
  it('uses the spool config directory by default', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'spool-config-path-'));
    const environment = { platform: 'darwin' as const, homeDirectory: root, env: {} };
    const primary = path.join(root, 'Library', 'Application Support', 'spool', 'config.yaml');

    expect(defaultConfigPath(environment)).toBe(primary);
    expect(resolveConfigPath(undefined, environment)).toBe(primary);
  });

  it('loads canonical paths and normalized repository identities without reordering values', () => {
    const fixture = createFixture();
    writeFileSync(fixture.configPath, validYaml(fixture));

    const config = loadConfig(fixture.configPath, { pathValue: '' });

    expect(config.vaults).toEqual([realpathSync(fixture.vault)]);
    expect(config.stateDirectory).toBe(realpathSync(fixture.state));
    expect(config.providers.map((provider) => provider.name)).toEqual(['claude', 'cursor']);
    expect(config.providers[0]?.defaultArgs).toEqual([
      '--permission-mode',
      'plan',
      '--model',
      'value; touch /tmp/nope',
    ]);
    expect(config.repositories).toEqual([
      {
        repository: 'example/widget',
        clones: [realpathSync(fixture.cloneA), realpathSync(fixture.cloneB)],
      },
    ]);
  });

  it('normalizes a mixed-case repository alias while preserving canonical identity', () => {
    const fixture = createFixture();
    const yaml = validYaml(fixture).replace(
      '  - repository: https://github.com/Example/Widget.git',
      '  - repository: https://github.com/Example/Widget.git\n    alias: Woo-Payments',
    );
    writeFileSync(fixture.configPath, yaml);

    expect(loadConfig(fixture.configPath, { pathValue: '' }).repositories).toEqual([
      {
        repository: 'example/widget',
        alias: 'woo-payments',
        clones: [realpathSync(fixture.cloneA), realpathSync(fixture.cloneB)],
      },
    ]);
  });

  it.each([
    ['empty', ''],
    ['whitespace-bearing', 'woo payments'],
    ['slash-containing', 'woo/payments'],
    ['URL-shaped', 'https://github.com/example/widget'],
    ['leading hyphen', '-woopayments'],
    ['trailing hyphen', 'woopayments-'],
    ['punctuation-bearing', 'woo_payments'],
  ])('rejects an %s repository alias', (_name, alias) => {
    const fixture = createFixture();
    const yaml = validYaml(fixture).replace(
      '  - repository: https://github.com/Example/Widget.git',
      `  - repository: https://github.com/Example/Widget.git\n    alias: ${JSON.stringify(alias)}`,
    );
    writeFileSync(fixture.configPath, yaml);

    expect(() => loadConfig(fixture.configPath, { pathValue: '' })).toThrow(/alias/i);
  });

  it('rejects case-insensitive repository alias collisions', () => {
    const fixture = createFixture();
    const yaml = `${validYaml(fixture).replace(
      '  - repository: https://github.com/Example/Widget.git',
      '  - repository: https://github.com/Example/Widget.git\n    alias: WooPayments',
    )}
  - repository: example/other
    alias: woopayments
    clones:
      - ${JSON.stringify(path.join(fixture.root, 'clone-other'))}
`;
    mkdirSync(path.join(fixture.root, 'clone-other'));
    writeFileSync(fixture.configPath, yaml);

    expect(() => loadConfig(fixture.configPath, { pathValue: '' })).toThrow(
      /duplicate repository alias/i,
    );
  });

  it.each([
    ['poll interval', 'pollIntervalSeconds: 30', 'pollIntervalSeconds: 46'],
    ['time zone', 'timeZone: Europe/Istanbul', 'timeZone: Mars/Olympus_Mons'],
    ['missing vault', /vaults:\n {2}- .*/, 'vaults:\n  - "/definitely/missing/spool-vault"'],
  ])('rejects an invalid %s without creating state files', (_name, find, replacement) => {
    const fixture = createFixture();
    const yaml = validYaml(fixture).replace(find, replacement);
    writeFileSync(fixture.configPath, yaml);
    const before = readdirSync(fixture.state);

    expect(() => loadConfig(fixture.configPath)).toThrow(ConfigError);
    expect(readdirSync(fixture.state)).toEqual(before);
  });

  it('rejects duplicate provider directives', () => {
    const fixture = createFixture();
    const yaml = validYaml(fixture).replace(
      'executable: cursor-agent\n    defaultArgs: []',
      'executable: cursor-agent\n    directive: "@CLAUDE"\n    defaultArgs: []',
    );
    writeFileSync(fixture.configPath, yaml);

    expect(() => loadConfig(fixture.configPath)).toThrow(/duplicate provider directive/i);
  });

  it('rejects duplicate and nested clone ownership', () => {
    const fixture = createFixture();
    const nested = path.join(fixture.cloneA, 'nested');
    mkdirSync(nested);
    const yaml = `${validYaml(fixture)}
  - repository: example/other
    clones:
      - ${JSON.stringify(nested)}
`;
    writeFileSync(fixture.configPath, yaml);

    expect(() => loadConfig(fixture.configPath)).toThrow(/overlap/i);
  });

  it('rejects a machine state directory inside a watched vault', () => {
    const fixture = createFixture();
    const nestedState = path.join(fixture.vault, '.spool-state');
    mkdirSync(nestedState);
    const yaml = validYaml(fixture).replace(
      `stateDirectory: ${JSON.stringify(fixture.state)}`,
      `stateDirectory: ${JSON.stringify(nestedState)}`,
    );
    writeFileSync(fixture.configPath, yaml);

    expect(() => loadConfig(fixture.configPath)).toThrow(/state directory.*vault/i);
  });

  it('normalizes common GitHub repository and PR identities', () => {
    expect(normalizeGitHubRepository('Owner/Repo')).toBe('owner/repo');
    expect(normalizeGitHubRepository('git@github.com:Owner/Repo.git')).toBe('owner/repo');
    expect(normalizeGitHubRepository('https://github.com/Owner/Repo/pull/123')).toBe('owner/repo');
    expect(() => normalizeGitHubRepository('https://gitlab.com/Owner/Repo')).toThrow(
      /GitHub repository/i,
    );
  });
});
