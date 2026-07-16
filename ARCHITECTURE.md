# Architecture

## Proposal

Add repository context through `ctx.ui.setStatus`; never replace Pi's native footer. Keep discovery conservative, user control explicit, and asynchronous updates safe across session changes.

## State model

Each session has a mode (`auto` or `pinned`) and a resolution outcome (`resolved`, `ambiguous`, `no-repository`, `unavailable`, or `stale`). Repository discovery and restored-root validation separately return structured `repository`, `not-repository`, or `indeterminate` outcomes; transition code never infers those semantics from reason strings. Versioned custom entries persist `startedAt`, mode, the pinned root, and the last confirmed root; the session header timestamp supplies age when no valid custom entry exists. Pin, unpin, and refresh commands are explicit state transitions; unpin returns to automatic discovery.

Repository discovery prioritizes paths observed in Pi's `read`, `write`, `edit`, `grep`, `find`, and `ls` file tools. Only narrow, absolute-path hints from bash commands are accepted. The startup working directory is a weak fallback and must not override stronger evidence. Ambiguous evidence is shown as ambiguous rather than guessed. Only a trustworthy Git no-repository exit or a truly missing/deleted restored path is `not-repository`; missing Git, timeout, permission, realpath, and other process failures are `indeterminate`.

## Refresh strategy

Keep separate bounded caches for path-to-repository resolution and repository metadata. Cache confirmed repository and non-repository discovery, but never cache indeterminate failures. Degraded metadata (detached HEAD, no recognized GitHub remote, or failed GitHub lookup) has the shorter negative TTL, while a successful lookup that finds no open PR remains positive. Repository lookups use explicit targets such as `gh --repo OWNER/REPO`; they never depend on ambient GitHub CLI repository inference. A lightweight timer updates age text only and does not trigger network or repository discovery.

Every asynchronous refresh captures a generation and may publish only if that generation is still current. Refresh invalidates relevant cache entries; pin and unpin advance the generation before starting new work. Cleanup advances the generation, clears timers and the stable `pr-footer` status entry, and disposes cached session resources so late work cannot update the UI.

## Extension lifecycle

The extension factory only registers events and `/pr-footer`; it creates no subprocess-backed dependencies or timers. `session_start` restores mode, roots, and `startedAt` before creating dependencies, then revalidates persisted roots. Indeterminate validation preserves `mode=pinned`, `pinnedRoot`, `lastConfirmedRoot`, and `startedAt`, publishes stale/unavailable status, and never persists a downgrade; a confirmed deleted/non-repository pin may downgrade and use a validated last-confirmed root or startup working directory. File-tool paths and narrow absolute bash hints are collected into a debounce window, and automatic mode changes repository only after the strongest evidence tier resolves to one root. Confirmed unrelated non-repository activity may retain repository A, while a root for repository B followed by metadata failure publishes unavailable B context and cannot silently leave A displayed. Concurrent pin transitions keep automatic evidence blocked until every transition settles. Persistence and named-status UI failures are contained so they cannot escape startup, timer callbacks, or cleanup. Pinned mode discards automatic evidence until explicitly unpinned.
