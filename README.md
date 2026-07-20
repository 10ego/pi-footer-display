# pi-footer-display

A Pi extension that adds the active Git repository, branch, open pull request, and wall-clock session age to Pi's native footer.

## Problem and proposal

A Pi session can touch more than one checkout, while the startup directory and native footer do not always make the repository currently in use obvious. Replacing Pi's footer would expose this context at the cost of hiding Pi's built-in model, token, and other status information.

`pi-footer-display` instead publishes one named status with:

```ts
ctx.ui.setStatus("pr-footer", text)
```

In Pi's TUI, Pi composes that status into its built-in footer. The extension never calls `setFooter`, so it does not replace or take ownership of the native footer renderer. It clears only its own `pr-footer` status when the session shuts down.

## Footer format

Segments are separated by ` · `. Examples below are exact formatter output for a session age of 12 minutes:

| Situation | Status text |
| --- | --- |
| Open pull request | `acme/widget · feature/footer · PR #42 · 12m` |
| Draft pull request | `acme/widget · feature/footer · draft PR #42 · 12m` |
| No matching open pull request | `acme/widget · feature/footer · 12m` |
| Pinned repository | `📌 acme/widget · feature/footer · PR #42 · 12m` |
| Detached HEAD | `acme/widget · @a1b2c3d · ! · 12m` |
| Non-GitHub repository | `widget · main · ! · 12m` |
| GitHub metadata unavailable | `acme/widget · main · ! · 12m` |
| Two equally strong repository candidates | `repo? 2 · ? · 12m` |
| No usable repository | `repo — · ! · 12m` |
| Persisted pin temporarily unverifiable | `📌 repo — · ~ · 12m` |

`?` means automatic discovery is ambiguous. `!` means some context is unavailable or degraded. `~` means persisted context is stale because it could not be revalidated. A missing PR segment without `!` means the GitHub lookup succeeded but found no open PR for the current branch.

Age is compact wall-clock time: seconds under one minute, whole minutes under one hour, then values such as `2h5m` or `1d2h`.

## Automatic repository tracking

The extension resolves repository evidence in this priority order:

1. Paths passed to Pi's `read`, `write`, `edit`, `grep`, `find`, or `ls` tools. Relative paths are resolved against Pi's session working directory.
2. Deterministic paths from a deliberately small set of literal `bash` forms:
   - `git -C <path> ...`, where `<path>` may be absolute or relative;
   - `cd <path> && <one simple command>`, where `<path>` may be absolute or relative;
   - exact `git worktree add <destination> [<commit-ish>]` commands;
   - one absolute operand to a small path-oriented command allowlist.
3. The session's startup working directory as a weak startup fallback.

Ordinary path hints are grouped over a 100 ms debounce window. Within the strongest evidence tier that resolves to repositories:

- one canonical Git root is selected;
- multiple roots produce `repo? N · ?` instead of guessing;
- paths confirmed to be outside a repository are ignored, and unrelated non-repository activity does not discard the last confirmed root;
- an indeterminate discovery failure publishes unavailable context instead of being treated as “not a repository”;
- if activity resolves to repository B but B's local metadata cannot be read, the footer publishes unavailable B context rather than continuing to show repository A.

Commands that can change the displayed Git identity—supported `git switch`, `checkout`, branch/remote/config/worktree mutations, `gh pr checkout`, and selected `gh pr` mutations—are handled after Pi emits `tool_result`, whether the command reports success or failure. This catches partial side effects and worktrees that did not exist before execution. Call-order sequence and generation guards prevent late older work from replacing newer context. If a recognized effect has no matching result, `agent_settled` performs one final coalesced local reconciliation; clean runs do no such work.

File-tool evidence outranks bash evidence, and the startup fallback cannot override either. Expansions, substitutions, globs, tilde expansion, redirects, pipes, subshells, multiple directory changes, unsupported options, and conflicting paths are intentionally rejected rather than guessed. Pinned mode never changes roots from automatic evidence, although a recognized mutation inside the pinned worktree refreshes its branch and PR metadata.

## Commands

```text
/pr-footer
/pr-footer status
/pr-footer help
/pr-footer pin <path>
/pr-footer unpin
/pr-footer refresh
```

- `/pr-footer` reports the current status and then shows command usage.
- `/pr-footer status` reports the formatted status, selection mode, and selected or last-confirmed absolute root.
- `/pr-footer help` shows `Usage: /pr-footer [status|help|pin <path>|unpin|refresh]`.
- `/pr-footer pin <path>` resolves the path against Pi's current working directory, validates the containing Git repository, pins its canonical root, and refreshes metadata. The path may be absolute or relative.
- `/pr-footer unpin` returns to automatic mode and resumes tool-based tracking. It initially retains the last confirmed repository until stronger new evidence arrives.
- `/pr-footer refresh` invalidates cached path and metadata for the pinned, current, or last-confirmed repository and resolves it again. With no known root, it retries the startup working directory.

