# Architecture

## Proposal

Add repository context through `ctx.ui.setStatus`; never replace Pi's native footer. Keep discovery conservative, user control explicit, updates event-driven, and asynchronous publication safe across session changes.

## State model

Each session has a mode (`auto` or `pinned`) and a resolution outcome (`resolved`, `ambiguous`, `no-repository`, `unavailable`, or `stale`). Repository discovery and restored-root validation separately return structured `repository`, `not-repository`, or `indeterminate` outcomes; transition code never infers those semantics from reason strings. Versioned custom entries persist `startedAt`, mode, the pinned root, and the last confirmed root. Pending path hints, tool effects, dirty sets, event sequences, and in-flight reconciliations are bounded or session-ephemeral and are discarded during cleanup.

Automatic discovery prioritizes paths observed in Pi's exact `read`, `write`, `edit`, `grep`, `find`, and `ls` file tools. Deterministic bash evidence is limited to one literal leading `cd <path> && ...`, direct `git -C <path> ...`, exact `git worktree add <destination> [<commit-ish>]`, and a small absolute-operand allowlist. Relative literals are anchored to the event's `ctx.cwd`, never to the currently displayed repository. Expansions, substitutions, globs, tilde expansion, redirects, pipelines, subshells, repeated directory changes, unsupported option shapes, and conflicting candidates are rejected. The startup cwd is a weak fallback and cannot override stronger evidence.

Only exit 128 paired with Git's canonical no-repository stderr diagnostic, or a truly missing/deleted restored path, is `not-repository`; unsafe ownership, config/corruption, missing Git, timeout, permission, realpath, and other process failures are `indeterminate`. Ambiguous strongest-tier roots are displayed rather than guessed. Pinned mode never changes roots from automatic evidence, but a recognized mutation touching the pinned root may refresh its fixed context.

## Event and reconciliation strategy

Ordinary path hints are resolved after a 100 ms debounce. A recognized Git/worktree/PR mutation is staged by tool-call id, lifecycle, and monotonic call sequence and is not treated as post-command truth until its matching `tool_result`. Every matching result is reconciled regardless of reported success because an earlier command in a chain may have produced a side effect before a later failure. Prospective worktree destinations are rediscovered after execution, and affected path and local-identity entries are invalidated before resolution.

Call-order watermarks, controller generations, lifecycle ids, path/metadata epochs, and identity-aware cache keys prevent late work from repopulating invalidated caches or replacing newer displayed context. Equally strong concurrent roots remain ambiguous. Pin, unpin, and refresh advance a sequence/generation barrier; tool results wait for an active pin transition before reconciling. `agent_settled` waits for active reconciliation and performs at most one final local pass only when recognized dirty or pending effects remain. It is not a general polling hook.

## Cache strategy

Keep three bounded layers:

1. candidate path to structured repository discovery (128 entries; five-minute positive and 30-second confirmed-negative TTLs);
2. canonical root to rendered local/PR snapshot (32 entries; 60-second positive and 10-second degraded TTLs), invalidated by recognized local Git effects;
3. exact supported GitHub query identity—`github.com`, normalized owner/repository, and case-sensitive branch—to PR or confirmed no-PR result (32 entries; 60-second success TTL and 10-second error backoff).

A local invalidation rereads identity but may reuse PR data only when the resulting query identity is unchanged. On a query miss, a generation-guarded callback publishes the new local identity with a pending/degraded marker and no old PR before the network request completes; the final PR/no-PR result may enrich it only while the same generation and sequence remain current. Branch, remote, or repository changes select another key, so the prior PR cannot attach to the new identity. Recognized `gh pr` mutations invalidate the last exact query for the affected root. Explicit refresh clears local identity and bounded PR state to cover changes the extension could not observe. Indeterminate discovery is never cached. Repository lookups always use explicit targets such as `gh --repo OWNER/REPO`; they never depend on ambient GitHub CLI inference.

The once-per-second age timer only reformats existing state. It performs no filesystem discovery, Git subprocess, `gh` call, or network request.

## Extension lifecycle and upstream boundary

The extension factory only registers events and `/pr-footer`; it creates no subprocess-backed dependencies or timers. `session_start` restores mode, roots, and `startedAt`, creates dependencies, revalidates persisted roots, and resolves the selected root or startup cwd. An indeterminate restored-root failure preserves pinned intent and publishes stale/unavailable status; a confirmed invalid pin may downgrade safely. `session_shutdown` advances lifecycle state, releases transition waiters, clears timers, hints, effects, caches, and the named status, and prevents late work from publishing. Persistence and status UI failures remain contained.

Pi 0.80.7 through 0.80.10 bind `ctx.cwd` to the session runtime, reuse that cwd for `/new`, expose no `cwd_changed` extension event, and offer no `newSession({ cwd })` option. Therefore the extension can follow only observable path/tool evidence; it cannot reliably infer arbitrary shell state, opaque custom-tool cwd changes, or external directory changes. A future authoritative cwd event should outrank heuristic evidence. Until then, explicit pin and refresh remain the reliable escape hatches, and neither timer polling nor `fs.watch` is used.
