import assert from "node:assert/strict";
import test from "node:test";
import { BoundedTtlCache } from "../src/cache.js";
import { ContextCore, type RepositoryMetadataLoader } from "../src/context.js";
import { formatFooter } from "../src/format.js";
import { GitRepositoryInspector, parseGitHubRemote, type RepositoryInspector } from "../src/git.js";
import { GhPullRequestLookup } from "../src/github.js";
import { extractBashPaths, extractFileToolPaths } from "../src/paths.js";
import type { CommandRunner } from "../src/process.js";
import { FooterSessionController } from "../src/state.js";
import type { FooterSessionState, RepositoryMetadata } from "../src/types.js";

const metadata: RepositoryMetadata = {
  root: "/work/repo",
  name: "repo",
  ref: { name: "main", detached: false },
  github: { owner: "acme", repo: "repo" },
  pullRequest: { number: 42, state: "OPEN", isDraft: false, url: "https://example/pr/42" },
  degraded: [],
};

test("extracts strong file paths and only narrow bash forms", () => {
  assert.deepEqual(extractFileToolPaths("read", { path: "src/a.ts" }, "/work/repo"), [
    { path: "/work/repo/src/a.ts", source: "file" },
  ]);
  assert.deepEqual(extractBashPaths("git -C '/work/repo' status"), [
    { path: "/work/repo", source: "bash" },
  ]);
  assert.deepEqual(extractBashPaths("cd /work/repo && npm test"), [
    { path: "/work/repo", source: "bash" },
  ]);
  assert.deepEqual(extractBashPaths("cat /work/repo/README.md"), [
    { path: "/work/repo/README.md", source: "bash" },
  ]);
  assert.deepEqual(extractBashPaths("echo /work/not-evidence"), []);
  assert.deepEqual(extractBashPaths("cat /work/a | tee /work/b"), []);
  assert.deepEqual(extractBashPaths("cd /work/repo && npm test && pwd"), []);
  assert.deepEqual(extractBashPaths("cat /work/a\npwd"), []);
});

test("parses common GitHub remote forms", () => {
  for (const remote of [
    "https://github.com/acme/widget.git",
    "ssh://git@github.com/acme/widget.git",
    "git@github.com:acme/widget.git",
    "git://github.com/acme/widget",
  ]) {
    assert.deepEqual(parseGitHubRemote(remote), { owner: "acme", repo: "widget" });
  }
  assert.equal(parseGitHubRemote("https://gitlab.com/acme/widget.git"), undefined);
  assert.equal(parseGitHubRemote("https://github.com/acme/group/widget.git"), undefined);
});

test("git discovery uses argv and canonicalizes roots", async () => {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const runner: CommandRunner = {
    async run(file, args) {
      calls.push({ file, args });
      return { stdout: "/linked/repo\n", stderr: "" };
    },
  };
  const inspector = new GitRepositoryInspector(runner, {
    async stat() {
      return { isDirectory: () => false };
    },
    async realpath(value) {
      assert.equal(value, "/linked/repo");
      return "/real/repo";
    },
  });
  assert.equal(await inspector.findRoot("/work/repo/file;touch bad"), "/real/repo");
  assert.deepEqual(calls, [
    {
      file: "git",
      args: ["-C", "/work/repo", "rev-parse", "--show-toplevel"],
    },
  ]);
});

test("gh lookup always selects an explicit repository with safe argv", async () => {
  let call: { file: string; args: readonly string[] } | undefined;
  const lookup = new GhPullRequestLookup({
    async run(file, args) {
      call = { file, args };
      return {
        stdout: '[{"number":7,"state":"OPEN","isDraft":false,"url":"https://example/7"}]',
        stderr: "",
      };
    },
  });
  assert.equal((await lookup.findOpenPullRequest({ owner: "acme", repo: "widget" }, "feature/x"))?.number, 7);
  assert.deepEqual(call, {
    file: "gh",
    args: [
      "pr", "list", "--repo", "acme/widget", "--head", "feature/x", "--state", "open",
      "--limit", "1", "--json", "number,state,isDraft,url",
    ],
  });
});

test("cache is bounded and negative entries expire sooner", () => {
  let now = 0;
  const cache = new BoundedTtlCache<string, number>({
    maxEntries: 2,
    positiveTtlMs: 100,
    negativeTtlMs: 10,
    now: () => now,
  });
  cache.set("positive", 1);
  cache.set("negative", 2, "negative");
  now = 11;
  assert.equal(cache.get("negative"), undefined);
  assert.equal(cache.get("positive")?.value, 1);
  cache.set("second", 2);
  cache.set("third", 3);
  assert.equal(cache.get("positive"), undefined);
  assert.equal(cache.size, 2);
});

test("context uses file evidence first and reports conflicts", async () => {
  const roots = new Map([
    ["/file/a", "/repo/a"],
    ["/file/b", "/repo/b"],
    ["/bash/ignored", "/repo/c"],
  ]);
  const repositories: RepositoryInspector = {
    async findRoot(candidate) {
      return roots.get(candidate) ?? null;
    },
    async readIdentity() {
      throw new Error("not used");
    },
  };
  const loader: RepositoryMetadataLoader = {
    async load() {
      return { metadata, polarity: "positive" };
    },
  };
  const core = new ContextCore({ repositories, metadata: loader });
  assert.deepEqual(
    await core.resolve([
      { path: "/file/a", source: "file" },
      { path: "/file/b", source: "file" },
      { path: "/bash/ignored", source: "bash" },
    ]),
    { kind: "ambiguous", roots: ["/repo/a", "/repo/b"] },
  );
});

test("generation guard rejects stale async results", async () => {
  const session = new FooterSessionController(0);
  let finish: ((value: { kind: "resolved"; metadata: RepositoryMetadata }) => void) | undefined;
  const pending = session.resolveAndCommit(
    () => new Promise((resolve) => { finish = resolve; }),
  );
  session.pin("/other/repo");
  assert.ok(finish);
  finish({ kind: "resolved", metadata });
  assert.equal(await pending, false);
  assert.equal(session.state.mode, "pinned");
  assert.notEqual(session.state.outcome.kind, "resolved");
});

test("formatter includes repository, branch, PR, age, and markers", () => {
  const state: FooterSessionState = {
    mode: "auto",
    startedAt: 0,
    generation: 1,
    ownsStatus: true,
    outcome: { kind: "resolved", metadata },
  };
  assert.equal(formatFooter(state, 125_000), "acme/repo · main · PR #42 · 2m");
  assert.equal(
    formatFooter({ ...state, outcome: { kind: "ambiguous", roots: ["/a", "/b"] } }, 125_000),
    "repo? 2 · ? · 2m",
  );
  assert.equal(
    formatFooter({ ...state, outcome: { kind: "stale", reason: "offline", previous: metadata } }, 125_000),
    "acme/repo · main · PR #42 · ~ · 2m",
  );
});