Pin, unpin, refresh, and later automatic selections use generation guards, so a slower, superseded lookup cannot overwrite a newer choice.

## Session age and persistence

The displayed age is based on a persisted `startedAt` wall-clock timestamp. On first use, the extension takes Pi's session-header timestamp when valid; otherwise it uses the current time. It stores versioned custom session entries containing the timestamp, mode, pinned root, and last confirmed root.

Consequences:

- refreshes and extension reloads do not reset age;
- resuming a session continues from the original timestamp;
- time while Pi is closed is included—it is not active-work duration;
- a system clock earlier than `startedAt` displays `0s` rather than a negative age.

Restored pins are revalidated and canonicalized with structured results. Automatic session startup always resolves the session working directory rather than selecting a persisted last-confirmed root. A confirmed deleted or non-repository pin downgrades to automatic mode and resolves the startup directory. An indeterminate failure—missing or timed-out Git, permission or realpath failure, or another process error—preserves `mode=pinned`, `pinnedRoot`, `lastConfirmedRoot`, and `startedAt`, publishes stale/unavailable status, and does not persist an automatic-mode downgrade.

### `/new` and the session working directory

Pi emits a new session lifecycle when `/new` is used, so the footer is cleared and initialized again. However, Pi 0.80.7 through 0.80.10 deliberately reuse the existing runtime working directory for the new session. `/new` therefore does not by itself select another worktree.

In automatic mode, the footer follows the first supported path or shell signal for the other worktree. If the work happens through an opaque custom tool or unsupported shell expression, start Pi in that worktree or use `/pr-footer pin <path>`. Pi currently exposes neither an authoritative `cwd_changed` extension event nor a `newSession({ cwd })` option.

## Prerequisites

- Node.js 22.19.0 or newer
- Pi 0.80.7 or newer
- Git available as `git`
- Optional: GitHub CLI (`gh`) for pull-request metadata
- Optional: GitHub CLI authentication for repositories that require it

Check the optional integration with:

```bash
gh auth status
```

If needed, authenticate using `gh auth login`. The extension remains useful without `gh` or authentication; it displays local repository and branch data with `!`.

## Install and use

