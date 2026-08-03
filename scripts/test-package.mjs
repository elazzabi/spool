import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

export const PACKAGE_CLI_PATH = 'dist/cli/index.js';
export const PACKAGE_REQUIRED_FILES = Object.freeze([
  'LICENSE.md',
  'README.md',
  PACKAGE_CLI_PATH,
  'examples/spool.config.yaml',
  'examples/providers/fake-agent.mjs',
  'package.json',
]);
export const PACKAGE_FORBIDDEN_PREFIXES = Object.freeze([
  '.agents/',
  '.github/',
  'docs/',
  'src/',
  'tests/',
]);
export const PACKAGE_FORBIDDEN_FILES = Object.freeze(['tsconfig.json', 'tsconfig.tests.json']);

export function inspectNpmPackage(packageRoot) {
  const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const pack = spawnSync(
    npmExecutable,
    ['pack', '--dry-run', '--ignore-scripts', '--json', '--silent'],
    {
      cwd: packageRoot,
      encoding: 'utf8',
    },
  );
  if (pack.status !== 0) {
    throw new Error(`runtime package preview failed:\n${pack.stderr}`);
  }
  const [result] = JSON.parse(pack.stdout);
  const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  verifyContributorOnlyMetadata(manifest);
  verifyPackageContents(result, manifest, packageRoot);
  return result;
}

export function verifyContributorOnlyMetadata(manifest) {
  if (manifest.private !== true) {
    throw new Error('The contributor package must remain private');
  }
  if (manifest.publishConfig || manifest.scripts?.prepack || manifest.scripts?.prepublishOnly) {
    throw new Error('Registry publication metadata is not allowed');
  }
  if (manifest.bin?.spool !== PACKAGE_CLI_PATH) {
    throw new Error('The runtime executable must target the compiled CLI');
  }
}

export function verifyPackageContents(result, manifest, packageRoot) {
  const files = new Map(result.files.map((file) => [file.path, file]));

  for (const file of PACKAGE_REQUIRED_FILES) {
    if (!files.has(file)) {
      throw new Error(`runtime package is missing required file: ${file}`);
    }
  }

  for (const file of files.keys()) {
    if (
      PACKAGE_FORBIDDEN_FILES.includes(file) ||
      PACKAGE_FORBIDDEN_PREFIXES.some((prefix) => file.startsWith(prefix))
    ) {
      throw new Error(`runtime package contains development-only file: ${file}`);
    }
  }

  const cli = files.get(PACKAGE_CLI_PATH);
  if ((cli.mode & 0o111) === 0) {
    throw new Error(`${PACKAGE_CLI_PATH} is not executable in the runtime package`);
  }

  const version = spawnSync(process.execPath, [PACKAGE_CLI_PATH, '--version'], {
    cwd: packageRoot,
    encoding: 'utf8',
  });
  if (version.status !== 0) {
    throw new Error(`runtime package CLI version check failed:\n${version.stderr}`);
  }
  if (version.stdout.trim() !== manifest.version) {
    throw new Error(
      `CLI version ${version.stdout.trim()} does not match package version ${manifest.version}`,
    );
  }
}

function main() {
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  const result = inspectNpmPackage(packageRoot);
  process.stdout.write(
    `Verified ${result.entryCount} files in the runtime package preview (${result.size} bytes)\n`,
  );
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
