# Repository Instructions

## Commit Identity

- Every local commit in this repository must use the GitHub noreply email `12542046+elazzabi@users.noreply.github.com` for both author and committer identity.
- Before committing, verify that `git config --local user.email` exactly matches that address. If it does not, stop and restore the repository-local setting before creating the commit.
- Do not override the author or committer email through environment variables, command-line flags, tooling configuration, rebases, or history rewrites.
- Never commit with a personal, employer, or other non-noreply email address.

## Publication Privacy

- Treat this repository as public. Do not add private discussions, local authentication state, internal company information, private URLs, secrets, or user-specific absolute filesystem paths.
- Never commit `.ce-personal/`, `.compound-engineering/config.local.yaml`, `.worktrees/`, or `.agents/scratchpad/`.
- Keep implementation plans and private review handoffs outside the public repository unless the user explicitly approves them for publication.

## Execution Discipline

- Bias toward shipping the smallest change that satisfies the requested behavior.
- Once the behavior works and the relevant tests pass, stop iterating and ship it.
- Do not add speculative abstractions, unrequested edge-case machinery, or open-ended refinement loops.

## Releases

- A release version must be updated together in `package.json`, `package-lock.json`, and the Commander `.version(...)` declaration in `src/cli/index.ts`.
- Before creating a release tag, run `npm run test:runtime` and `npm run release:validate-tag -- --tag v<version>`.
- Release tags are immutable. If a pushed tag fails, fix the release on a new patch version instead of moving or recreating the failed tag.