The canonical source is [github.com/10ego/pi-footer-display](https://github.com/10ego/pi-footer-display).

Try the package for one Pi run without changing settings:

```bash
pi -e https://github.com/10ego/pi-footer-display
```

Install it in your user settings:

```bash
pi install https://github.com/10ego/pi-footer-display
```

Use `--local` to install it in a trusted project's `.pi/settings.json` instead:

```bash
pi install https://github.com/10ego/pi-footer-display --local
```

Update the installed GitHub package later with:

```bash
pi update https://github.com/10ego/pi-footer-display
```

For local development, clone the repository, install dependencies, and load the TypeScript entry point for one run:

```bash
git clone https://github.com/10ego/pi-footer-display.git
cd pi-footer-display
npm install
pi --extension ./src/index.ts
```

`--extension` does not add the extension to Pi settings. This project is not currently published to npm, so use the GitHub source shown above rather than `npm:pi-footer-display`.

## Cache and subprocess behavior

Repository discovery, local snapshots, and pull-request results are deliberately bounded:

| Cache | Maximum entries | Successful result TTL | Negative/degraded result TTL |
| --- | ---: | ---: | ---: |
| Candidate path → Git root | 128 | 5 minutes | 30 seconds |
| Git root → rendered metadata snapshot | 32 | 60 seconds | 10 seconds |
| Exact GitHub repository + branch → PR/no PR | 32 | 60 seconds | 10-second error backoff |

Least-recently-used-ish entries are evicted when a cache exceeds its bound. Only confirmed repository and non-repository discovery results are cached; indeterminate Git, filesystem, realpath, and process failures are not. Recognized Git effects invalidate the affected local snapshot immediately. On a PR-cache miss, the new local branch is published first with `!` and no previous PR, then enriched only if the matching `gh` result is still current. A matching PR/no-PR result may be reused for the same repository and branch, while a changed repository or branch uses a different query key and cannot inherit the previous PR. Recognized `gh pr` mutations invalidate the affected query. `/pr-footer refresh` bypasses local and PR cache state so unobserved changes can be rechecked.

The once-per-second age redraw only reformats existing state. A clean `agent_settled` event also performs no Git, `gh`, or network work. Every `git` and `gh` operation is launched directly without a shell, has a 10-second timeout, and accepts at most 1 MiB of output. GitHub lookup uses an explicit target rather than ambient repository inference:

```bash
gh pr list --repo OWNER/REPO --head BRANCH --state open --limit 1 --json number,state,isDraft,url
```

Network access occurs only through `gh` when a recognized `github.com` remote and attached branch require a PR query. Startup, a confirmed automatic repository change, a branch/repository identity change, a recognized PR mutation, pinning, and explicit refresh can trigger that lookup when the exact query cache does not satisfy it.

## Graceful degradation

- **Detached HEAD:** shows the abbreviated commit prefixed with `@` and `!`; no PR lookup is attempted.
- **No open PR:** omits the PR segment without a warning marker.
- **Non-GitHub or unsupported remote:** uses the local directory name and branch with `!`; no PR lookup is attempted.
- **Missing `gh`, unauthenticated `gh`, timeout, malformed response, or network failure:** keeps local Git context and adds `!`.
- **Confirmed non-repository path:** unrelated automatic activity retains the last confirmed repository; a confirmed invalid restored pin may safely downgrade and fall back.
- **Missing or timed-out `git`, unsafe ownership, config/corruption, permission/realpath/process failure, or unreadable local identity:** shows unavailable or stale context rather than claiming the path is not a repository. Only Git's canonical no-repository diagnostic confirms an ordinary outside-repository path. A restored pin and its persisted fields survive such transient startup failures.
- **Repository root found but metadata unreadable:** shows `repo — · !` for that repository context and never silently leaves a previous repository displayed as current.
- **Ambiguous strongest-tier evidence:** shows the candidate count and `?`; use `pin` to choose explicitly.

## Security and privacy

Pi extensions execute with the user's full system permissions; review the source before installing any extension. This extension:

- observes tool names and path-shaped tool inputs for tracking, but does not read or transmit file contents itself;
- runs subprocesses with argument arrays and `shell: false`;
- reads local Git roots, refs, and remote URLs;
- sends the parsed `OWNER/REPO` and branch to the locally installed `gh` process for PR lookup;
- inherits the user's process environment and relies on `gh` for credentials and network transport;
- persists absolute selected repository roots, mode, and start time in Pi's session log;
- keeps repository and PR metadata caches in memory only and clears them on shutdown.

PR titles, bodies, comments, diffs, and file contents are never requested by the implementation.

## Troubleshooting

### The footer shows `repo — · !`

Confirm the path is in a Git worktree and Git can resolve it:

```bash
git -C /absolute/path rev-parse --show-toplevel
```

Then run `/pr-footer pin /absolute/path` or `/pr-footer refresh`.

### The repository is correct but `!` appears

Check whether HEAD is attached, whether a `github.com` remote exists, and whether `gh` is usable:

```bash
git symbolic-ref --quiet --short HEAD
git remote -v
gh auth status
```

Run the exact `gh pr list` form shown above with the displayed repository and branch to diagnose authentication or network errors.

### The wrong repository or `repo? N · ?` appears

Automatic tracking reflects the strongest recent tool-path evidence, including multiple paths in the debounce window. Pin the intended checkout:

```text
/pr-footer pin /absolute/path/to/repository
```

Use `/pr-footer unpin` when automatic switching is wanted again.

### The footer stays on the previous worktree after `/new`

`/new` starts a fresh Pi session but retains Pi's existing runtime working directory. The footer changes after a supported tool path or deterministic shell form identifies the other worktree. Check the current selection with `/pr-footer status`; when inference cannot observe the move, use `/pr-footer pin /absolute/path/to/worktree`.

An agent run ending is not a general polling trigger. `agent_settled` performs a local check only when a recognized Git-affecting command is still pending or previously failed to reconcile.

### PR data is old

Successful PR and no-PR results can remain cached for up to 60 seconds. Recognized branch/repository changes use a new query automatically, and recognized `gh pr` mutations invalidate the affected query. Run `/pr-footer refresh` to bypass caches immediately.

### Session age is larger than active work time

This is expected after resuming: age is persisted wall-clock session age and includes time when Pi was not running.

## Limitations

- Only `github.com` remotes with exactly `OWNER/REPO` paths are recognized; GitHub Enterprise and other forges receive local-only context.
- PR matching is branch-based and displays only the first open result returned by `gh --limit 1`.
- Automatic tracking intentionally recognizes only `read`, `write`, `edit`, `grep`, `find`, `ls`, and narrow deterministic bash forms; opaque custom tools, external filesystem activity, and complex shell commands do not influence selection.
- Pi currently has no authoritative dynamic-cwd event and `/new` cannot request another cwd, so arbitrary logical directory changes cannot be detected reliably by an extension.
- The footer shows repository, ref, optional PR number/draft state, degradation markers, and age only. It does not show PR title, checks, review state, or ahead/behind counts.
- Remote PR changes not caused by a recognized local command may remain cached for up to 60 seconds; use `/pr-footer refresh` when immediate freshness matters.

## Development

```bash
npm install          # install development dependencies
npm run typecheck    # TypeScript validation without emit
npm test             # typecheck, compile tests, run node:test, and clean test output
npm pack --dry-run   # inspect the npm package contents without publishing
git diff --check     # detect whitespace errors
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the state, refresh, and lifecycle design. Release maintainers should follow the fail-closed bootstrap and operating runbook in [RELEASING.md](RELEASING.md). Contributions and issue reports are welcome in the [GitHub repository](https://github.com/10ego/pi-footer-display).
