import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import YAML from 'yaml';
import { describe, expect, it } from 'vitest';

import {
  addBuiltinProvider,
  addRepositoryMapping,
  addWatchedFolder,
  assessConfigTarget,
  assignRepositoryAlias,
  createConfigDocument,
  mutateConfigDocument,
  readRawConfigDocument,
  removeRepositoryMapping,
  removeWatchedFolder,
} from '../../src/config/document.js';
import { loadConfig } from '../../src/config/load.js';
import type { RawConfig } from '../../src/config/schema.js';
import { currentProcessStartIdentity } from '../../src/process-identity.js';

describe('configuration documents', () => {
  it('assesses a missing configuration parent without creating it', () => {
    const fixture = createFixture();
    const configPath = path.join(fixture.root, 'missing', 'nested', 'config.yaml');

    const assessment = assessConfigTarget(configPath);

    expect(assessment.target).toBe(configPath);
    expect(assessment.parent).toBe(path.dirname(configPath));
    expect(existsSync(assessment.parent)).toBe(false);
  });

  it('atomically publishes a validated owner-only config without replacing an existing target', () => {
    const fixture = createFixture();

    const written = createConfigDocument(fixture.configPath, fixture.raw);

    expect(written).toBe(fixture.configPath);
    expect(lstatSync(written).mode & 0o777).toBe(0o600);
    expect(loadConfig(written).vaults).toEqual([fixture.vault]);
    const original = readFileSync(written, 'utf8');
    expect(() => createConfigDocument(written, fixture.raw)).toThrow(/already exists/i);
    expect(readFileSync(written, 'utf8')).toBe(original);
  });

  it.each(['permission update', 'parent sync'] as const)(
    'removes its published link when the %s fails',
    (failure) => {
      const fixture = createFixture();

      expect(() =>
        createConfigDocument(fixture.configPath, fixture.raw, {
          ...(failure === 'permission update'
            ? {
                chmod: () => {
                  throw new Error('injected chmod failure');
                },
              }
            : {
                syncParent: () => {
                  throw new Error('injected sync failure');
                },
              }),
        }),
      ).toThrow(/injected/);

      expect(existsSync(fixture.configPath)).toBe(false);
    },
  );

  it('does not remove a replacement that races publication cleanup', () => {
    const fixture = createFixture();

    expect(() =>
      createConfigDocument(fixture.configPath, fixture.raw, {
        chmod: (target) => {
          unlinkSync(target);
          writeFileSync(target, 'replacement\n', { mode: 0o600 });
          throw new Error('injected replacement race');
        },
      }),
    ).toThrow('injected replacement race');

    expect(readFileSync(fixture.configPath, 'utf8')).toBe('replacement\n');
  });

  it('adds and removes canonical watched folders while retaining at least one', () => {
    const fixture = createFixture();
    createConfigDocument(fixture.configPath, fixture.raw);

    expect(addWatchedFolder(fixture.configPath, fixture.secondVault)).toEqual([
      fixture.vault,
      fixture.secondVault,
    ]);
    expect(loadConfig(fixture.configPath).vaults).toEqual([fixture.vault, fixture.secondVault]);
    expect(() => addWatchedFolder(fixture.configPath, fixture.secondVault)).toThrow(
      /already watched/i,
    );

    expect(removeWatchedFolder(fixture.configPath, fixture.vault)).toEqual([fixture.secondVault]);
    expect(() => removeWatchedFolder(fixture.configPath, fixture.secondVault)).toThrow(
      /final watched folder/i,
    );
    expect(loadConfig(fixture.configPath).vaults).toEqual([fixture.secondVault]);
    expect(loadConfig(`${fixture.configPath}.backup`).vaults).toEqual([
      fixture.vault,
      fixture.secondVault,
    ]);
  });

  it('adds a normalized repository pool while preserving unrelated settings and a backup', () => {
    const fixture = createFixture();
    const secondClone = path.join(fixture.root, 'second-clone');
    mkdirSync(secondClone);
    createConfigDocument(fixture.configPath, fixture.raw);
    const original = readFileSync(fixture.configPath, 'utf8');

    const repositories = addRepositoryMapping(fixture.configPath, {
      repository: 'example/second',
      clones: [secondClone],
    });

    expect(repositories).toEqual([
      { repository: 'example/widget', clones: [fixture.clone] },
      { repository: 'example/second', clones: [secondClone] },
    ]);
    const raw = readRawConfigDocument(fixture.configPath).raw;
    expect(raw.repositories).toEqual([
      { repository: 'example/widget', clones: [fixture.clone] },
      { repository: 'example/second', clones: [secondClone] },
    ]);
    expect(raw.pollIntervalSeconds).toBe(30);
    expect(raw.providers).toEqual(fixture.raw.providers);
    expect(readFileSync(`${fixture.configPath}.backup`, 'utf8')).toBe(original);
    expect(lstatSync(fixture.configPath).mode & 0o777).toBe(0o600);
    expect(lstatSync(`${fixture.configPath}.backup`).mode & 0o777).toBe(0o600);
  });

  it('assigns a normalized repository alias while preserving unrelated settings and a backup', () => {
    const fixture = createFixture();
    createConfigDocument(fixture.configPath, fixture.raw);
    const original = readFileSync(fixture.configPath, 'utf8');

    const repository = assignRepositoryAlias(
      fixture.configPath,
      'https://github.com/Example/Widget.git',
      'Woo-Payments',
    );

    expect(repository).toEqual({
      repository: 'example/widget',
      alias: 'woo-payments',
      clones: [fixture.clone],
    });
    const raw = readRawConfigDocument(fixture.configPath).raw;
    expect(raw.repositories[0]).toEqual({
      repository: 'example/widget',
      alias: 'woo-payments',
      clones: [fixture.clone],
    });
    expect(raw.pollIntervalSeconds).toBe(30);
    expect(raw.providers).toEqual(fixture.raw.providers);
    expect(readFileSync(`${fixture.configPath}.backup`, 'utf8')).toBe(original);
  });

  it('rejects an alias owned by another pool without changing source or backup state', () => {
    const fixture = createFixture();
    const secondClone = path.join(fixture.root, 'second-clone');
    mkdirSync(secondClone);
    fixture.raw.repositories[0]!.alias = 'shared-alias';
    fixture.raw.repositories.push({ repository: 'example/second', clones: [secondClone] });
    createConfigDocument(fixture.configPath, fixture.raw);
    const original = readFileSync(fixture.configPath, 'utf8');

    expect(() =>
      assignRepositoryAlias(fixture.configPath, 'example/second', 'SHARED-ALIAS'),
    ).toThrow(/alias.*already used/i);

    expect(readFileSync(fixture.configPath, 'utf8')).toBe(original);
    expect(existsSync(`${fixture.configPath}.backup`)).toBe(false);
  });

  it('rejects an unknown repository alias assignment without changing the document', () => {
    const fixture = createFixture();
    createConfigDocument(fixture.configPath, fixture.raw);
    const original = readFileSync(fixture.configPath, 'utf8');

    expect(() => assignRepositoryAlias(fixture.configPath, 'example/missing', 'missing')).toThrow(
      /repository is not configured/i,
    );

    expect(readFileSync(fixture.configPath, 'utf8')).toBe(original);
    expect(existsSync(`${fixture.configPath}.backup`)).toBe(false);
  });

  it('does not rewrite source or backup for an identical normalized alias assignment', () => {
    const fixture = createFixture();
    fixture.raw.repositories[0]!.alias = 'Woo-Payments';
    createConfigDocument(fixture.configPath, fixture.raw);
    writeFileSync(`${fixture.configPath}.backup`, 'existing backup\n', { mode: 0o600 });
    const original = readFileSync(fixture.configPath, 'utf8');

    const repository = assignRepositoryAlias(fixture.configPath, 'EXAMPLE/WIDGET', 'woo-payments');

    expect(repository.alias).toBe('woo-payments');
    expect(readFileSync(fixture.configPath, 'utf8')).toBe(original);
    expect(readFileSync(`${fixture.configPath}.backup`, 'utf8')).toBe('existing backup\n');
  });

  it('replaces an existing repository alias with an available alias', () => {
    const fixture = createFixture();
    fixture.raw.repositories[0]!.alias = 'old-alias';
    createConfigDocument(fixture.configPath, fixture.raw);

    const repository = assignRepositoryAlias(fixture.configPath, 'example/widget', 'New-Alias');

    expect(repository.alias).toBe('new-alias');
    expect(readRawConfigDocument(fixture.configPath).raw.repositories[0]!.alias).toBe('new-alias');
  });

  it('replaces only the reviewed disabled built-in provider and keeps an owner-only backup', () => {
    const fixture = createFixture();
    fixture.raw.providers.custom = {
      enabled: true,
      executable: 'custom-agent',
      directive: '@custom',
      defaultArgs: ['--existing'],
    };
    createConfigDocument(fixture.configPath, fixture.raw);
    const before = readRawConfigDocument(fixture.configPath).raw;
    const original = readFileSync(fixture.configPath, 'utf8');
    const reviewed = cursorProvider();

    const updated = addBuiltinProvider(
      fixture.configPath,
      'claude',
      { ...reviewed, executable: 'claude', directive: '@claude' },
      before.providers.claude,
    );

    expect(updated.raw).toEqual({
      ...before,
      providers: {
        ...before.providers,
        claude: { ...reviewed, executable: 'claude', directive: '@claude' },
      },
    });
    expect(readFileSync(`${fixture.configPath}.backup`, 'utf8')).toBe(original);
    expect(lstatSync(fixture.configPath).mode & 0o777).toBe(0o600);
    expect(lstatSync(`${fixture.configPath}.backup`).mode & 0o777).toBe(0o600);
  });

  it('inserts a reviewed missing built-in provider without rebuilding the provider map', () => {
    const fixture = createFixture();
    fixture.raw.providers.custom = {
      enabled: true,
      executable: 'custom-agent',
      directive: '@custom',
      defaultArgs: ['--existing'],
    };
    delete fixture.raw.providers.claude;
    createConfigDocument(fixture.configPath, fixture.raw);
    const before = readRawConfigDocument(fixture.configPath).raw;
    const reviewed = cursorProvider();

    const updated = addBuiltinProvider(fixture.configPath, 'cursor', reviewed, undefined);

    expect(updated.raw).toEqual({
      ...before,
      providers: { ...before.providers, cursor: reviewed },
    });
  });

  it('refuses an already-enabled provider without writing a backup', () => {
    const fixture = createFixture();
    fixture.raw.providers.claude!.enabled = true;
    createConfigDocument(fixture.configPath, fixture.raw);
    const before = readRawConfigDocument(fixture.configPath);

    expect(() =>
      addBuiltinProvider(
        fixture.configPath,
        'claude',
        { ...cursorProvider(), executable: 'claude', directive: '@claude' },
        before.raw.providers.claude,
      ),
    ).toThrow(/already enabled/i);

    expect(readFileSync(fixture.configPath, 'utf8')).toBe(before.source);
    expect(existsSync(`${fixture.configPath}.backup`)).toBe(false);
  });

  it('rejects a case-insensitive directive collision without changing the document', () => {
    const fixture = createFixture();
    fixture.raw.providers.custom = {
      enabled: true,
      executable: 'custom-agent',
      directive: '@CURSOR',
      defaultArgs: [],
    };
    createConfigDocument(fixture.configPath, fixture.raw);
    const before = readRawConfigDocument(fixture.configPath);

    expect(() =>
      addBuiltinProvider(fixture.configPath, 'cursor', cursorProvider(), undefined),
    ).toThrow(/directive.*already used/i);

    expect(readFileSync(fixture.configPath, 'utf8')).toBe(before.source);
    expect(existsSync(`${fixture.configPath}.backup`)).toBe(false);
  });

  it.each([
    {
      name: 'a missing target appears',
      initial: undefined,
      fresh: { ...cursorProvider(), enabled: false },
    },
    {
      name: 'a disabled target disappears',
      initial: { ...cursorProvider(), enabled: false },
      fresh: undefined,
    },
    {
      name: 'a disabled target changes',
      initial: { ...cursorProvider(), enabled: false },
      fresh: { ...cursorProvider(), enabled: false, defaultArgs: ['--mode', 'ask'] },
    },
  ])('refuses target drift when $name', ({ initial, fresh }) => {
    const fixture = createFixture();
    fixture.raw.providers.custom = {
      enabled: true,
      executable: 'custom-agent',
      directive: '@custom',
      defaultArgs: [],
    };
    delete fixture.raw.providers.claude;
    if (initial) fixture.raw.providers.cursor = initial;
    createConfigDocument(fixture.configPath, fixture.raw);
    const expected = readRawConfigDocument(fixture.configPath).raw.providers.cursor;
    if (fresh) fixture.raw.providers.cursor = fresh;
    else delete fixture.raw.providers.cursor;
    writeFileSync(fixture.configPath, YAML.stringify(fixture.raw), { mode: 0o600 });
    const concurrentSource = readFileSync(fixture.configPath, 'utf8');

    expect(() =>
      addBuiltinProvider(fixture.configPath, 'cursor', cursorProvider(), expected),
    ).toThrow(/changed since it was reviewed/i);

    expect(readFileSync(fixture.configPath, 'utf8')).toBe(concurrentSource);
    expect(existsSync(`${fixture.configPath}.backup`)).toBe(false);
  });

  it('refuses a provider that becomes enabled after review', () => {
    const fixture = createFixture();
    fixture.raw.providers.cursor = { ...cursorProvider(), enabled: false };
    createConfigDocument(fixture.configPath, fixture.raw);
    const expected = readRawConfigDocument(fixture.configPath).raw.providers.cursor;
    fixture.raw.providers.cursor.enabled = true;
    writeFileSync(fixture.configPath, YAML.stringify(fixture.raw), { mode: 0o600 });
    const concurrentSource = readFileSync(fixture.configPath, 'utf8');

    expect(() =>
      addBuiltinProvider(fixture.configPath, 'cursor', cursorProvider(), expected),
    ).toThrow(/already enabled/i);

    expect(readFileSync(fixture.configPath, 'utf8')).toBe(concurrentSource);
    expect(existsSync(`${fixture.configPath}.backup`)).toBe(false);
  });

  it('preserves an unrelated concurrent update while replacing the unchanged target', () => {
    const fixture = createFixture();
    fixture.raw.providers.cursor = { ...cursorProvider(), enabled: false };
    createConfigDocument(fixture.configPath, fixture.raw);
    const expected = readRawConfigDocument(fixture.configPath).raw.providers.cursor;
    fixture.raw.pollIntervalSeconds = 25;
    writeFileSync(fixture.configPath, YAML.stringify(fixture.raw), { mode: 0o600 });
    const concurrentSource = readFileSync(fixture.configPath, 'utf8');

    const updated = addBuiltinProvider(fixture.configPath, 'cursor', cursorProvider(), expected);

    expect(updated.raw.pollIntervalSeconds).toBe(25);
    expect(updated.raw.providers.cursor).toEqual(cursorProvider());
    expect(readFileSync(`${fixture.configPath}.backup`, 'utf8')).toBe(concurrentSource);
  });

  it('leaves the active document unchanged when the reviewed provider fails validation', () => {
    const fixture = createFixture();
    fixture.raw.providers.cursor = { ...cursorProvider(), enabled: false };
    createConfigDocument(fixture.configPath, fixture.raw);
    const before = readRawConfigDocument(fixture.configPath);

    expect(() =>
      addBuiltinProvider(
        fixture.configPath,
        'cursor',
        { ...cursorProvider(), directive: 'cursor' },
        before.raw.providers.cursor,
      ),
    ).toThrow(/provider directive/i);

    expect(readFileSync(fixture.configPath, 'utf8')).toBe(before.source);
    expect(existsSync(`${fixture.configPath}.backup`)).toBe(false);
  });

  it('merges into a normalized repository match without rewriting its stored identity', () => {
    const fixture = createFixture();
    const secondClone = path.join(fixture.root, 'second-clone');
    mkdirSync(secondClone);
    fixture.raw.repositories[0]!.repository = 'https://github.com/Example/Widget.git';
    fixture.raw.repositories[0]!.alias = 'widget';
    createConfigDocument(fixture.configPath, fixture.raw);

    const repositories = addRepositoryMapping(fixture.configPath, {
      repository: 'example/widget',
      clones: [secondClone],
    });

    expect(repositories).toEqual([
      {
        repository: 'example/widget',
        alias: 'widget',
        clones: [fixture.clone, secondClone],
      },
    ]);
    expect(readRawConfigDocument(fixture.configPath).raw.repositories).toEqual([
      {
        repository: 'https://github.com/Example/Widget.git',
        alias: 'widget',
        clones: [fixture.clone, secondClone],
      },
    ]);
  });

  it('removes an exact clone while preserving its pool, config settings, and checkout contents', () => {
    const fixture = createFixture();
    const secondClone = path.join(fixture.root, 'second-clone');
    const gitDirectory = path.join(fixture.clone, '.git');
    const dirtyMarker = path.join(fixture.clone, 'dirty-marker.txt');
    const untrackedMarker = path.join(fixture.clone, 'untracked-marker.txt');
    mkdirSync(secondClone);
    mkdirSync(gitDirectory);
    writeFileSync(dirtyMarker, 'dirty checkout contents\n');
    writeFileSync(untrackedMarker, 'untracked checkout contents\n');
    fixture.raw.repositories[0] = {
      repository: 'https://github.com/Example/Widget.git',
      alias: 'widget',
      clones: [path.basename(fixture.clone), secondClone],
    };
    createConfigDocument(fixture.configPath, fixture.raw);
    const original = readFileSync(fixture.configPath, 'utf8');

    const result = removeRepositoryMapping(fixture.configPath, fixture.clone);

    expect(result).toEqual({
      clone: fixture.clone,
      repository: 'example/widget',
      poolRemoved: false,
    });
    const raw = readRawConfigDocument(fixture.configPath).raw;
    expect(raw.repositories).toEqual([
      {
        repository: 'https://github.com/Example/Widget.git',
        alias: 'widget',
        clones: [secondClone],
      },
    ]);
    expect(raw.pollIntervalSeconds).toBe(30);
    expect(raw.providers).toEqual(fixture.raw.providers);
    expect(readFileSync(`${fixture.configPath}.backup`, 'utf8')).toBe(original);
    expect(lstatSync(fixture.configPath).mode & 0o777).toBe(0o600);
    expect(lstatSync(`${fixture.configPath}.backup`).mode & 0o777).toBe(0o600);
    expect(existsSync(fixture.clone)).toBe(true);
    expect(existsSync(gitDirectory)).toBe(true);
    expect(readFileSync(dirtyMarker, 'utf8')).toBe('dirty checkout contents\n');
    expect(readFileSync(untrackedMarker, 'utf8')).toBe('untracked checkout contents\n');
  });

  it('removes an empty repository pool when another pool remains', () => {
    const fixture = createFixture();
    const secondClone = path.join(fixture.root, 'second-clone');
    mkdirSync(secondClone);
    fixture.raw.repositories.push({ repository: 'example/second', clones: [secondClone] });
    createConfigDocument(fixture.configPath, fixture.raw);

    const result = removeRepositoryMapping(fixture.configPath, fixture.clone);

    expect(result).toEqual({
      clone: fixture.clone,
      repository: 'example/widget',
      poolRemoved: true,
    });
    expect(readRawConfigDocument(fixture.configPath).raw.repositories).toEqual([
      { repository: 'example/second', clones: [secondClone] },
    ]);
    expect(existsSync(fixture.clone)).toBe(true);
  });

  it('matches a configured symlink alias to an already-canonical clone', () => {
    const fixture = createFixture();
    const secondClone = path.join(fixture.root, 'second-clone');
    const cloneAlias = path.join(fixture.root, 'clone-alias');
    mkdirSync(secondClone);
    symlinkSync(fixture.clone, cloneAlias);
    fixture.raw.repositories[0]!.clones = [cloneAlias, secondClone];
    createConfigDocument(fixture.configPath, fixture.raw);

    const result = removeRepositoryMapping(fixture.configPath, realpathSync(cloneAlias));

    expect(result.clone).toBe(fixture.clone);
    expect(result.poolRemoved).toBe(false);
    expect(readRawConfigDocument(fixture.configPath).raw.repositories[0]!.clones).toEqual([
      secondClone,
    ]);
    expect(existsSync(cloneAlias)).toBe(true);
    expect(existsSync(fixture.clone)).toBe(true);
  });

  it.each([
    {
      name: 'the final configured clone',
      arrange: (fixture: ReturnType<typeof createFixture>) => fixture.clone,
      error: /final configured repository clone/i,
    },
    {
      name: 'an unconfigured directory',
      arrange: (fixture: ReturnType<typeof createFixture>) => {
        const unconfigured = path.join(fixture.root, 'unconfigured');
        mkdirSync(unconfigured);
        return unconfigured;
      },
      error: /clone is not configured/i,
    },
    {
      name: 'a nested directory',
      arrange: (fixture: ReturnType<typeof createFixture>) => {
        const nested = path.join(fixture.clone, 'nested');
        mkdirSync(nested);
        return nested;
      },
      error: /clone is not configured/i,
    },
  ])('refuses to remove $name without changing the configuration', ({ arrange, error }) => {
    const fixture = createFixture();
    const requestedClone = arrange(fixture);
    createConfigDocument(fixture.configPath, fixture.raw);
    const original = readFileSync(fixture.configPath, 'utf8');

    expect(() => removeRepositoryMapping(fixture.configPath, requestedClone)).toThrow(error);

    expect(readFileSync(fixture.configPath, 'utf8')).toBe(original);
    expect(existsSync(`${fixture.configPath}.backup`)).toBe(false);
    expect(existsSync(requestedClone)).toBe(true);
  });

  it.each([
    {
      name: 'an exact duplicate',
      arrange: (fixture: ReturnType<typeof createFixture>) => {
        fixture.raw.repositories[0]!.clones = [path.basename(fixture.clone)];
        return fixture.clone;
      },
      repository: 'example/widget',
      error: /already configured/i,
    },
    {
      name: 'a symlink alias of an existing clone',
      arrange: (fixture: ReturnType<typeof createFixture>) => {
        const alias = path.join(fixture.root, 'clone-alias');
        symlinkSync(fixture.clone, alias);
        fixture.raw.repositories[0]!.clones = [alias];
        return fixture.clone;
      },
      repository: 'example/widget',
      error: /already configured/i,
    },
    {
      name: 'a clone already owned by another pool',
      arrange: (fixture: ReturnType<typeof createFixture>) => fixture.clone,
      repository: 'example/other',
      error: /already configured/i,
    },
    {
      name: 'a descendant of an existing clone',
      arrange: (fixture: ReturnType<typeof createFixture>) => {
        const nested = path.join(fixture.clone, 'nested');
        mkdirSync(nested);
        return nested;
      },
      repository: 'example/widget',
      error: /overlap/i,
    },
    {
      name: 'an ancestor of an existing clone',
      arrange: (fixture: ReturnType<typeof createFixture>) => {
        const nested = path.join(fixture.clone, 'nested');
        mkdirSync(nested);
        fixture.raw.repositories[0]!.clones = [nested];
        return fixture.clone;
      },
      repository: 'example/widget',
      error: /overlap/i,
    },
  ])('rejects $name without changing the configuration', ({ arrange, repository, error }) => {
    const fixture = createFixture();
    const clone = arrange(fixture);
    createConfigDocument(fixture.configPath, fixture.raw);
    const original = readFileSync(fixture.configPath, 'utf8');

    expect(() => addRepositoryMapping(fixture.configPath, { repository, clones: [clone] })).toThrow(
      error,
    );

    expect(readFileSync(fixture.configPath, 'utf8')).toBe(original);
    expect(existsSync(`${fixture.configPath}.backup`)).toBe(false);
  });

  it('does not remove a lock owned by another spool writer', () => {
    const fixture = createFixture();
    createConfigDocument(fixture.configPath, fixture.raw);
    const lockPath = `${fixture.configPath}.lock`;
    const lock = {
      pid: process.pid,
      processStartIdentity: currentProcessStartIdentity(),
      nonce: 'other-writer',
    };
    writeFileSync(lockPath, `${JSON.stringify(lock)}\n`, { mode: 0o600 });

    const secondClone = path.join(fixture.root, 'second-clone');
    mkdirSync(secondClone);
    const original = readFileSync(fixture.configPath, 'utf8');

    expect(() =>
      addRepositoryMapping(fixture.configPath, {
        repository: 'example/second',
        clones: [secondClone],
      }),
    ).toThrow(/another spool configuration update/i);
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, 'utf8')).toBe(`${JSON.stringify(lock)}\n`);
    expect(readFileSync(fixture.configPath, 'utf8')).toBe(original);
  });

  it('recovers a configuration lock whose owning process no longer exists', () => {
    const fixture = createFixture();
    createConfigDocument(fixture.configPath, fixture.raw);
    const lockPath = `${fixture.configPath}.lock`;
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        pid: 2_147_483_647,
        processStartIdentity: 'dead-process',
        nonce: 'stale-writer',
      })}\n`,
      { mode: 0o600 },
    );

    const updated = mutateConfigDocument(fixture.configPath, (raw) => {
      raw.pollIntervalSeconds = 20;
    });

    expect(updated.raw.pollIntervalSeconds).toBe(20);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('aborts mutation when an external edit wins before replacement', () => {
    const fixture = createFixture();
    createConfigDocument(fixture.configPath, fixture.raw);
    const externallyEdited = readFileSync(fixture.configPath, 'utf8').replace(
      'pollIntervalSeconds: 30',
      'pollIntervalSeconds: 25',
    );

    expect(() =>
      mutateConfigDocument(fixture.configPath, (raw) => {
        raw.pollIntervalSeconds = 20;
        writeFileSync(fixture.configPath, externallyEdited);
      }),
    ).toThrow(/changed during configuration update/i);

    expect(readRawConfigDocument(fixture.configPath).raw.pollIntervalSeconds).toBe(25);
  });

  it('rejects symlink targets and unsafe writable configuration parents', () => {
    const fixture = createFixture();
    const realConfig = path.join(fixture.root, 'real.yaml');
    writeFileSync(realConfig, YAML.stringify(fixture.raw), { mode: 0o600 });
    symlinkSync(realConfig, fixture.configPath);

    expect(() => readRawConfigDocument(fixture.configPath)).toThrow(/symbolic link/i);

    const unsafeParent = path.join(fixture.root, 'unsafe');
    mkdirSync(unsafeParent, { mode: 0o777 });
    chmodSync(unsafeParent, 0o777);
    expect(() => createConfigDocument(path.join(unsafeParent, 'config.yaml'), fixture.raw)).toThrow(
      /writable by other users/i,
    );
  });
});

function createFixture(): {
  root: string;
  configPath: string;
  vault: string;
  secondVault: string;
  clone: string;
  raw: RawConfig;
} {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'spool-config-document-')));
  const vault = path.join(root, 'vault');
  const secondVault = path.join(root, 'second-vault');
  const state = path.join(root, 'state');
  const clone = path.join(root, 'clone');
  for (const directory of [vault, secondVault, state, clone]) mkdirSync(directory);
  const raw: RawConfig = {
    vaults: [vault],
    stateDirectory: state,
    timeZone: 'UTC',
    pollIntervalSeconds: 30,
    dayAliases: {},
    providers: {
      claude: {
        enabled: false,
        executable: 'claude',
        directive: '@claude',
        defaultArgs: [],
      },
    },
    repositories: [{ repository: 'example/widget', clones: [clone] }],
  };
  return { root, configPath: path.join(root, 'config.yaml'), vault, secondVault, clone, raw };
}

function cursorProvider(): RawConfig['providers'][string] {
  return {
    enabled: true,
    executable: 'cursor-agent',
    directive: '@cursor',
    defaultArgs: ['--mode', 'plan'],
  };
}
