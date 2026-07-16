import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { ContextCore, DefaultRepositoryMetadataLoader } from "./context.js";
import { formatFooter } from "./format.js";
import {
  GitRepositoryInspector,
  type RepositoryDiscoveryOutcome,
  type RepositoryInspector,
} from "./git.js";
import { GhPullRequestLookup } from "./github.js";
import { extractBashPaths, extractFileToolPaths, fallbackPath } from "./paths.js";
import { ExecFileRunner } from "./process.js";
import { FooterSessionController } from "./state.js";
import type { PathHint, ResolutionOutcome, SessionMode } from "./types.js";

export const FOOTER_STATUS_KEY = "pr-footer";
export const FOOTER_STATE_ENTRY = "pr-footer-state";
export const FOOTER_STATE_VERSION = 1;

const COMMAND_HELP =
  "Usage: /pr-footer [status|help|pin <path>|unpin|refresh]";

export interface PersistedFooterState {
  readonly version: typeof FOOTER_STATE_VERSION;
  readonly startedAt: number;
  readonly mode: SessionMode;
  readonly pinnedRoot?: string;
  readonly lastConfirmedRoot?: string;
}

export interface FooterDependencies {
  readonly repositories: RepositoryInspector;
  readonly core: ContextCore;
}

export interface FooterExtensionOptions {
  readonly createDependencies?: () => FooterDependencies;
  readonly debounceMs?: number;
  readonly ageIntervalMs?: number;
  readonly now?: () => number;
}

