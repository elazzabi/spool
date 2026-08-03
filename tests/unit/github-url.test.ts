import { describe, expect, it } from 'vitest';

import { normalizeGitHubRepository } from '../../src/config/schema.js';
import { parseGitHubPullRequest } from '../../src/workspaces/github.js';

describe('GitHub pull request resolution', () => {
  it('parses and normalizes an HTTPS pull request URL', () => {
    expect(parseGitHubPullRequest('https://github.com/Example/Widget/pull/42')).toEqual({
      url: 'https://github.com/Example/Widget/pull/42',
      repository: 'example/widget',
      number: 42,
    });
  });

  it.each([
    'https://gitlab.com/example/widget/pull/42',
    'https://github.com/example/widget/issues/42',
    'https://github.com/example/widget/pull/not-a-number',
    'git@github.com:example/widget.git',
  ])('rejects a non-PR URL: %s', (value) => {
    expect(() => parseGitHubPullRequest(value)).toThrow(/GitHub pull request URL/i);
  });

  it.each([
    ['https://github.com/Example/Widget.git', 'example/widget'],
    ['git@github.com:Example/Widget.git', 'example/widget'],
    ['ssh://git@github.com/Example/Widget.git', 'example/widget'],
    ['github.com/Example/Widget', 'example/widget'],
  ])('normalizes supported repository identity %s', (value, expected) => {
    expect(normalizeGitHubRepository(value)).toBe(expected);
  });
});
