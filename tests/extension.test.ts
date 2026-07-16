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
  registerFooterDisplay,
  type FooterDependencies,
  type PersistedFooterState,
} from "../src/extension.js";
import type { RepositoryInspector } from "../src/git.js";
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
        if (candidate === root || candidate.startsWith(`${root}/`)) return root;
      }
      return null;
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

test("invalid restored pins fall back to a validated last confirmed root before cwd", async () => {
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
      return "/repo/a";
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
