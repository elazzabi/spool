import { normalizeGitHubRepository } from '../config/schema.js';

export interface GitHubPullRequest {
  url: string;
  repository: string;
  number: number;
}

export class GitHubPullRequestError extends Error {
  override readonly name = 'GitHubPullRequestError';
}

export function parseGitHubPullRequest(value: string): GitHubPullRequest {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw invalidPullRequest(value);
  }

  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') {
    throw invalidPullRequest(value);
  }

  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== 4 || parts[2]?.toLowerCase() !== 'pull' || !/^\d+$/.test(parts[3] ?? '')) {
    throw invalidPullRequest(value);
  }
  const number = Number(parts[3]);
  if (!Number.isSafeInteger(number) || number < 1) throw invalidPullRequest(value);

  return {
    url: `https://github.com/${parts[0]}/${parts[1]}/pull/${number}`,
    repository: normalizeGitHubRepository(`${parts[0]}/${parts[1]}`),
    number,
  };
}

function invalidPullRequest(value: string): GitHubPullRequestError {
  return new GitHubPullRequestError(`Invalid GitHub pull request URL: ${value}`);
}
