import { normalizeGitHubRepository } from '../config/schema.js';
import type { ParsedDirective, PullRequestContext, RepositoryContext } from './directives.js';

const githubUrl = /https:\/\/github\.com\/[^\s)>\]}]+/gi;

export interface GitHubTargetContext {
  repository: RepositoryContext;
  pr?: PullRequestContext;
}

interface RankedGitHubTarget {
  context: GitHubTargetContext;
  rank: number;
}

export function findGitHubTarget(
  directText: string,
  ancestors: readonly string[],
  repositoryAliases: ReadonlyMap<string, string> = new Map(),
): GitHubTargetContext | undefined {
  let selected = findGitHubTargetInText(directText, 'direct');
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = ancestors[index];
    if (ancestor === undefined) continue;
    const inherited = findGitHubTargetInText(ancestor, 'ancestor');
    if (inherited && (!selected || inherited.rank > selected.rank)) selected = inherited;
    if (index === 0) {
      const aliased = findRepositoryAlias(ancestor, repositoryAliases);
      if (aliased && (!selected || aliased.rank > selected.rank)) selected = aliased;
    }
  }
  return selected?.context;
}

function findRepositoryAlias(
  text: string,
  repositoryAliases: ReadonlyMap<string, string>,
): RankedGitHubTarget | undefined {
  const repository = repositoryAliases.get(text.trim().toLowerCase());
  return repository
    ? {
        context: { repository: { repository, provenance: 'ancestor' } },
        rank: 2,
      }
    : undefined;
}

function findGitHubTargetInText(
  text: string,
  provenance: RepositoryContext['provenance'],
): RankedGitHubTarget | undefined {
  let repositoryFallback: RankedGitHubTarget | undefined;
  for (const match of text.matchAll(githubUrl)) {
    const value = match[0].replace(/[.,;:!?]+$/, '');
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      continue;
    }
    const parts = url.pathname.split('/').filter(Boolean);
    const isRepository = parts.length === 2;
    const isPullRequest =
      parts.length >= 4 && parts[2]?.toLowerCase() === 'pull' && /^\d+$/.test(parts[3] ?? '');
    if (!isRepository && !isPullRequest) continue;

    let repository: string;
    try {
      repository = normalizeGitHubRepository(value);
    } catch {
      continue;
    }
    const repositoryContext = { repository, provenance };
    if (isPullRequest) {
      return {
        context: {
          repository: repositoryContext,
          pr: { ...repositoryContext, url: value },
        },
        rank: 3,
      };
    }
    const prefix = text.slice(0, match.index);
    const rank = /^\s*repository\s*:?\s*$/i.test(prefix) ? 2 : 1;
    if (!repositoryFallback || rank > repositoryFallback.rank) {
      repositoryFallback = { context: { repository: repositoryContext }, rank };
    }
  }
  return repositoryFallback;
}

export function compilePromptContext(directive: ParsedDirective): string {
  const lines: string[] = [];
  if (directive.context.dayHeading) {
    lines.push(`Day (heading): ${directive.context.dayHeading}`);
  }
  for (const ancestor of directive.context.ancestors) {
    lines.push(`Ancestor (list): ${ancestor}`);
  }
  if (directive.context.pr) {
    lines.push(`PR (${directive.context.pr.provenance}): ${directive.context.pr.url}`);
  }
  if (directive.context.repository) {
    lines.push(
      `Repository (${directive.context.repository.provenance}): ${directive.context.repository.repository}`,
    );
  }
  lines.push(`Instruction (direct): ${directive.directiveText}`);
  return lines.join('\n');
}
