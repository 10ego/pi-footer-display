import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { ContextCore, type RepositoryMetadataLoader } from "../src/context.js";
import {
  FOOTER_STATE_ENTRY,
  FOOTER_STATUS_KEY,
  parsePersistedFooterState,
  registerFooterDisplay,
  type FooterDependencies,
  type PersistedFooterState,
} from "../src/extension.js";
import type {
  RepositoryDiscoveryOutcome,
  RepositoryInspector,
} from "../src/git.js";
import type { RepositoryMetadata } from "../src/types.js";

interface Harness {
  readonly pi: ExtensionAPI;
  readonly appended: Array<{ type: string; data: unknown }>;
  readonly notifications: Array<{ message: string; type: string | undefined }>;
  readonly statuses: Array<{ key: string; text: string | undefined }>;
}

function createHarness(): Harness {
  const appended: Array<{ type: string; data: unknown }> = [];
  const notifications: Array<{ message: string; type: string | undefined }> = [];
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  const pi = {
    on() {},
    registerCommand() {},
    appendEntry(type: string, data: unknown) {
      appended.push({ type, data });
    },
  } as unknown as ExtensionAPI;
  return { pi, appended, notifications, statuses };
}

function discovery(root: string | null): RepositoryDiscoveryOutcome {
  return root ? { kind: "repository", root } : { kind: "not-repository" };
}

function metadata(root: string): RepositoryMetadata {
  return {
    root,
    name: root.slice(root.lastIndexOf("/") + 1),
    ref: { name: "main", detached: false },
    github: { owner: "acme", repo: root.slice(root.lastIndexOf("/") + 1) },
    degraded: [],
  };
}

function dependencies(
  loadCounts = new Map<string, number>(),
): FooterDependencies {
  const repositories: RepositoryInspector = {
    async findRoot(candidate) {
      for (const root of ["/repo/a", "/repo/b", "/repo/c"]) {
        if (candidate === root || candidate.startsWith(`${root}/`)) return discovery(root);
      }
      return discovery(null);
    },
    async validateRoot(candidate) {
      return await this.findRoot(candidate);
    },
    async readIdentity(root) {
      return metadata(root);
    },
  };
  const loader: RepositoryMetadataLoader = {
    async load(root) {
      loadCounts.set(root, (loadCounts.get(root) ?? 0) + 1);
      return { metadata: metadata(root), polarity: "positive" };
    },
  };
  return { repositories, core: new ContextCore({ repositories, metadata: loader }) };
}

function context(
  harness: Harness,
  options: {
    cwd?: string;
    timestamp?: string;
    states?: readonly PersistedFooterState[];
  } = {},
): ExtensionContext & ExtensionCommandContext {
  const states = options.states ?? [];
  return {
    cwd: options.cwd ?? "/repo/a",
    ui: {
      setStatus(key: string, text: string | undefined) {
        harness.statuses.push({ key, text });
      },
      notify(message: string, type?: string) {
        harness.notifications.push({ message, type });
      },
    },
    sessionManager: {
      getBranch() {
        return states.map((state, index) => ({
          type: "custom" as const,
          id: String(index),
          parentId: index === 0 ? null : String(index - 1),
          timestamp: new Date(state.startedAt).toISOString(),
          customType: FOOTER_STATE_ENTRY,
          data: state,
        }));
      },
      getHeader() {
        return {
          type: "session" as const,
          id: "session",
          timestamp: options.timestamp ?? "1970-01-01T00:00:01.000Z",
          cwd: options.cwd ?? "/repo/a",
        };
      },
    },
  } as unknown as ExtensionContext & ExtensionCommandContext;
}

function readCall(path: string): ToolCallEvent {
  return {
    type: "tool_call",
    toolCallId: path,
    toolName: "read",
    input: { path },
  };
}

function pathToolCall(toolName: "grep" | "find" | "ls", path: string): ToolCallEvent {
  return {
    type: "tool_call",
    toolCallId: `${toolName}:${path}`,
    toolName,
    input: { path, pattern: "needle" },
  } as ToolCallEvent;
}

