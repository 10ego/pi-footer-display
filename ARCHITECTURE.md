# Architecture

## Proposal

Add repository context through `ctx.ui.setStatus`; never replace Pi's native footer. Keep discovery conservative, user control explicit, and asynchronous updates safe across session changes.

## State model

Each session has a mode (`auto` or `pinned`) and a resolution outcome (`resolved`, `ambiguous`, `unavailable`, or `stale`). Versioned custom entries persist `startedAt`, mode, the pinned root, and the last confirmed root; the session header timestamp supplies age when no valid custom entry exists. Pin, unpin, and refresh commands are explicit state transitions; unpin returns to automatic discovery.

Repository discovery prioritizes paths observed in file tools. Only narrow, absolute-path hints from bash commands are accepted. The startup working directory is a weak fallback and must not override stronger evidence. Ambiguous evidence is shown as ambiguous rather than guessed.

## Refresh strategy

Keep separate bounded caches for path-to-repository resolution and repository metadata. Repository lookups use explicit targets such as `gh --repo OWNER/REPO`; they never depend on ambient GitHub CLI repository inference. A lightweight timer updates age text only and does not trigger network or repository discovery.

Every asynchronous refresh captures a generation and may publish only if that generation is still current. Refresh invalidates relevant cache entries; pin and unpin advance the generation before starting new work. Cleanup advances the generation, clears timers and the stable `pr-footer` status entry, and disposes cached session resources so late work cannot update the UI.

## Extension lifecycle

The extension factory only registers events and `/pr-footer`; it creates no subprocess-backed dependencies or timers. `session_start` validates restored roots before resolving metadata, using the startup working directory only when no restored root remains valid. File-tool paths and narrow absolute bash hints are collected into a debounce window, and automatic mode changes repository only after the strongest evidence tier resolves to one root. Pinned mode discards automatic evidence until explicitly unpinned.
