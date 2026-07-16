# Architecture

## Proposal

Add repository context through `ctx.ui.setStatus`; never replace Pi's native footer. Keep discovery conservative, user control explicit, and asynchronous updates safe across session changes.

## State model

Each session has a mode (`auto` or `pinned`) and a resolution outcome (`resolved`, `ambiguous`, `unavailable`, or `stale`). Persist `startedAt` and ownership state so resumed sessions retain age and attribution. Pin, unpin, and refresh commands are explicit state transitions; unpin returns to automatic discovery.

Repository discovery prioritizes paths observed in file tools. Only narrow, absolute-path hints from bash commands are accepted. The startup working directory is a weak fallback and must not override stronger evidence. Ambiguous evidence is shown as ambiguous rather than guessed.

## Refresh strategy

Keep separate bounded caches for path-to-repository resolution and repository metadata. Repository lookups use explicit targets such as `gh --repo OWNER/REPO`; they never depend on ambient GitHub CLI repository inference. A lightweight timer updates age text only and does not trigger network or repository discovery.

Every asynchronous refresh captures a generation and may publish only if that generation is still current. Refresh invalidates relevant cache entries; pin and unpin advance the generation before starting new work. Cleanup advances the generation, clears timers and owned status entries, and unregisters extension resources so late work cannot update the UI.