function bashCall(command: string): ToolCallEvent {
  return {
    type: "tool_call",
    toolCallId: command,
    toolName: "bash",
    input: { command },
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("factory registration starts no dependencies and restores pinned state", async () => {
  const harness = createHarness();
  let creations = 0;
  const runtime = registerFooterDisplay(harness.pi, {
    createDependencies() {
      creations += 1;
      return dependencies();
    },
    ageIntervalMs: 60_000,
    now: () => 61_000,
  });
  assert.equal(creations, 0);

  const restored: PersistedFooterState = {
    version: 1,
    startedAt: 1_000,
    mode: "pinned",
    pinnedRoot: "/repo/b",
    lastConfirmedRoot: "/repo/b",
  };
  const ctx = context(harness, { states: [restored] });
  await runtime.start(ctx);

  assert.equal(creations, 1);
  assert.match(harness.statuses.at(-1)?.text ?? "", /^📌 acme\/b · main · 1m$/u);
  assert.deepEqual(harness.appended, []);

  runtime.shutdown(ctx);
  assert.deepEqual(harness.statuses.at(-1), {
    key: FOOTER_STATUS_KEY,
    text: undefined,
  });
});

test("persisted pin survives transient startup validation failure with stale display", async () => {
  const harness = createHarness();
  const repositories: RepositoryInspector = {
    async findRoot() {
      return { kind: "indeterminate", reason: "git timed out" };
    },
    async validateRoot() {
      return { kind: "indeterminate", reason: "git timed out" };
    },
    async readIdentity(root) {
      return metadata(root);
    },
  };
  const runtime = registerFooterDisplay(harness.pi, {
    createDependencies: () => ({
      repositories,
      core: new ContextCore({
        repositories,
        metadata: {
          async load(root) {
            return { metadata: metadata(root), polarity: "positive" };
          },
        },
      }),
    }),
    ageIntervalMs: 60_000,
    now: () => 61_000,
  });
  const restored: PersistedFooterState = {
    version: 1,
    startedAt: 1_000,
    mode: "pinned",
    pinnedRoot: "/repo/b",
    lastConfirmedRoot: "/repo/a",
  };
  const ctx = context(harness, { cwd: "/repo/c", states: [restored] });

  await runtime.start(ctx);

  assert.match(harness.statuses.at(-1)?.text ?? "", /^📌 repo — · ~ · 1m$/u);
  await runtime.handleCommand("status", ctx);
  assert.match(
    harness.notifications.at(-1)?.message ?? "",
    /mode pinned · \/repo\/b$/u,
  );
  assert.deepEqual(harness.appended, []);
  runtime.shutdown(ctx);
});

test("confirmed non-repository restored pin downgrades to validated fallback", async () => {
  const harness = createHarness();
  const runtime = registerFooterDisplay(harness.pi, {
    createDependencies: dependencies,
    ageIntervalMs: 60_000,
    now: () => 61_000,
  });
  const restored: PersistedFooterState = {
    version: 1,
    startedAt: 1_000,
    mode: "pinned",
    pinnedRoot: "/missing",
    lastConfirmedRoot: "/repo/c",
  };
  const ctx = context(harness, { cwd: "/repo/a", states: [restored] });
  await runtime.start(ctx);

  assert.match(harness.statuses.at(-1)?.text ?? "", /^acme\/c · main/u);
  assert.deepEqual(harness.appended.at(-1), {
    type: FOOTER_STATE_ENTRY,
    data: {
      version: 1,
      startedAt: 1_000,
      mode: "auto",
      lastConfirmedRoot: "/repo/c",
    },
  });

  runtime.shutdown(ctx);
});

test("deleted restored pin is confirmed invalid and safely downgrades to cwd", async () => {
  const harness = createHarness();
  const seenValidations: string[] = [];
  const repositories: RepositoryInspector = {
    async findRoot(candidate) {
      return discovery(candidate === "/repo/a" ? "/repo/a" : null);
    },
    async validateRoot(candidate) {
      seenValidations.push(candidate);
      return candidate === "/deleted/pin"
        ? { kind: "not-repository" }
        : discovery(candidate);
    },
    async readIdentity(root) {
      return metadata(root);
    },
  };
  const runtime = registerFooterDisplay(harness.pi, {
    createDependencies: () => ({
      repositories,
      core: new ContextCore({
        repositories,
        metadata: {
          async load(root) {
            return { metadata: metadata(root), polarity: "positive" };
          },
        },
      }),
    }),
    ageIntervalMs: 60_000,
  });
  const restored: PersistedFooterState = {
    version: 1,
    startedAt: 1_000,
    mode: "pinned",
    pinnedRoot: "/deleted/pin",
  };

  await runtime.start(context(harness, { cwd: "/repo/a", states: [restored] }));

  assert.deepEqual(seenValidations, ["/deleted/pin"]);
  assert.match(harness.statuses.at(-1)?.text ?? "", /^acme\/a/u);
  assert.deepEqual(harness.appended.at(-1)?.data, {
    version: 1,
    startedAt: 1_000,
    mode: "auto",
    lastConfirmedRoot: "/repo/a",
  });
  runtime.shutdown();
});

test("repo metadata failure replaces prior automatic repo instead of displaying it", async () => {
  const harness = createHarness();
  const repositories: RepositoryInspector = {
    async findRoot(candidate) {
      for (const root of ["/repo/a", "/repo/b"]) {
        if (candidate === root || candidate.startsWith(`${root}/`)) return discovery(root);
      }
      return discovery(null);
    },
    async validateRoot(candidate) {
      return await this.findRoot(candidate);
    },
    async readIdentity(root) {
      return metadata(root);
    },
  };
  const runtime = registerFooterDisplay(harness.pi, {
    createDependencies: () => ({
      repositories,
      core: new ContextCore({
        repositories,
        metadata: {
          async load(root) {
            if (root === "/repo/b") throw new Error("repository metadata unavailable");
            return { metadata: metadata(root), polarity: "positive" };
          },
        },
      }),
    }),
    debounceMs: 5,
    ageIntervalMs: 60_000,
  });
  const ctx = context(harness, { cwd: "/repo/a" });
  await runtime.start(ctx);
  assert.match(harness.statuses.at(-1)?.text ?? "", /^acme\/a/u);

  runtime.observeToolCall(readCall("/repo/b/failing.ts"), ctx);
  await wait(15);

  assert.match(harness.statuses.at(-1)?.text ?? "", /^repo — · !/u);
  assert.doesNotMatch(harness.statuses.at(-1)?.text ?? "", /acme\/a/u);
  await runtime.handleCommand("status", ctx);
  assert.match(harness.notifications.at(-1)?.message ?? "", /mode auto · \/repo\/b$/u);
  runtime.shutdown(ctx);
});

test("debounces file evidence, reports conflicts, switches once, and pinned mode ignores tools", async () => {
  const harness = createHarness();
  const runtime = registerFooterDisplay(harness.pi, {
    createDependencies: dependencies,
    debounceMs: 10,
    ageIntervalMs: 60_000,
    now: () => 61_000,
  });
  const ctx = context(harness);
  await runtime.start(ctx);

  assert.match(harness.statuses.at(-1)?.text ?? "", /^acme\/a/u);
  assert.equal(harness.appended.length, 1);

  runtime.observeToolCall(readCall("/repo/b/one.ts"), ctx);
  runtime.observeToolCall(readCall("/repo/c/two.ts"), ctx);
  await wait(30);
  assert.match(harness.statuses.at(-1)?.text ?? "", /^repo\? 2/u);
  assert.equal(harness.appended.length, 1);
  await runtime.handleCommand("status", ctx);
  assert.match(harness.notifications.at(-1)?.message ?? "", /mode auto · \/repo\/a$/u);

  runtime.observeToolCall(readCall("/repo/b/one.ts"), ctx);
  await wait(30);
  assert.match(harness.statuses.at(-1)?.text ?? "", /^acme\/b/u);
  assert.equal(harness.appended.length, 2);

  await runtime.handleCommand("pin /repo/b", ctx);
  assert.match(harness.statuses.at(-1)?.text ?? "", /^📌 acme\/b/u);
  const statusAfterPin = harness.statuses.at(-1)?.text;
  runtime.observeToolCall(readCall("/repo/c/ignored.ts"), ctx);
  await wait(30);
  assert.equal(harness.statuses.at(-1)?.text, statusAfterPin);

  runtime.shutdown(ctx);
});

test("grep, find, and ls paths are strong extension evidence over bash hints", async () => {
  const harness = createHarness();
  const runtime = registerFooterDisplay(harness.pi, {
    createDependencies: dependencies,
    debounceMs: 5,
    ageIntervalMs: 60_000,
  });
  const ctx = context(harness);
  await runtime.start(ctx);

  for (const [toolName, target, weaker] of [
    ["grep", "/repo/b/src", "/repo/c"],
    ["find", "/repo/c", "/repo/a"],
    ["ls", "/repo/b", "/repo/a"],
  ] as const) {
    runtime.observeToolCall(pathToolCall(toolName, target), ctx);
    runtime.observeToolCall(bashCall(`git -C ${weaker} status`), ctx);
    await wait(15);
    assert.match(
      harness.statuses.at(-1)?.text ?? "",
      new RegExp(`^acme/${target.split("/")[2]}`, "u"),
      toolName,
    );
  }

  runtime.shutdown(ctx);
});

test("refresh invalidates metadata while age updates never poll", async () => {
  const harness = createHarness();
  const loads = new Map<string, number>();
  const runtime = registerFooterDisplay(harness.pi, {
    createDependencies: () => dependencies(loads),
    ageIntervalMs: 5,
    now: () => 61_000,
  });
  const ctx = context(harness);
  await runtime.start(ctx);
  assert.equal(loads.get("/repo/a"), 1);

  await wait(20);
  assert.equal(loads.get("/repo/a"), 1);
  await runtime.handleCommand("refresh", ctx);
  assert.equal(loads.get("/repo/a"), 2);

  runtime.shutdown(ctx);
});

test("shutdown rejects late async startup completion", async () => {
  const harness = createHarness();
  let finish: (() => void) | undefined;
  const repositories: RepositoryInspector = {
    async findRoot() {
      return discovery("/repo/a");
    },
    async validateRoot() {
      return discovery("/repo/a");
    },
    async readIdentity(root) {
      return metadata(root);
    },
  };
  const loader: RepositoryMetadataLoader = {
    async load(root) {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { metadata: metadata(root), polarity: "positive" };
    },
  };
  const runtime = registerFooterDisplay(harness.pi, {
    createDependencies: () => ({
      repositories,
      core: new ContextCore({ repositories, metadata: loader }),
    }),
    ageIntervalMs: 60_000,
  });
  const ctx = context(harness);
  const starting = runtime.start(ctx);
  await wait(0);
  assert.ok(finish);
  runtime.shutdown(ctx);
  finish();
  await starting;

  assert.equal(harness.statuses.at(-1)?.text, undefined);
  assert.equal(harness.appended.length, 0);
});

test("persisted state validation rejects malformed and inconsistent entries", () => {
  assert.equal(parsePersistedFooterState(null), undefined);
  assert.equal(parsePersistedFooterState({ version: 2, startedAt: 1, mode: "auto" }), undefined);
  assert.equal(parsePersistedFooterState({ version: 1, startedAt: 0, mode: "auto" }), undefined);
  assert.equal(parsePersistedFooterState({ version: 1, startedAt: 1, mode: "pinned" }), undefined);
  assert.equal(
    parsePersistedFooterState({ version: 1, startedAt: 1, mode: "auto", lastConfirmedRoot: "relative" }),
    undefined,
  );
  assert.deepEqual(
    parsePersistedFooterState({
      version: 1,
      startedAt: 1_000,
      mode: "auto",
      pinnedRoot: "/ignored",
      lastConfirmedRoot: "/repo/a",
    }),
    { version: 1, startedAt: 1_000, mode: "auto", lastConfirmedRoot: "/repo/a" },
  );
});

test("changed restored roots are canonicalized and deleted roots fall back to cwd", async () => {
  const changedHarness = createHarness();
  const changedRepositories: RepositoryInspector = {
    async findRoot(candidate) {
      return discovery(
        candidate === "/repo/old" || candidate === "/repo/new" ? "/repo/new" : null,
      );
    },
    async validateRoot(candidate) {
      return await this.findRoot(candidate);
    },
    async readIdentity(root) {
      return metadata(root);
    },
  };
  const changedRuntime = registerFooterDisplay(changedHarness.pi, {
    createDependencies: () => ({
      repositories: changedRepositories,
      core: new ContextCore({
        repositories: changedRepositories,
        metadata: {
          async load(root) {
            return { metadata: metadata(root), polarity: "positive" };
          },
        },
      }),
    }),
    ageIntervalMs: 60_000,
  });
  const changedState: PersistedFooterState = {
    version: 1,
    startedAt: 1_000,
    mode: "pinned",
    pinnedRoot: "/repo/old",
    lastConfirmedRoot: "/repo/old",
  };
  await changedRuntime.start(context(changedHarness, { states: [changedState] }));
  assert.match(changedHarness.statuses.at(-1)?.text ?? "", /^📌 acme\/new/u);
  assert.deepEqual(changedHarness.appended.at(-1)?.data, {
    version: 1,
    startedAt: 1_000,
    mode: "pinned",
    pinnedRoot: "/repo/new",
    lastConfirmedRoot: "/repo/new",
  });
  changedRuntime.shutdown();

  const deletedHarness = createHarness();
  const deletedRuntime = registerFooterDisplay(deletedHarness.pi, {
    createDependencies: dependencies,
    ageIntervalMs: 60_000,
  });
  const deletedState: PersistedFooterState = {
    version: 1,
    startedAt: 2_000,
    mode: "pinned",
    pinnedRoot: "/deleted/pin",
    lastConfirmedRoot: "/deleted/last",
  };
  await deletedRuntime.start(
    context(deletedHarness, { cwd: "/repo/a", states: [deletedState] }),
  );
  assert.match(deletedHarness.statuses.at(-1)?.text ?? "", /^acme\/a/u);
  assert.deepEqual(deletedHarness.appended.at(-1)?.data, {
    version: 1,
    startedAt: 2_000,
    mode: "auto",
    lastConfirmedRoot: "/repo/a",
  });
  deletedRuntime.shutdown();
});

test("commands report unavailable state and cover pin, refresh, unpin, and status transitions", async () => {
  const harness = createHarness();
  let failLoads = false;
  let loadCount = 0;
  const repositories: RepositoryInspector = {
    async findRoot(candidate) {
      for (const root of ["/repo/a", "/repo/b"]) {
        if (candidate === root || candidate.startsWith(`${root}/`)) return discovery(root);
      }
      return discovery(null);
    },
    async validateRoot(candidate) {
      return await this.findRoot(candidate);
    },
    async readIdentity(root) {
      return metadata(root);
    },
  };
  const runtime = registerFooterDisplay(harness.pi, {
    createDependencies: () => ({
      repositories,
      core: new ContextCore({
        repositories,
        metadata: {
          async load(root) {
            loadCount += 1;
            if (failLoads) throw new Error("git unavailable");
            return { metadata: metadata(root), polarity: "positive" };
          },
        },
      }),
    }),
    ageIntervalMs: 60_000,
  });
  const ctx = context(harness);

  await runtime.handleCommand("status", ctx);
  assert.deepEqual(harness.notifications.at(-1), {
    message: "Repository footer is not initialized",
    type: "warning",
  });

  await runtime.start(ctx);
  await runtime.handleCommand("status", ctx);
  assert.match(harness.notifications.at(-1)?.message ?? "", /mode auto · \/repo\/a$/u);
  await runtime.handleCommand("pin", ctx);
  assert.equal(harness.notifications.at(-1)?.message, "pin requires a path");
  await runtime.handleCommand("pin /missing", ctx);
  assert.match(harness.notifications.at(-1)?.message ?? "", /^Not a git repository:/u);
  await runtime.handleCommand("unpin", ctx);
  assert.equal(harness.notifications.at(-1)?.message, "Repository selection is already automatic");

  await runtime.handleCommand("pin ../b", ctx);
  assert.equal(harness.notifications.at(-1)?.message, "Pinned repository: /repo/b");
  assert.match(harness.statuses.at(-1)?.text ?? "", /^📌 acme\/b/u);

  failLoads = true;
  await runtime.handleCommand("refresh", ctx);
  assert.match(harness.statuses.at(-1)?.text ?? "", /^📌 repo — · !/u);
  assert.equal(harness.notifications.at(-1)?.message, "Repository footer refreshed");

  failLoads = false;
  await runtime.handleCommand("unpin", ctx);
  assert.equal(harness.notifications.at(-1)?.message, "Repository selection is automatic");
  assert.match(harness.statuses.at(-1)?.text ?? "", /^acme\/b/u);
  await runtime.handleCommand("refresh", ctx);
  assert.match(harness.statuses.at(-1)?.text ?? "", /^acme\/b/u);
  assert.ok(loadCount >= 5);

  runtime.shutdown(ctx);
  await runtime.handleCommand("status", ctx);
  assert.equal(harness.notifications.at(-1)?.type, "warning");
});

test("dependency factory failure is contained while the age timer keeps updating", async () => {
  const harness = createHarness();
  let now = 10_000;
  const runtime = registerFooterDisplay(harness.pi, {
    createDependencies() {
      throw new Error("missing git executable");
    },
    ageIntervalMs: 5,
    now: () => now,
  });
  const ctx = context(harness);
  await runtime.start(ctx);
  assert.match(harness.statuses.at(-1)?.text ?? "", /^repo — · ! · 9s$/u);
  assert.equal(harness.appended.length, 1);

  now = 71_000;
  await wait(15);
  assert.match(harness.statuses.at(-1)?.text ?? "", /^repo — · ! · 1m$/u);
  await runtime.handleCommand("refresh", ctx);
  assert.equal(harness.notifications.at(-1)?.type, "warning");
  runtime.shutdown(ctx);
});

test("persistence and status UI exceptions do not escape startup, timers, refresh, or cleanup", async () => {
  const harness = createHarness();
  let appendAttempts = 0;
  let statusAttempts = 0;
  const pi = {
    on() {},
    registerCommand() {},
    appendEntry() {
      appendAttempts += 1;
      throw new Error("session log is read-only");
    },
  } as unknown as ExtensionAPI;
  const baseCtx = context(harness);
  const ctx = {
    ...baseCtx,
    ui: {
      setStatus() {
        statusAttempts += 1;
        throw new Error("status area is unavailable");
      },
      notify(message: string, type?: string) {
        harness.notifications.push({ message, type });
      },
    },
  } as unknown as ExtensionContext & ExtensionCommandContext;
  const runtime = registerFooterDisplay(pi, {
    createDependencies: dependencies,
    ageIntervalMs: 5,
  });

  await runtime.start(ctx);
  assert.equal(appendAttempts, 1);
  await wait(15);
  assert.ok(statusAttempts >= 2);
  await runtime.handleCommand("refresh", ctx);
  assert.ok(appendAttempts >= 2);
  runtime.shutdown(ctx);
});

test("startedAt remains stable across refresh and restored runtime starts", async () => {
  const harness = createHarness();
  let now = 62_000;
  const runtime = registerFooterDisplay(harness.pi, {
    createDependencies: dependencies,
    ageIntervalMs: 60_000,
    now: () => now,
  });
  const firstContext = context(harness, { timestamp: "1970-01-01T00:00:02.000Z" });
  await runtime.start(firstContext);
  const firstState = harness.appended.at(-1)?.data as PersistedFooterState;
  assert.equal(firstState.startedAt, 2_000);
  await runtime.handleCommand("refresh", firstContext);
  assert.equal((harness.appended.at(-1)?.data as PersistedFooterState).startedAt, 2_000);
  runtime.shutdown(firstContext);

  harness.appended.length = 0;
  now = 122_000;
  const restoredContext = context(harness, { states: [firstState] });
  await runtime.start(restoredContext);
  assert.equal(harness.appended.length, 0);
  assert.match(harness.statuses.at(-1)?.text ?? "", / · 2m$/u);
  runtime.shutdown(restoredContext);
});

test("concurrent pin transitions keep tool evidence blocked until every pin settles", async () => {
  const harness = createHarness();
  const findCounts = new Map<string, number>();
  let finishB: (() => void) | undefined;
  let finishC: (() => void) | undefined;
  const repositories: RepositoryInspector = {
    async findRoot(candidate) {
      findCounts.set(candidate, (findCounts.get(candidate) ?? 0) + 1);
      const root = ["/repo/a", "/repo/b", "/repo/c"].find(
        (value) => candidate === value || candidate.startsWith(`${value}/`),
      );
      if (!root) return discovery(null);
      if (candidate === "/repo/b" && findCounts.get(candidate) === 1) {
        await new Promise<void>((resolve) => {
          finishB = resolve;
        });
      }
      if (candidate === "/repo/c" && findCounts.get(candidate) === 1) {
        await new Promise<void>((resolve) => {
          finishC = resolve;
        });
      }
      return discovery(root);
    },
    async validateRoot(candidate) {
      return await this.findRoot(candidate);
    },
    async readIdentity(root) {
      return metadata(root);
    },
  };
  const runtime = registerFooterDisplay(harness.pi, {
    createDependencies: () => ({
      repositories,
      core: new ContextCore({
        repositories,
        metadata: {
          async load(root) {
            return { metadata: metadata(root), polarity: "positive" };
          },
        },
      }),
    }),
    debounceMs: 5,
    ageIntervalMs: 60_000,
  });
  const ctx = context(harness);
  await runtime.start(ctx);

  const firstPin = runtime.handleCommand("pin /repo/b", ctx);
  const secondPin = runtime.handleCommand("pin /repo/c", ctx);
  await wait(0);
  assert.ok(finishB);
  assert.ok(finishC);

  finishB();
  await firstPin;
  runtime.observeToolCall(readCall("/repo/a/interrupt.ts"), ctx);
  await wait(15);
  assert.equal(findCounts.get("/repo/a/interrupt.ts"), undefined);

  finishC();
  await secondPin;
  assert.match(harness.statuses.at(-1)?.text ?? "", /^📌 acme\/c/u);
  assert.equal(harness.notifications.at(-1)?.message, "Pinned repository: /repo/c");
  runtime.shutdown(ctx);
});

test("newer debounced resolution rejects an older async generation", async () => {
  const harness = createHarness();
  const pending = new Map<string, () => void>();
  const repositories: RepositoryInspector = {
    async findRoot(candidate) {
      for (const root of ["/repo/a", "/repo/b", "/repo/c"]) {
        if (candidate === root || candidate.startsWith(`${root}/`)) return discovery(root);
      }
      return discovery(null);
    },
    async validateRoot(candidate) {
      return await this.findRoot(candidate);
    },
    async readIdentity(root) {
      return metadata(root);
    },
  };
  const loader: RepositoryMetadataLoader = {
    async load(root) {
      if (root === "/repo/a") return { metadata: metadata(root), polarity: "positive" };
      return await new Promise((resolve) => {
        pending.set(root, () => resolve({ metadata: metadata(root), polarity: "positive" }));
      });
    },
  };
  const runtime = registerFooterDisplay(harness.pi, {
    createDependencies: () => ({
      repositories,
      core: new ContextCore({ repositories, metadata: loader }),
    }),
    debounceMs: 5,
    ageIntervalMs: 60_000,
  });
  const ctx = context(harness);
  await runtime.start(ctx);

  runtime.observeToolCall(readCall("/repo/b/slow.ts"), ctx);
  await wait(10);
  assert.ok(pending.has("/repo/b"));
  runtime.observeToolCall(readCall("/repo/c/fast.ts"), ctx);
  await wait(10);
  assert.ok(pending.has("/repo/c"));

  pending.get("/repo/c")?.();
  await wait(0);
  assert.match(harness.statuses.at(-1)?.text ?? "", /^acme\/c/u);
  const statusesAfterNewer = harness.statuses.length;
  const entriesAfterNewer = harness.appended.length;

  pending.get("/repo/b")?.();
  await wait(0);
  assert.equal(harness.statuses.length, statusesAfterNewer);
  assert.equal(harness.appended.length, entriesAfterNewer);
  assert.match(harness.statuses.at(-1)?.text ?? "", /^acme\/c/u);
  runtime.shutdown(ctx);
});

test("repeated starts and shutdowns cancel pending debounce and age resources", async () => {
  const harness = createHarness();
  let creations = 0;
  const runtime = registerFooterDisplay(harness.pi, {
    createDependencies() {
      creations += 1;
      return dependencies();
    },
    debounceMs: 15,
    ageIntervalMs: 5,
  });
  const first = context(harness, { cwd: "/repo/a" });
  await runtime.start(first);
  runtime.observeToolCall(readCall("/repo/b/pending.ts"), first);

  const second = context(harness, { cwd: "/repo/c" });
  await runtime.start(second);
  assert.equal(creations, 2);
  assert.match(harness.statuses.at(-1)?.text ?? "", /^acme\/c/u);
  await wait(25);
  assert.doesNotMatch(harness.statuses.at(-1)?.text ?? "", /^acme\/b/u);

  runtime.shutdown(second);
  const statusCountAfterShutdown = harness.statuses.length;
  await wait(15);
  assert.equal(harness.statuses.length, statusCountAfterShutdown);
  runtime.shutdown(second);
  assert.equal(harness.statuses.length, statusCountAfterShutdown);

  await runtime.start(first);
  assert.equal(creations, 3);
  runtime.shutdown(first);
});
