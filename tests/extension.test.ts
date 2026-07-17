import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import {
  ContextCore,
  DefaultRepositoryMetadataLoader,
  type RepositoryMetadataLoader,
} from "../src/context.js";
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

function bashCall(command: string, toolCallId = command): ToolCallEvent {
  return {
    type: "tool_call",
    toolCallId,
    toolName: "bash",
    input: { command },
  };
}

function resultFor(call: ToolCallEvent, isError = false): ToolResultEvent {
  return {
    type: "tool_result",
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    input: call.input,
    content: [],
    details: undefined,
    isError,
  } as ToolResultEvent;
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

test("git and gh effects reconcile only after tool_result without retaining an old PR", async () => {
  const harness = createHarness();
  let branch = "main";
  let featurePullRequest: RepositoryMetadata["pullRequest"];
  let identityReads = 0;
  let ghCalls = 0;
  const repositories: RepositoryInspector = {
    async findRoot(candidate) {
      return discovery(
        candidate === "/repo/a" || candidate.startsWith("/repo/a/")
          ? "/repo/a"
          : null,
      );
    },
    async validateRoot(candidate) {
      return await this.findRoot(candidate);
    },
    async readIdentity(root) {
      identityReads += 1;
      return {
        root,
        name: "widget",
        ref: { name: branch, detached: false },
        github: { owner: "acme", repo: "widget" },
      };
    },
  };
  const loader = new DefaultRepositoryMetadataLoader(repositories, {
    async findOpenPullRequest(_repository, head) {
      ghCalls += 1;
      if (head === "main") {
        return {
          number: 1,
          state: "OPEN",
          isDraft: false,
          url: "https://example/1",
        };
      }
      return featurePullRequest;
    },
  });
  const runtime = registerFooterDisplay(harness.pi, {
    createDependencies: () => ({
      repositories,
      core: new ContextCore({ repositories, metadata: loader }),
    }),
    debounceMs: 5,
    ageIntervalMs: 5,
  });
  const ctx = context(harness, { cwd: "/repo/a" });
  await runtime.start(ctx);
  assert.match(harness.statuses.at(-1)?.text ?? "", /main · PR #1/u);

  const branchCall = bashCall("git -C . switch feature/footer", "branch-change");
  runtime.observeToolCall(branchCall, ctx);
  await wait(15);
  assert.match(harness.statuses.at(-1)?.text ?? "", /main · PR #1/u);
  assert.equal(identityReads, 1);

  branch = "feature/footer";
  await runtime.observeToolResult(resultFor(branchCall), ctx);
  assert.match(harness.statuses.at(-1)?.text ?? "", /feature\/footer/u);
  assert.doesNotMatch(harness.statuses.at(-1)?.text ?? "", /PR #1/u);
  assert.equal(identityReads, 2);
  assert.equal(ghCalls, 2);

  const sameBranchCall = bashCall("git checkout feature/footer", "same-branch");
  runtime.observeToolCall(sameBranchCall, ctx);
  await runtime.observeToolResult(resultFor(sameBranchCall), ctx);
  assert.equal(identityReads, 3);
  assert.equal(ghCalls, 2, "same PR query should stay cached after a local mutation");

  featurePullRequest = {
    number: 9,
    state: "OPEN",
    isDraft: false,
    url: "https://example/9",
  };
  const ghCall = bashCall("gh pr create --title 'Footer refresh'", "create-pr");
  runtime.observeToolCall(ghCall, ctx);
  await runtime.observeToolResult(resultFor(ghCall, true), ctx);
  assert.match(harness.statuses.at(-1)?.text ?? "", /PR #9/u);
  assert.equal(ghCalls, 3, "an errored gh result still invalidates its relevant query");

  const callsBeforeUnsupported = { identityReads, ghCalls };
  const unsupported = bashCall("gh pr create --repo acme/other", "unsupported-gh");
  runtime.observeToolCall(unsupported, ctx);
  await runtime.observeToolResult(resultFor(unsupported), ctx);
  await runtime.observeAgentSettled(ctx);
  await wait(15);
  assert.deepEqual({ identityReads, ghCalls }, callsBeforeUnsupported);
  runtime.shutdown(ctx);
});

test("a changed local identity replaces the old PR before the new PR query finishes", async (t) => {
  const harness = createHarness();
  let branch = "main";
  let finishFeatureLookup: (() => void) | undefined;
  let markFeatureLookupStarted: (() => void) | undefined;
  const featureLookupStarted = new Promise<void>((resolve) => {
    markFeatureLookupStarted = resolve;
  });
  const repositories: RepositoryInspector = {
    async findRoot(candidate) {
      return discovery(
        candidate === "/repo/a" || candidate.startsWith("/repo/a/")
          ? "/repo/a"
          : null,
      );
    },
    async validateRoot(candidate) {
      return await this.findRoot(candidate);
    },
    async readIdentity(root) {
      return {
        root,
        name: "widget",
        ref: { name: branch, detached: false },
        github: { owner: "acme", repo: "widget" },
      };
    },
  };
  const loader = new DefaultRepositoryMetadataLoader(repositories, {
    async findOpenPullRequest(_repository, head) {
      if (head === "main") {
        return {
          number: 1,
          state: "OPEN",
          isDraft: false,
          url: "https://example/1",
        };
      }
      markFeatureLookupStarted?.();
      await new Promise<void>((resolve) => {
        finishFeatureLookup = resolve;
      });
      return undefined;
    },
  });
  const runtime = registerFooterDisplay(harness.pi, {
    createDependencies: () => ({
      repositories,
      core: new ContextCore({ repositories, metadata: loader }),
    }),
    debounceMs: 5,
    ageIntervalMs: 60_000,
  });
  const ctx = context(harness, { cwd: "/repo/a" });
  t.after(() => runtime.shutdown(ctx));
  await runtime.start(ctx);
  assert.match(harness.statuses.at(-1)?.text ?? "", /main · PR #1/u);

  branch = "feature/local-first";
  const call = bashCall("git switch feature/local-first", "local-first");
  runtime.observeToolCall(call, ctx);
  const reconciling = runtime.observeToolResult(resultFor(call), ctx);
  await featureLookupStarted;

  assert.match(harness.statuses.at(-1)?.text ?? "", /feature\/local-first/u);
  assert.match(harness.statuses.at(-1)?.text ?? "", /!/u);
  assert.doesNotMatch(harness.statuses.at(-1)?.text ?? "", /PR #1/u);

  finishFeatureLookup?.();
  await reconciling;
  assert.match(harness.statuses.at(-1)?.text ?? "", /feature\/local-first/u);
  assert.doesNotMatch(harness.statuses.at(-1)?.text ?? "", /PR #1|!/u);
});

test("an unrelated failed effect preserves the confirmed automatic repository", async (t) => {
  const harness = createHarness();
  const runtime = registerFooterDisplay(harness.pi, {
    createDependencies: dependencies,
    debounceMs: 5,
    ageIntervalMs: 60_000,
  });
  const ctx = context(harness);
  t.after(() => runtime.shutdown(ctx));
  await runtime.start(ctx);
  const call = bashCall("git -C /outside switch topic", "outside-effect");
  runtime.observeToolCall(call, ctx);
  await runtime.observeToolResult(resultFor(call, true), ctx);
  assert.match(harness.statuses.at(-1)?.text ?? "", /^acme\/a/u);
});

test("a pinned root refreshes through a symlinked git effect path once", async (t) => {
  const harness = createHarness();
  let branch = "main";
  let symlinkLookups = 0;
  const repositories: RepositoryInspector = {
    async findRoot(candidate) {
      if (candidate === "/real/repo" || candidate.startsWith("/real/repo/")) {
        return discovery("/real/repo");
      }
      if (candidate === "/link/repo" || candidate.startsWith("/link/repo/")) {
        symlinkLookups += 1;
        return discovery("/real/repo");
      }
      return discovery(null);
    },
    async validateRoot(candidate) {
      return await this.findRoot(candidate);
    },
    async readIdentity(root) {
      return {
        ...metadata(root),
        ref: { name: branch, detached: false },
      };
    },
  };
  const runtime = registerFooterDisplay(harness.pi, {
    createDependencies: () => ({
      repositories,
      core: new ContextCore({
        repositories,
        metadata: {
          async load(root) {
            return {
              metadata: {
                ...metadata(root),
                ref: { name: branch, detached: false },
              },
              polarity: "positive",
            };
          },
        },
      }),
    }),
    debounceMs: 5,
    ageIntervalMs: 60_000,
  });
  const ctx = context(harness, { cwd: "/real/repo" });
  t.after(() => runtime.shutdown(ctx));
  await runtime.start(ctx);
  await runtime.handleCommand("pin /real/repo", ctx);
  branch = "feature/symlink";
  const beforeEffect = symlinkLookups;
  const call = bashCall("git -C /link/repo switch feature/symlink", "symlink-effect");
  runtime.observeToolCall(call, ctx);
  await runtime.observeToolResult(resultFor(call), ctx);
  assert.match(harness.statuses.at(-1)?.text ?? "", /^📌 acme\/repo · feature\/symlink/u);
  assert.equal(symlinkLookups, beforeEffect + 1);
});

test("repository effects remain staged until their tool result", async (t) => {
  const harness = createHarness();
  const loadCounts = new Map<string, number>();
  const runtime = registerFooterDisplay(harness.pi, {
    createDependencies: () => dependencies(loadCounts),
    debounceMs: 5,
    ageIntervalMs: 60_000,
  });
  const ctx = context(harness);
  t.after(() => runtime.shutdown(ctx));
  await runtime.start(ctx);
  const countsAfterStart = new Map(loadCounts);

  const call = bashCall("git -C /repo/b switch feature/staged", "staged-effect");
  runtime.observeToolCall(call, ctx);
  await wait(15);
  assert.deepEqual(loadCounts, countsAfterStart);
  assert.match(harness.statuses.at(-1)?.text ?? "", /^acme\/a/u);

  await runtime.observeToolResult(resultFor(call, true), ctx);
  assert.equal(loadCounts.get("/repo/b"), 1);
  assert.match(harness.statuses.at(-1)?.text ?? "", /^acme\/b/u);
});

test("tool-call order wins when mutation results complete out of order", async (t) => {
  const harness = createHarness();
  const runtime = registerFooterDisplay(harness.pi, {
    createDependencies: dependencies,
    debounceMs: 100,
    ageIntervalMs: 60_000,
  });
  const ctx = context(harness);
  t.after(() => runtime.shutdown(ctx));
  await runtime.start(ctx);

  const calledFirst = bashCall("git -C /repo/b switch first", "called-first");
  const calledSecond = bashCall("git -C /repo/c switch second", "called-second");
  runtime.observeToolCall(calledFirst, ctx);
  runtime.observeToolCall(calledSecond, ctx);

  await runtime.observeToolResult(resultFor(calledSecond), ctx);
  assert.match(harness.statuses.at(-1)?.text ?? "", /^acme\/c/u);
  await runtime.observeToolResult(resultFor(calledFirst), ctx);
  assert.match(harness.statuses.at(-1)?.text ?? "", /^acme\/c/u);
});

test("a tool result from before refresh cannot overwrite refreshed context", async (t) => {
  const harness = createHarness();
  let branch = "main";
  const repositories: RepositoryInspector = {
    async findRoot(candidate) {
      return discovery(
        candidate === "/repo/a" || candidate.startsWith("/repo/a/")
          ? "/repo/a"
          : null,
      );
    },
    async validateRoot(candidate) {
      return await this.findRoot(candidate);
    },
    async readIdentity(root) {
      return { ...metadata(root), ref: { name: branch, detached: false } };
    },
  };
  const runtime = registerFooterDisplay(harness.pi, {
    createDependencies: () => ({
      repositories,
      core: new ContextCore({
        repositories,
        metadata: {
          async load(root) {
            return {
              metadata: { ...metadata(root), ref: { name: branch, detached: false } },
              polarity: "positive",
            };
          },
        },
      }),
    }),
    debounceMs: 100,
    ageIntervalMs: 60_000,
  });
  const ctx = context(harness);
  t.after(() => runtime.shutdown(ctx));
  await runtime.start(ctx);

  const call = bashCall("git switch feature/after-refresh", "after-refresh");
  runtime.observeToolCall(call, ctx);
  await runtime.handleCommand("refresh", ctx);
  assert.match(harness.statuses.at(-1)?.text ?? "", / · main/u);

  branch = "feature/after-refresh";
  await runtime.observeToolResult(resultFor(call), ctx);
  assert.match(harness.statuses.at(-1)?.text ?? "", / · main/u);
});

test("errored worktree-add results discover a newly appeared relative destination", async () => {
  const harness = createHarness();
  let destinationExists = false;
  const repositories: RepositoryInspector = {
    async findRoot(candidate) {
      if (
        destinationExists &&
        (candidate === "/work/b" || candidate.startsWith("/work/b/"))
      ) {
        return discovery("/work/b");
      }
      if (candidate === "/work/a" || candidate.startsWith("/work/a/")) {
        return discovery("/work/a");
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
            return { metadata: metadata(root), polarity: "positive" };
          },
        },
      }),
    }),
    debounceMs: 5,
    ageIntervalMs: 60_000,
  });
  const ctx = context(harness, { cwd: "/work/a" });
  await runtime.start(ctx);
  assert.match(harness.statuses.at(-1)?.text ?? "", /^acme\/a/u);

  const call = bashCall("git worktree add ../b feature/footer", "add-worktree");
  runtime.observeToolCall(call, ctx);
  await wait(15);
  assert.match(harness.statuses.at(-1)?.text ?? "", /^acme\/a/u);

  destinationExists = true;
  await runtime.observeToolResult(resultFor(call, true), ctx);
  assert.match(harness.statuses.at(-1)?.text ?? "", /^acme\/b/u);
  runtime.shutdown(ctx);
});

test("agent_settled performs one conditional coalesced reconciliation", async () => {
  const harness = createHarness();
  let branch = "main";
  let discoveries = 0;
  let loads = 0;
  const repositories: RepositoryInspector = {
    async findRoot(candidate) {
      discoveries += 1;
      return discovery(
        candidate === "/repo/a" || candidate.startsWith("/repo/a/")
          ? "/repo/a"
          : null,
      );
    },
    async validateRoot(candidate) {
      return await this.findRoot(candidate);
    },
    async readIdentity(root) {
      return { ...metadata(root), ref: { name: branch, detached: false } };
    },
  };
  const runtime = registerFooterDisplay(harness.pi, {
    createDependencies: () => ({
      repositories,
      core: new ContextCore({
        repositories,
        metadata: {
          async load(root) {
            loads += 1;
            return {
              metadata: { ...metadata(root), ref: { name: branch, detached: false } },
              polarity: "positive",
            };
          },
        },
      }),
    }),
    debounceMs: 50,
    ageIntervalMs: 5,
  });
  const ctx = context(harness);
  await runtime.start(ctx);
  const cleanCounts = { discoveries, loads };

  const unsafe = bashCall("git status | cat", "unsafe");
  runtime.observeToolCall(unsafe, ctx);
  await runtime.observeToolResult(resultFor(unsafe), ctx);
  await runtime.observeAgentSettled(ctx);
  assert.deepEqual({ discoveries, loads }, cleanCounts);

  branch = "feature/settled";
  const pending = bashCall("git switch feature/settled", "missing-result");
  runtime.observeToolCall(pending, ctx);
  await runtime.observeAgentSettled(ctx);
  assert.equal(discoveries, cleanCounts.discoveries + 1);
  assert.equal(loads, cleanCounts.loads + 1);
  assert.match(harness.statuses.at(-1)?.text ?? "", /feature\/settled/u);

  const reconciledCounts = { discoveries, loads };
  await runtime.observeAgentSettled(ctx);
  await wait(15);
  assert.deepEqual({ discoveries, loads }, reconciledCounts);
  runtime.shutdown(ctx);
});

test("agent_settled drops a superseded pending hint before reconciling an effect", async (t) => {
  const harness = createHarness();
  const runtime = registerFooterDisplay(harness.pi, {
    createDependencies: dependencies,
    debounceMs: 100,
    ageIntervalMs: 60_000,
  });
  const ctx = context(harness);
  t.after(() => runtime.shutdown(ctx));
  await runtime.start(ctx);

  runtime.observeToolCall(readCall("/repo/b/pending.ts"), ctx);
  const effect = bashCall("git -C /repo/c switch feature/settled", "settled-later-effect");
  runtime.observeToolCall(effect, ctx);
  await runtime.observeAgentSettled(ctx);

  assert.match(harness.statuses.at(-1)?.text ?? "", /^acme\/c/u);
});

test("pinned mode ignores selection hints but refreshes relevant git mutations", async () => {
  const harness = createHarness();
  const branches = new Map([
    ["/repo/a", "main"],
    ["/repo/b", "other"],
  ]);
  let loads = 0;
  const repositories: RepositoryInspector = {
    async findRoot(candidate) {
      for (const root of branches.keys()) {
        if (candidate === root || candidate.startsWith(`${root}/`)) return discovery(root);
      }
      return discovery(null);
    },
    async validateRoot(candidate) {
      return await this.findRoot(candidate);
    },
    async readIdentity(root) {
      return { ...metadata(root), ref: { name: branches.get(root) ?? "main", detached: false } };
    },
  };
  const runtime = registerFooterDisplay(harness.pi, {
    createDependencies: () => ({
      repositories,
      core: new ContextCore({
        repositories,
        metadata: {
          async load(root) {
            loads += 1;
            return {
              metadata: {
                ...metadata(root),
                ref: { name: branches.get(root) ?? "main", detached: false },
              },
              polarity: "positive",
            };
          },
        },
      }),
    }),
    debounceMs: 5,
    ageIntervalMs: 60_000,
  });
  const ctx = context(harness);
  await runtime.start(ctx);
  await runtime.handleCommand("pin /repo/a", ctx);
  const loadsAfterPin = loads;

  runtime.observeToolCall(readCall("/repo/b/ignored.ts"), ctx);
  await wait(15);
  assert.equal(loads, loadsAfterPin);
  assert.match(harness.statuses.at(-1)?.text ?? "", /^📌 acme\/a · main/u);

  const unrelated = bashCall("git -C /repo/b switch elsewhere", "unrelated-pin");
  runtime.observeToolCall(unrelated, ctx);
  await runtime.observeToolResult(resultFor(unrelated), ctx);
  assert.equal(loads, loadsAfterPin);
  assert.match(harness.statuses.at(-1)?.text ?? "", /^📌 acme\/a · main/u);

  branches.set("/repo/a", "feature/pinned");
  const relevant = bashCall("cd src && git switch feature/pinned", "relevant-pin");
  runtime.observeToolCall(relevant, ctx);
  await runtime.observeToolResult(resultFor(relevant), ctx);
  assert.equal(loads, loadsAfterPin + 1);
  assert.match(harness.statuses.at(-1)?.text ?? "", /^📌 acme\/a · feature\/pinned/u);
  runtime.shutdown(ctx);
});

test("tool results wait for an active pin transition before reconciling", async () => {
  const harness = createHarness();
  const branches = new Map([
    ["/repo/a", "main"],
    ["/repo/b", "other"],
  ]);
  let releasePin: (() => void) | undefined;
  let pinValidationStarted: (() => void) | undefined;
  const validationStarted = new Promise<void>((resolve) => {
    pinValidationStarted = resolve;
  });
  const repositories: RepositoryInspector = {
    async findRoot(candidate) {
      const root = ["/repo/a", "/repo/b"].find(
        (value) => candidate === value || candidate.startsWith(`${value}/`),
      );
      if (candidate === "/repo/b" && releasePin === undefined) {
        pinValidationStarted?.();
        await new Promise<void>((resolve) => {
          releasePin = resolve;
        });
      }
      return discovery(root ?? null);
    },
    async validateRoot(candidate) {
      return await this.findRoot(candidate);
    },
    async readIdentity(root) {
      return {
        ...metadata(root),
        ref: { name: branches.get(root) ?? "main", detached: false },
      };
    },
  };
  const runtime = registerFooterDisplay(harness.pi, {
    createDependencies: () => ({
      repositories,
      core: new ContextCore({
        repositories,
        metadata: {
          async load(root) {
            return {
              metadata: {
                ...metadata(root),
                ref: { name: branches.get(root) ?? "main", detached: false },
              },
              polarity: "positive",
            };
          },
        },
      }),
    }),
    debounceMs: 5,
    ageIntervalMs: 60_000,
  });
  const ctx = context(harness);
  await runtime.start(ctx);

  const pinning = runtime.handleCommand("pin /repo/b", ctx);
  await validationStarted;
  branches.set("/repo/b", "feature/during-pin");
  const call = bashCall("git -C /repo/b switch feature/during-pin", "during-pin");
  runtime.observeToolCall(call, ctx);
  let resultSettled = false;
  const result = runtime.observeToolResult(resultFor(call), ctx).then(() => {
    resultSettled = true;
  });
  await wait(0);
  assert.equal(resultSettled, false);

  releasePin?.();
  await Promise.all([pinning, result]);
  assert.equal(resultSettled, true);
  assert.match(
    harness.statuses.at(-1)?.text ?? "",
    /^📌 acme\/b · feature\/during-pin/u,
  );
  runtime.shutdown(ctx);
});

test("newer effect sequence wins when older reconciliation completes last", async () => {
  const harness = createHarness();
  let finishOlder: (() => void) | undefined;
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
  const runtime = registerFooterDisplay(harness.pi, {
    createDependencies: () => ({
      repositories,
      core: new ContextCore({
        repositories,
        metadata: {
          async load(root) {
            if (root === "/repo/b") {
              await new Promise<void>((resolve) => {
                finishOlder = resolve;
              });
            }
            return { metadata: metadata(root), polarity: "positive" };
          },
        },
      }),
    }),
    debounceMs: 100,
    ageIntervalMs: 60_000,
  });
  const ctx = context(harness);
  await runtime.start(ctx);

  const older = bashCall("git -C /repo/b switch older", "older-effect");
  const newer = bashCall("git -C /repo/c switch newer", "newer-effect");
  runtime.observeToolCall(older, ctx);
  runtime.observeToolCall(newer, ctx);
  const olderResult = runtime.observeToolResult(resultFor(older), ctx);
  await wait(0);
  assert.ok(finishOlder);

  await runtime.observeToolResult(resultFor(newer), ctx);
  assert.match(harness.statuses.at(-1)?.text ?? "", /^acme\/c/u);
  const statusCount = harness.statuses.length;
  finishOlder();
  await olderResult;
  assert.equal(harness.statuses.length, statusCount);
  assert.match(harness.statuses.at(-1)?.text ?? "", /^acme\/c/u);
  runtime.shutdown(ctx);
});

test("shutdown clears staged effects and prevents result or settled work", async () => {
  const harness = createHarness();
  let discoveries = 0;
  let loads = 0;
  const base = dependencies();
  const repositories: RepositoryInspector = {
    async findRoot(candidate) {
      discoveries += 1;
      return await base.repositories.findRoot(candidate);
    },
    async validateRoot(candidate) {
      return await base.repositories.validateRoot(candidate);
    },
    async readIdentity(root) {
      return await base.repositories.readIdentity(root);
    },
  };
  const runtime = registerFooterDisplay(harness.pi, {
    createDependencies: () => ({
      repositories,
      core: new ContextCore({
        repositories,
        metadata: {
          async load(root) {
            loads += 1;
            return { metadata: metadata(root), polarity: "positive" };
          },
        },
      }),
    }),
    debounceMs: 100,
    ageIntervalMs: 60_000,
  });
  const ctx = context(harness);
  await runtime.start(ctx);
  const call = bashCall("git switch cleanup", "cleanup-effect");
  runtime.observeToolCall(call, ctx);
  runtime.shutdown(ctx);
  const counts = { discoveries, loads };

  await runtime.observeToolResult(resultFor(call), ctx);
  await runtime.observeAgentSettled(ctx);
  await wait(0);
  assert.deepEqual({ discoveries, loads }, counts);
  assert.equal(harness.statuses.at(-1)?.text, undefined);
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
