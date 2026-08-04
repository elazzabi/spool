# spool — run coding agents from Markdown

**Turn a todo in Obsidian or any Markdown folder into a durable local agent job.**

spool watches the notes you already use, sends explicitly tagged tasks to Claude Code, Codex, Cursor Agent, or Pi, writes progress beneath the original todo, and routes human follow-ups back into your notes. Your notes stay the control plane; your agents work in local Git clones you choose.

If Markdown is already where you decide what to do, spool makes it where you delegate too.

[Quick start](#quick-start) · [Install and update](#managed-installation-and-updates) · [Your first task](#your-first-task) · [Workspaces](#workspaces-are-folders-on-purpose) · [Safety](#safety-first) · [Commands](#everyday-commands)

## Quick start

You need Node.js 24, Git, and at least one supported agent CLI installed and signed in. The first release channel supports Node 24 on macOS or Linux, on either `x64` or `arm64`.

Install the latest stable spool release from GitHub:

```sh
curl -fsSL https://raw.githubusercontent.com/elazzabi/spool/main/install.sh | sh
```

The default prefix is `$HOME/.local`. If its `bin` directory is not already on your shell's `PATH`, add it and restart your shell:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

Confirm the installed release, run the guided setup, then start the daemon:

```sh
spool --version
spool init
spool daemon
```

`spool init` finds the agent CLIs already available on your machine, helps you choose safe access profiles, asks which Markdown folders to watch, and registers the existing local Git clones agents may use. It never asks for provider credentials.

For screen readers and terminals that do not work well with cursor controls, use the line-oriented wizard:

```sh
spool init --plain
```

## Managed installation and updates

The installer selects the release archive for the current operating system, architecture, Node 24 runtime, and ABI. It verifies the release manifest, archive size, and SHA-256 digest before it runs candidate code.

Install an exact stable version instead of the latest one:

```sh
curl -fsSL https://raw.githubusercontent.com/elazzabi/spool/main/install.sh | sh -s -- --version 0.1.0
```

Choose a different installation prefix, or combine `--prefix` with `--version`:

```sh
curl -fsSL https://raw.githubusercontent.com/elazzabi/spool/main/install.sh | sh -s -- --prefix "$HOME/.spool"
```

For a custom prefix, place its `bin` directory before older installations on `PATH` before running the command.

The managed layout under the selected prefix keeps program files separate from your data:

```text
$HOME/.local/
├── bin/
│   └── spool -> ../lib/spool/current/bin/spool
└── lib/spool/
    ├── current -> versions/0.1.0
    ├── versions/
    │   └── 0.1.0/
    └── managed-install.json
```

Immutable releases live under `lib/spool/versions/`; `lib/spool/current` is the atomic active-version pointer, and `managed-install.json` records installer ownership.

Update to the latest stable release, or request an exact newer release:

```sh
spool update
spool update --version 0.2.0
```

Updates only operate on installations with valid installer ownership metadata. Requesting the installed version is a no-op; unavailable versions and downgrades are refused. spool never checks for or installs updates automatically.

Remove installer-owned program files and the managed executable with:

```sh
spool uninstall
```

Uninstall preserves your configuration, state and SQLite ledger, operational logs, watched Markdown files, provider sessions, and quarantined workspaces. These live outside the managed program prefix and remain yours across install, update, rollback, and uninstall.

### Failure and rollback posture

An update downloads and smoke-tests the candidate with isolated temporary configuration and state before activation. It then holds the configured daemon lock while atomically switching `lib/spool/current`. A failure before activation leaves the current version untouched; a failed post-activation check restores the previous version. A failed clean installation removes its staged version and leaves no managed executable active.

spool does not stop your daemon. If the configured ledger is owned by an active daemon, install, update, and uninstall refuse without changing program files and print a copyable `kill PID` recovery command. Stop that process deliberately, then retry.

### Collisions, PATH shadowing, and older links

The installer never overwrites unrelated files. If the target in the prefix's `bin` directory is occupied by a file or link it does not own, installation refuses with no changes. Inspect the reported path and remove or relocate it only when you know what created it.

A different `spool` earlier on `PATH` is a shadow, not an owned-target collision. The managed release remains installed, but the command returns an attention result with the correction. For the default prefix:

```sh
export PATH="$HOME/.local/bin:$PATH"
hash -r
command -v spool
```

The `command -v` result should point into `$HOME/.local/bin`. If another executable shadows it, inspect that executable and remove or relocate it only when you know what created it.

## Your first task

Add a repository URL and an unchecked todo to any `.md` file in a watched folder. Put a supported directive at the beginning or end of the todo:

```markdown
## Monday

- Repository https://github.com/example/widget
  - [ ] Explain the checkout flow and suggest missing tests @codex
```

spool will:

1. Match the repository to one of your configured local clones.
2. Start Codex with the todo, its surrounding Markdown, and repository context.
3. Keep a durable receipt beneath the todo with status, latest output, and an inspect command.
4. Check the source todo when the agent finishes and add a separate todo for human review.

The note becomes a live handoff:

````markdown
- [ ] Explain the checkout flow and suggest missing tests @codex
  ```spool
  Task: task-123
  Anchor: spool-task-123
  Session: 11111111-1111-4111-8111-111111111111
  Status: Working
  Last update: 2026-07-20T09:15:00.000Z

  Context:
  Repository (ancestor): example/widget
  Instruction (direct): Explain the checkout flow and suggest missing tests

  Inspect: codex --sandbox read-only resume 11111111-1111-4111-8111-111111111111
  Cancel: spool cancel task-123

  Latest output:
  Tracing the checkout flow and its existing tests…
  ```
````

You keep writing ordinary Markdown. spool only owns the generated receipt and follow-up rows; unrelated notes and todos stay untouched.

## Highlights

- **Markdown-native** — delegate from Obsidian, a weekly note, a project file, or any other Markdown folder.
- **Explicit dispatch** — only unchecked todos beginning or ending with `@claude`, `@codex`, `@cursor`, or `@pi` become jobs.
- **Durable by default** — jobs, sessions, leases, output, and pending note updates survive restarts in a local SQLite ledger.
- **Multi-agent** — use different coding agents from the same note without changing your workflow.
- **Human in the loop** — completion creates a review todo; it never pretends agent completion equals human approval.
- **Workspace-aware** — map several clean clones to one repository and let independent jobs use them concurrently.
- **Conservative recovery** — uncertain launches are not duplicated, changed workspaces are quarantined, and manual Git work is never auto-cleaned.
- **Local-first** — notes, state, provider sessions, and repositories remain on your machine unless the agent you configured sends data elsewhere.

## Workspaces are folders on purpose

A workspace is an ordinary local Git checkout that spool may lend to one job at a time. It is not a branch, an agent session, or a directory that spool creates for you.

spool deliberately uses complete, separate checkout folders instead of creating or managing Git worktrees. This costs more disk space, but the mental model is simpler: each folder can be opened, inspected, moved, or removed on its own, with its own Git state and local tooling. This is an opinionated design choice, not a temporary limitation.

Several folders can track the same GitHub repository. spool groups them into one repository pool by their `origin` and treats every clean folder as independent capacity:

```sh
git clone https://github.com/example/widget.git ~/src/widget-agent-1
git clone https://github.com/example/widget.git ~/src/widget-agent-2

spool config repository add ~/src/widget-agent-1
spool config repository add ~/src/widget-agent-2
```

With those two workspaces, two jobs for `example/widget` can run concurrently. A third waits until one becomes available. spool never clones a repository, switches its branch, pulls changes, or cleans it on your behalf.

See the configured pools and the live state of every workspace with:

```sh
spool workspace list
```

The output explains whether each folder is eligible, unsafe, or leased, followed by the durable leases spool knows about. `spool config show` displays the static repository-to-folder mapping instead.

When a job finishes without changing its workspace, spool releases the folder for another job. If the workspace changed, spool quarantines it for human inspection rather than guessing whether the changes are valuable. After inspecting and restoring it to the state you want, check the generated Markdown action. If the daemon is stopped, use `spool workspace acknowledge /absolute/path/to/clone`.

To stop using an idle workspace, stop the daemon and run:

```sh
spool config repository remove /absolute/path/to/clone
```

The command requires the exact configured checkout directory to still exist. It refuses a workspace with a non-released lease, so recover or release Held, ReleasePending, or Quarantined work shown by `spool workspace list` before retrying. It removes an empty repository pool automatically when another pool remains, but refuses to remove the final configured repository clone; add another clone first. If the checkout was already moved or deleted, carefully edit the YAML file passed to `--config` (relative paths resolve from the invocation directory). Without `--config`, edit `$XDG_CONFIG_HOME/spool/config.yaml` when `XDG_CONFIG_HOME` is set, `%APPDATA%\spool\config.yaml` on Windows, `~/Library/Application Support/spool/config.yaml` on macOS, or `~/.config/spool/config.yaml` on other Unix systems. Remove its path from `repositories[].clones`, removing the now-empty repository entry if needed while retaining at least one pool with one clone. Start the daemon again when you are done. Removing a workspace only unregisters its folder; spool never deletes the checkout from disk.

## Safety first

spool is a local dispatcher, not an autonomous GitHub bot.

spool itself does **not** create GitHub comments, reviews, approvals, issues, branches, commits, pull requests, or repository clones. A pull-request URL supplies context only; it does not authorize a GitHub write. Delegated agents return results to their local sessions by default and may change an assigned workspace only when the task and their configured permissions allow it.

spool also never stashes, resets, cleans, or overwrites a clone to make it available. Dirty or busy clones are skipped. If a workspace changes unexpectedly during a job, spool quarantines it and asks you to inspect it before reuse.

When a job leaves a clean task branch checked out, that branch remains visible while you review the result. Checking the generated quarantine action, or running `spool workspace acknowledge` while the daemon is stopped, authorizes spool to attempt a non-forcing switch back to the branch captured before the job. spool releases the clone only if that branch still points to its captured commit and a fresh inspection exactly matches the original safe state. The task branch is preserved. If the checkout is dirty, detached, otherwise changed, or the captured branch moved, restoration is refused and the clone stays quarantined for another inspection; spool never stashes, resets, cleans, deletes a branch, or forces local changes away. Crash recovery after an already-approved sentinel removal is the irreversible boundary: it completes the pending release because the checkout step can no longer be safely retried under the removed sentinel.

The setup wizard presents access-profile options where providers support them. Review the selected agent and arguments before accepting the final setup summary.

## Supported agents

| Agent        | Directive |
| ------------ | --------- |
| Claude Code  | `@claude` |
| Codex CLI    | `@codex`  |
| Cursor Agent | `@cursor` |
| Pi           | `@pi`     |

spool uses the arguments you configure for each CLI. Choosing an agent's permissions and operating mode is up to you.

spool reuses each CLI's normal signed-in configuration. Ambient API-key and OAuth-token environment variables are deliberately removed from note-driven child processes because provider output is projected back into your notes. Sign in through the provider CLI instead of putting credentials in spool configuration.

The parsers are currently validated against Claude Code 2.1.212, Codex CLI 0.144.5, Cursor Agent 2026.01.28-fd13201, and `@earendil-works/pi-coding-agent` 0.74.2. Compatible versions can still run; spool warns when a version has not been validated and fails malformed runtime events conservatively.

> **Pi boundary:** Pi's built-in read tools can access any file readable by your OS user, and a Pi configuration without Git tools cannot inspect Git diffs. Its configured tools are not path containment.

## How note dispatch works

Every regular `.md` file at any depth below a watched folder is eligible. A task dispatches only when all of these are true:

- It is an unchecked Markdown todo.
- Its text begins or ends with a configured provider directive.
- It has repository context from its own text or an ancestor list item.
- spool can safely parse the note and identify the generated region it owns.
- A matching configured clone is available.

Checked todos, prose mentions in the middle, fenced examples, symbolic links, malformed notes, and copied or edited receipt markers do not dispatch.

Repository and pull-request context can be inherited by several tasks:

```markdown
- Repository https://github.com/example/widget
  - [ ] Update the onboarding guide @claude
  - [ ] Review https://github.com/example/widget/pull/101 @codex
  - [ ] Trace the retry path @cursor
```

Multiple directives for the same agent are independent jobs. A repository with several configured clones can run several jobs at once; extra jobs wait without disturbing the clones.

### Follow-ups stay in your notes

When an agent exposes a reliable needs-input event, spool adds an indented `Agent needs input` todo with the exact inspect or resume command. When the agent resumes, that row is checked and retained, so the note records how often intervention was needed.

If a completed job changed its assigned checkout, spool also adds an `Inspect quarantined workspace` action. Its text names the captured branch and explains that checking it will attempt restoration before releasing the clone, so review happens while the task branch is still checked out.

When a job in the current root weekly note completes, spool checks the source directive and adds an unchecked `Check agent output using command …` todo beneath it. For tasks in any other note, spool checks the source directive there and inserts the review todo once in the current weekly note with an Obsidian backlink. spool never creates the weekly note for you; it holds the action until the note exists.

See [`examples/vault`](examples/vault) for realistic notes with unrelated todos, inherited repository context, pull requests, concurrent jobs, and all four providers.

## Everyday commands

```sh
# Check configuration, dependencies, agents, state, and workspaces.
spool doctor

# Show durable jobs, attempts, sessions, and workspace availability.
spool status
spool workspace list

# Reconcile all immediately available work without keeping a daemon open.
spool run-once

# Read retained operational history or follow new activity.
spool logs
spool logs --follow

# Ask spool to cancel a job using the ID in its receipt.
spool cancel TASK_ID

# After inspecting a quarantined clone. An active daemon handles the request on its next pass.
spool workspace acknowledge /absolute/path/to/clone
```

Workspace acknowledgment does not require knowing which note started the job. If the daemon is
running, the command records a durable request and returns immediately; the daemon re-inspects the
clone before releasing it. `spool workspace list` and `spool status` show whether the request is
pending or was refused, including the refusal reason. If no daemon is running and another
short-lived spool command held the state lock, rerun the acknowledgment command to perform the
inspection and release directly.

Cancellation is evidence-based: a request becomes `Cancelled` only after the provider or supervised process supplies terminal proof.

Use an explicit configuration file with any command when needed:

```sh
spool --config /path/to/spool.config.yaml status
```

## Configuration

Routine setup does not require hand-editing YAML:

```sh
# Inspect effective settings. Secret-shaped arguments are redacted.
spool config show

# List, add, or remove watched Markdown folders.
spool config watch list
spool config watch add /path/to/another/notes-folder
spool config watch remove /path/to/old/notes-folder

# Add or remove an existing checkout in a repository workspace pool.
spool config repository add ./another-widget
spool config repository remove /path/to/old-widget
```

Watched folders and workspaces serve different sides of spool: watched folders contain the Markdown that creates jobs, while workspaces are the Git checkouts where agents run. Adding either kind of folder registers an existing directory; spool does not create it. Stop the daemon before removing either kind of folder. spool refuses to remove the final watched folder, a watched folder still referenced by unfinished work, the final repository clone, or a workspace with a non-released lease. Removal only updates the configuration; it does not delete the directory from disk.

Restart the daemon after changing watched folders, repositories, providers, or provider arguments.

YAML remains the inspectable source of truth for advanced changes. [`examples/spool.config.yaml`](examples/spool.config.yaml) documents the complete schema, including provider executables, literal argument arrays, polling, time zone, state location, and repository pools. With no `--config`, spool uses the platform's normal user configuration directory.

Provider arguments are passed as an argv array, never through a shell. Keep API keys, tokens, authorization headers, passwords, and other credentials out of `defaultArgs`. Manual YAML bypasses the onboarding validation that rejects credential-shaped and spool-owned flags.

## Operational guarantees and limits

- SQLite is authoritative; Markdown receipts are projections delivered through an idempotent outbox.
- Only one daemon may own a state directory.
- State must live outside watched Markdown folders and is owner-private on POSIX.
- If a provider crosses the launch boundary without durable identity, spool records the attempt as `Uncertain` and never relaunches it automatically.
- Provider processes generally cannot be reattached after a spool crash; the durable receipt preserves the honest evidence available.
- Operational logs contain bounded reason codes and opaque IDs, not note text, paths, prompts, provider output, session IDs, repository names, or argv values.
- Operational history is capped at eight 8 MiB segments and archives older than 30 days are removed during owned runtime activity.
- Terminal attempt logs are removed after 30 days; active and uncertain evidence is retained.
- Pi transcripts persist under the private state directory until you remove them according to your own retention policy.

## Development

npm is contributor tooling only; it is not an end-user installation or update channel. Contributors can install dependencies and use the local binary without creating global links:

```sh
npm ci
npm run build
node dist/cli/index.js init
node dist/cli/index.js daemon
```

Run the complete deterministic check before submitting changes:

```sh
npm run check
```

Focused suites are also available:

```sh
npm run test:integration
npm run test:e2e
npm run test:recovery
npm run test:runtime
npm run smoke:providers
```

`test:runtime` builds the CLI and uses a local package preview as an allowlist for GitHub release assembly. It rejects development-only files and registry publication metadata, checks the executable, and verifies that the CLI and package versions match. Nothing is uploaded.

`smoke:providers` launches installed, authenticated providers in disposable repositories with restricted non-mutating flags. It verifies terminal proof, session identity, inspect commands, clean workspaces, and the no-GitHub-write boundary. All four providers are expected unless explicitly waived with `SPOOL_SMOKE_WAIVE`.

## GitHub release process

A matching `v<package-version>` tag drives `.github/workflows/release.yml`. The workflow builds all four Node 24 assets, assembles the manifest and checksums, creates a draft GitHub Release, downloads every asset into clean platform jobs, verifies provenance, and publishes the draft only after every smoke test passes.

Validate an existing matching tag without creating a release:

```sh
gh workflow run release.yml --ref v0.1.0 -f tag=v0.1.0
```

This manual path builds, attests, downloads, and smokes the candidate matrix but never creates or publishes a GitHub Release. npm remains the dependency manager and build runner for contributors; no npm registry release is produced.

## License

spool is released under the [O'Saasy License](LICENSE.md).