function createDefaultDependencies(): FooterDependencies {
  const runner = new ExecFileRunner();
  const repositories = new GitRepositoryInspector(runner);
  const metadata = new DefaultRepositoryMetadataLoader(
    repositories,
    new GhPullRequestLookup(runner),
  );
  return { repositories, core: new ContextCore({ repositories, metadata }) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function absolutePath(value: unknown): value is string {
  return typeof value === "string" && path.isAbsolute(value);
}

export function parsePersistedFooterState(
  value: unknown,
): PersistedFooterState | undefined {
  if (!isRecord(value) || value.version !== FOOTER_STATE_VERSION) return undefined;
  if (!validTimestamp(value.startedAt)) return undefined;
  if (value.mode !== "auto" && value.mode !== "pinned") return undefined;
  if (value.pinnedRoot !== undefined && !absolutePath(value.pinnedRoot)) return undefined;
  if (
    value.lastConfirmedRoot !== undefined &&
    !absolutePath(value.lastConfirmedRoot)
  ) {
    return undefined;
  }
  if (value.mode === "pinned" && !absolutePath(value.pinnedRoot)) return undefined;

  return {
    version: FOOTER_STATE_VERSION,
    startedAt: value.startedAt,
    mode: value.mode,
    ...(value.mode === "pinned" && value.pinnedRoot
      ? { pinnedRoot: value.pinnedRoot }
      : {}),
    ...(value.lastConfirmedRoot
      ? { lastConfirmedRoot: value.lastConfirmedRoot }
      : {}),
  };
}

interface RestoredFooterState {
  readonly state: PersistedFooterState;
  readonly fromEntry: boolean;
}

function persistedStateFromContext(
  ctx: ExtensionContext,
  now: () => number,
): RestoredFooterState {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (
      entry?.type === "custom" &&
      entry.customType === FOOTER_STATE_ENTRY
    ) {
      const restored = parsePersistedFooterState(entry.data);
      if (restored) return { state: restored, fromEntry: true };
    }
  }

  const headerTime = Date.parse(ctx.sessionManager.getHeader()?.timestamp ?? "");
  return {
    state: {
      version: FOOTER_STATE_VERSION,
      startedAt: Number.isFinite(headerTime) && headerTime > 0 ? headerTime : now(),
      mode: "auto",
    },
    fromEntry: false,
  };
}

function unavailable(error: unknown): ResolutionOutcome {
  return {
    kind: "unavailable",
    reason: error instanceof Error ? error.message : "repository lookup failed",
  };
}

function sameSnapshot(
  left: PersistedFooterState | undefined,
  right: PersistedFooterState,
): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

/** Session-scoped integration around the repository context core. */
export class FooterExtensionRuntime {
  readonly #pi: ExtensionAPI;
  readonly #createDependencies: () => FooterDependencies;
  readonly #debounceMs: number;
  readonly #ageIntervalMs: number;
  readonly #now: () => number;

  #dependencies: FooterDependencies | undefined;
  #controller: FooterSessionController | undefined;
  #ctx: ExtensionContext | undefined;
  #startupCwd: string | undefined;
  #lastConfirmedRoot: string | undefined;
  #lastPersisted: PersistedFooterState | undefined;
  #ageTimer: ReturnType<typeof setInterval> | undefined;
  #debounceTimer: ReturnType<typeof setTimeout> | undefined;
  #pendingHints = new Map<string, PathHint>();
  #lifecycle = 0;
  #disposed = true;
  #transitionCount = 0;

  constructor(pi: ExtensionAPI, options: FooterExtensionOptions = {}) {
    this.#pi = pi;
    this.#createDependencies =
      options.createDependencies ?? createDefaultDependencies;
    this.#debounceMs = options.debounceMs ?? 100;
    this.#ageIntervalMs = options.ageIntervalMs ?? 1_000;
    this.#now = options.now ?? Date.now;
  }

  register(): void {
    this.#pi.on("session_start", async (_event, ctx) => {
      await this.start(ctx);
    });
    this.#pi.on("session_shutdown", (_event, ctx) => {
      this.shutdown(ctx);
    });
    this.#pi.on("tool_call", (event, ctx) => {
      this.observeToolCall(event, ctx);
    });
    this.#pi.registerCommand("pr-footer", {
      description: "Show or control repository footer context",
      handler: async (args, ctx) => {
        await this.handleCommand(args, ctx);
      },
    });
  }

  async start(ctx: ExtensionContext): Promise<void> {
    this.#cleanup();
    const lifecycle = this.#lifecycle;
    this.#disposed = false;
    this.#ctx = ctx;
    this.#startupCwd = ctx.cwd;

    const restoration = persistedStateFromContext(ctx, this.#now);
    const restored = restoration.state;
    this.#lastPersisted = restoration.fromEntry ? restored : undefined;
    this.#controller = new FooterSessionController(restored.startedAt);
    this.#lastConfirmedRoot = restored.lastConfirmedRoot;
    if (restored.mode === "pinned" && restored.pinnedRoot) {
      this.#controller.pin(restored.pinnedRoot);
    }

    this.#ageTimer = setInterval(() => {
      if (this.#active(lifecycle)) this.#publish();
    }, this.#ageIntervalMs);

    try {
      this.#dependencies = this.#createDependencies();
    } catch (error) {
      const reason = error instanceof Error ? error.message : "dependency creation failed";
      const generation = this.#controller.beginRefresh();
      this.#controller.commit(
        generation,
        restored.pinnedRoot || restored.lastConfirmedRoot
          ? { kind: "stale", reason }
          : unavailable(error),
      );
      this.#publish();
      this.#persistIfChanged();
      return;
    }

    const validations = new Map<string, Promise<RepositoryDiscoveryOutcome>>();
    const validateRestored = (root: string): Promise<RepositoryDiscoveryOutcome> => {
      const pending = validations.get(root) ?? this.#validateRoot(root, true);
      validations.set(root, pending);
      return pending;
    };
    const [pinnedValidation, lastConfirmedValidation] = await Promise.all([
      restored.mode === "pinned" && restored.pinnedRoot
        ? validateRestored(restored.pinnedRoot)
        : undefined,
      restored.lastConfirmedRoot
        ? validateRestored(restored.lastConfirmedRoot)
        : undefined,
    ]);
    if (!this.#active(lifecycle)) return;

    const indeterminateValidation =
      pinnedValidation?.kind === "indeterminate"
        ? pinnedValidation
        : lastConfirmedValidation?.kind === "indeterminate"
          ? lastConfirmedValidation
          : undefined;
    if (indeterminateValidation) {
      this.#publishRestorationFailure(indeterminateValidation.reason);
      return;
    }

    let selectedRoot: string | undefined;
    if (pinnedValidation?.kind === "repository") {
      selectedRoot = pinnedValidation.root;
      this.#controller.pin(selectedRoot);
    } else if (restored.mode === "pinned") {
      this.#controller.unpin();
    }

    if (lastConfirmedValidation?.kind === "repository") {
      this.#lastConfirmedRoot = lastConfirmedValidation.root;
    } else if (lastConfirmedValidation?.kind === "not-repository") {
      this.#lastConfirmedRoot = undefined;
    }

    selectedRoot ??= this.#lastConfirmedRoot;
    const hints = selectedRoot
      ? [{ path: selectedRoot, source: "file" as const }]
      : [fallbackPath(this.#startupCwd)];
    await this.#resolveAndPublish(hints, lifecycle);
  }

  shutdown(_ctx?: ExtensionContext): void {
    this.#cleanup();
  }

  observeToolCall(event: ToolCallEvent, ctx: ExtensionContext): void {
    if (
      this.#disposed ||
      this.#transitionCount > 0 ||
      this.#controller?.state.mode !== "auto"
    ) {
      return;
    }

    const hints = extractFileToolPaths(event.toolName, event.input, ctx.cwd);
    const command = recordValue(event.input, "command");
    if (event.toolName === "bash" && typeof command === "string") {
      hints.push(...extractBashPaths(command));
    }
    if (hints.length === 0) return;

    for (const hint of hints) {
      this.#pendingHints.set(`${hint.source}\0${hint.path}`, hint);
    }
    if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
    const lifecycle = this.#lifecycle;
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = undefined;
      void this.#flushObservedHints(lifecycle);
    }, this.#debounceMs);
  }

  async handleCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const trimmed = args.trim();
    const separator = trimmed.search(/\s/u);
    const command = (separator === -1 ? trimmed : trimmed.slice(0, separator)).toLowerCase();
    const remainder = separator === -1 ? "" : trimmed.slice(separator).trim();

    if (!command) {
      this.#notifyStatus(ctx);
      ctx.ui.notify(COMMAND_HELP, "info");
      return;
    }

    switch (command) {
      case "status":
        this.#notifyStatus(ctx);
        return;
      case "help":
        ctx.ui.notify(COMMAND_HELP, "info");
        return;
      case "pin":
        await this.#pin(remainder, ctx);
        return;
      case "unpin":
        await this.#unpin(ctx);
        return;
      case "refresh":
        await this.#refresh(ctx);
        return;
      default:
        ctx.ui.notify(`Unknown pr-footer subcommand. ${COMMAND_HELP}`, "error");
    }
  }

  async #pin(value: string, ctx: ExtensionCommandContext): Promise<void> {
    if (!this.#ready(ctx)) return;
    if (!value) {
      ctx.ui.notify("pin requires a path", "error");
      return;
    }

    const candidate = path.resolve(ctx.cwd, value);
    const lifecycle = this.#lifecycle;
    const controller = this.#controller;
    if (!controller) return;
    const guardGeneration = controller.beginRefresh();
    this.#transitionCount += 1;
    this.#clearPendingHints();

    try {
      const validation = await this.#validateRoot(candidate);
      if (!this.#active(lifecycle) || controller.state.generation !== guardGeneration) return;
      if (validation.kind === "not-repository") {
        ctx.ui.notify(`Not a git repository: ${candidate}`, "error");
        return;
      }
      if (validation.kind === "indeterminate") {
        ctx.ui.notify(`Unable to validate repository: ${candidate}`, "error");
        return;
      }
      const root = validation.root;

      this.#dependencies?.core.invalidatePath(candidate);
      this.#dependencies?.core.invalidatePath(root);
      this.#dependencies?.core.invalidateRepository(root);
      const outcome = await this.#safeResolve([
        { path: root, source: "file" },
      ]);
      if (!this.#active(lifecycle) || controller.state.generation !== guardGeneration) return;

      const generation = controller.pin(root);
      controller.commit(generation, outcome);
      if (outcome.kind === "resolved") {
        this.#lastConfirmedRoot = outcome.metadata.root;
      }
      this.#publish();
      this.#persistIfChanged();
      ctx.ui.notify(`Pinned repository: ${root}`, "info");
    } finally {
      if (this.#active(lifecycle)) {
        this.#transitionCount = Math.max(0, this.#transitionCount - 1);
      }
    }
  }

  async #unpin(ctx: ExtensionCommandContext): Promise<void> {
    if (!this.#ready(ctx)) return;
    const controller = this.#controller;
    if (!controller) return;
    if (controller.state.mode === "auto") {
      ctx.ui.notify("Repository selection is already automatic", "info");
      return;
    }

    controller.unpin();
    this.#persistIfChanged();
    ctx.ui.notify("Repository selection is automatic", "info");
    const lifecycle = this.#lifecycle;
    const root = this.#lastConfirmedRoot;
    await this.#resolveAndPublish(
      root
        ? [{ path: root, source: "file" }]
        : [fallbackPath(this.#startupCwd ?? ctx.cwd)],
      lifecycle,
    );
  }

  async #refresh(ctx: ExtensionCommandContext): Promise<void> {
    if (!this.#ready(ctx)) return;
    const controller = this.#controller;
    const root =
      controller?.state.pinnedRoot ??
      this.#outcomeRoot(controller?.state.outcome) ??
      this.#lastConfirmedRoot;
    if (root) {
      this.#dependencies?.core.invalidatePath(root);
      this.#dependencies?.core.invalidateRepository(root);
    }
    await this.#resolveAndPublish(
      root
        ? [{ path: root, source: "file" }]
        : [fallbackPath(this.#startupCwd ?? ctx.cwd)],
      this.#lifecycle,
    );
    if (!this.#disposed) ctx.ui.notify("Repository footer refreshed", "info");
  }

  async #flushObservedHints(lifecycle: number): Promise<void> {
    if (
      !this.#active(lifecycle) ||
      this.#transitionCount > 0 ||
      this.#controller?.state.mode !== "auto"
    ) {
      this.#pendingHints.clear();
      return;
    }
    const hints = [...this.#pendingHints.values()];
    this.#pendingHints.clear();
    if (hints.length === 0) return;

    const controller = this.#controller;
    if (!controller) return;
    const generation = controller.beginRefresh();
    const outcome = await this.#safeResolve(hints);
    if (!this.#active(lifecycle) || controller.state.mode !== "auto") return;
    // Confirmed unrelated non-repository activity is not evidence to discard a root.
    if (outcome.kind === "no-repository" && this.#lastConfirmedRoot) return;
    this.#commitOutcome(outcome, lifecycle, generation);
  }

  async #resolveAndPublish(
    hints: readonly PathHint[],
    lifecycle: number,
  ): Promise<void> {
    const controller = this.#controller;
    if (!controller || !this.#active(lifecycle)) return;
    const generation = controller.beginRefresh();
    const outcome = await this.#safeResolve(hints);
    if (!this.#active(lifecycle)) return;
    this.#commitOutcome(outcome, lifecycle, generation);
  }

  #commitOutcome(
    outcome: ResolutionOutcome,
    lifecycle: number,
    generation = this.#controller?.beginRefresh(),
  ): void {
    const controller = this.#controller;
    if (
      !controller ||
      generation === undefined ||
      !this.#active(lifecycle) ||
      !controller.commit(generation, outcome)
    ) {
      return;
    }
    if (outcome.kind === "resolved") {
      this.#lastConfirmedRoot = outcome.metadata.root;
    }
    this.#publish();
    this.#persistIfChanged();
  }

  async #safeResolve(hints: readonly PathHint[]): Promise<ResolutionOutcome> {
    try {
      return this.#dependencies
        ? await this.#dependencies.core.resolve(hints)
        : { kind: "unavailable", reason: "footer is not initialized" };
    } catch (error) {
      return unavailable(error);
    }
  }

  async #validateRoot(
    candidate: string,
    restoredRoot = false,
  ): Promise<RepositoryDiscoveryOutcome> {
    try {
      const repositories = this.#dependencies?.repositories;
      if (!repositories) {
        return { kind: "indeterminate", reason: "footer is not initialized" };
      }
      const outcome = restoredRoot
        ? await repositories.validateRoot(candidate)
        : await repositories.findRoot(candidate);
      if (outcome.kind === "repository" && !path.isAbsolute(outcome.root)) {
        return { kind: "indeterminate", reason: "git returned a non-absolute repository root" };
      }
      return outcome;
    } catch (error) {
      return {
        kind: "indeterminate",
        reason: error instanceof Error ? error.message : "repository validation failed",
      };
    }
  }

  #publishRestorationFailure(reason: string): void {
    const controller = this.#controller;
    if (!controller) return;
    const generation = controller.beginRefresh();
    controller.commit(generation, { kind: "stale", reason });
    this.#publish();
    this.#persistIfChanged();
  }

  #outcomeRoot(outcome: ResolutionOutcome | undefined): string | undefined {
    if (outcome?.kind === "resolved") return outcome.metadata.root;
    if (outcome?.kind === "unavailable") return outcome.root;
    return undefined;
  }

  #snapshot(): PersistedFooterState | undefined {
    const state = this.#controller?.state;
    if (!state) return undefined;
    return {
      version: FOOTER_STATE_VERSION,
      startedAt: state.startedAt,
      mode: state.mode,
      ...(state.mode === "pinned" && state.pinnedRoot
        ? { pinnedRoot: state.pinnedRoot }
        : {}),
      ...(this.#lastConfirmedRoot
        ? { lastConfirmedRoot: this.#lastConfirmedRoot }
        : {}),
    };
  }

  #persistIfChanged(): void {
    if (this.#disposed) return;
    const snapshot = this.#snapshot();
    if (!snapshot || sameSnapshot(this.#lastPersisted, snapshot)) return;
    try {
      this.#pi.appendEntry(FOOTER_STATE_ENTRY, snapshot);
      this.#lastPersisted = snapshot;
    } catch {
      // Persistence failure must not break tool calls, timers, or session startup.
    }
  }

  #publish(): void {
    const state = this.#controller?.state;
    if (!state || this.#disposed) return;
    try {
      this.#ctx?.ui.setStatus(FOOTER_STATUS_KEY, formatFooter(state, this.#now()));
    } catch {
      // A stale or unavailable UI during replacement must not escape a timer callback.
    }
  }

  #notifyStatus(ctx: ExtensionCommandContext): void {
    const state = this.#controller?.state;
    if (!state || this.#disposed) {
      ctx.ui.notify("Repository footer is not initialized", "warning");
      return;
    }
    const root =
      state.pinnedRoot ?? this.#outcomeRoot(state.outcome) ?? this.#lastConfirmedRoot;
    ctx.ui.notify(
      `${formatFooter(state, this.#now())} · mode ${state.mode}${root ? ` · ${root}` : ""}`,
      "info",
    );
  }

  #ready(ctx: ExtensionCommandContext): boolean {
    if (!this.#disposed && this.#controller && this.#dependencies) return true;
    ctx.ui.notify("Repository footer is not initialized", "warning");
    return false;
  }

  #active(lifecycle: number): boolean {
    return !this.#disposed && lifecycle === this.#lifecycle;
  }

  #clearPendingHints(): void {
    if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
    this.#debounceTimer = undefined;
    this.#pendingHints.clear();
  }

  #cleanup(): void {
    this.#lifecycle += 1;
    this.#disposed = true;
    this.#transitionCount = 0;
    if (this.#ageTimer) clearInterval(this.#ageTimer);
    this.#ageTimer = undefined;
    this.#clearPendingHints();
    this.#controller?.cleanup();
    this.#dependencies?.core.clear();
    try {
      this.#ctx?.ui.setStatus(FOOTER_STATUS_KEY, undefined);
    } catch {
      // The previous Pi context may already be stale during a reload/replacement.
    }
    this.#dependencies = undefined;
    this.#controller = undefined;
    this.#ctx = undefined;
    this.#startupCwd = undefined;
    this.#lastConfirmedRoot = undefined;
    this.#lastPersisted = undefined;
  }
}

export function registerFooterDisplay(
  pi: ExtensionAPI,
  options: FooterExtensionOptions = {},
): FooterExtensionRuntime {
  const runtime = new FooterExtensionRuntime(pi, options);
  runtime.register();
  return runtime;
}
