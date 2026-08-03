import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';
import { describe, expect, it } from 'vitest';

interface ReleaseBuildModule {
  validateReleaseTag(tag: string, packageVersion: string): string;
}

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const releaseWorkflowPath = path.join(repositoryRoot, '.github/workflows/release.yml');
const npmWorkflowPath = path.join(repositoryRoot, '.github/workflows/publish.yml');
const releaseBuild = (await import(
  // @ts-expect-error Release tooling is intentionally plain JavaScript.
  '../../scripts/build-release.mjs'
)) as ReleaseBuildModule;

describe('GitHub Release workflow contract', () => {
  it('retires npm publication and validates matching version tags', () => {
    expect(existsSync(npmWorkflowPath)).toBe(false);
    expect(releaseBuild.validateReleaseTag('v0.1.0', '0.1.0')).toBe('0.1.0');
    expect(() => releaseBuild.validateReleaseTag('v0.2.0', '0.1.0')).toThrow(/must be v0\.1\.0/i);
    expect(() => releaseBuild.validateReleaseTag('0.1.0', '0.1.0')).toThrow(/must be v0\.1\.0/i);
    expect(() => releaseBuild.validateReleaseTag('v0.1.0-beta.1', '0.1.0-beta.1')).toThrow(
      /exact stable X\.Y\.Z/i,
    );
  });

  it('builds the complete Node 24 platform matrix with version-pinned actions', () => {
    const source = readFileSync(releaseWorkflowPath, 'utf8');
    const workflow = YAML.parse(source) as {
      jobs: Record<string, { strategy?: { matrix?: { include?: unknown[] } } }>;
    };
    const matrix = workflow.jobs.build?.strategy?.matrix?.include;

    expect(matrix).toEqual([
      { runner: 'ubuntu-24.04', platform: 'linux', architecture: 'x64' },
      { runner: 'ubuntu-24.04-arm', platform: 'linux', architecture: 'arm64' },
      { runner: 'macos-15-intel', platform: 'darwin', architecture: 'x64' },
      { runner: 'macos-15', platform: 'darwin', architecture: 'arm64' },
    ]);
    expect(source).toContain('node-version: 24');
    for (const [, reference] of source.matchAll(/^\s*uses:\s*(\S+)$/gm)) {
      expect(reference).toMatch(/@v\d+$/);
    }
  });

  it('gates publication on downloaded assets, provenance, and daemon-lock smoke', () => {
    const source = readFileSync(releaseWorkflowPath, 'utf8');
    const workflow = YAML.parse(source) as {
      on: Record<string, unknown>;
      jobs: Record<string, { needs?: string | string[]; if?: string; steps?: unknown[] }>;
    };

    expect(workflow.on).toHaveProperty('push.tags', ['v*.*.*']);
    expect(workflow.on).toHaveProperty('workflow_dispatch');
    expect(source).toContain('gh release create "$RELEASE_TAG" --draft');
    expect(source).not.toContain('gh release download "$RELEASE_TAG"');
    expect(source).toContain('repos/$GH_REPO/releases?per_page=100');
    expect(source).toContain('repos/$GH_REPO/releases/assets/$asset_id');
    expect(source).toContain('actions/attest@v4');
    expect(source).toContain('gh attestation verify');
    expect(source).toContain('--daemon-lock true');
    expect(source).toContain('release-manifest.json');
    expect(source).toContain('SHA256SUMS');

    expect(workflow.jobs.publish?.needs).toEqual(['validate', 'smoke-release']);
    expect(workflow.jobs.publish?.if).toContain("github.event_name == 'push' || inputs.publish");
    expect(JSON.stringify(workflow.jobs.publish?.steps)).toContain('gh release edit');
    expect(JSON.stringify(workflow.jobs.publish?.steps)).toContain('--draft=false');
    expect(JSON.stringify(workflow.jobs.publish?.steps)).not.toContain('--latest');
  });

  it('can safely resume a tagged release from the updated main workflow', () => {
    const source = readFileSync(releaseWorkflowPath, 'utf8');
    const workflow = YAML.parse(source) as {
      on: { workflow_dispatch?: { inputs?: Record<string, { default?: unknown; type?: string }> } };
      jobs: Record<
        string,
        { if?: string; permissions?: Record<string, string>; steps?: Array<{ run?: string }> }
      >;
    };
    const validationCommands = workflow.jobs.validate?.steps
      ?.map((step) => step.run ?? '')
      .join('\n');

    expect(workflow.on.workflow_dispatch?.inputs?.publish).toEqual({
      description: 'Resume and publish an existing draft release after validation',
      required: false,
      default: false,
      type: 'boolean',
    });
    expect(validationCommands).toContain('git rev-parse "$RELEASE_TAG^{commit}"');
    expect(workflow.jobs.draft?.if).toContain("github.event_name == 'push' || inputs.publish");
    expect(workflow.jobs['smoke-release']?.if).toContain(
      "github.event_name == 'push' || inputs.publish",
    );
    expect(workflow.jobs['smoke-release']?.permissions?.contents).toBe('write');
    expect(workflow.jobs['smoke-dry-run']?.if).toContain('!inputs.publish');
  });

  it('reuses draft releases while preserving repository and publication gates', () => {
    const source = readFileSync(releaseWorkflowPath, 'utf8');
    const workflow = YAML.parse(source) as {
      env: Record<string, string>;
      jobs: Record<string, { steps?: Array<{ run?: string }> }>;
    };
    const draftCommands = workflow.jobs.draft?.steps?.map((step) => step.run ?? '').join('\n');

    expect(workflow.env.GH_REPO).toBe('${{ github.repository }}');
    expect(draftCommands).toContain('gh release view "$RELEASE_TAG" --json isDraft');
    expect(draftCommands).toContain('if [ "$release_is_draft" != "true" ]');
    expect(draftCommands).toContain('gh release create "$RELEASE_TAG" --draft');
    expect(draftCommands).toContain('gh release upload "$RELEASE_TAG"');
    expect(draftCommands).toContain('--clobber');
  });

  it('contains no registry publication credentials or commands', () => {
    const source = readFileSync(releaseWorkflowPath, 'utf8');
    expect(source).not.toMatch(/npm\s+publish/i);
    expect(source).not.toMatch(/registry-url|registry\.npmjs\.org|NPM_TOKEN|NODE_AUTH_TOKEN/i);
  });
});
