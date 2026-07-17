import assert from "node:assert/strict";
import test from "node:test";
import { BoundedTtlCache } from "../src/cache.js";
import {
  ContextCore,
  DefaultRepositoryMetadataLoader,
  type RepositoryMetadataLoader,
} from "../src/context.js";
import type {
  FindToolInput,
  GrepToolInput,
  LsToolInput,
} from "@earendil-works/pi-coding-agent";
import { formatDisplaySegment, formatFooter } from "../src/format.js";
import {
  GitRepositoryInspector,
  parseGitHubRemote,
  type RepositoryDiscoveryOutcome,
  type RepositoryInspector,
} from "../src/git.js";
import {
  CachedPullRequestLookup,
  GhPullRequestLookup,
  pullRequestQueryFingerprint,
} from "../src/github.js";
import {
  extractBashPaths,
  extractFileToolPaths,
  inferBashCommand,
  inferToolCall,
} from "../src/paths.js";
import { ExecFileRunner, ProcessExecutionError, type CommandRunner } from "../src/process.js";
import { FooterSessionController } from "../src/state.js";
import type {
  FooterSessionState,
  LocalRepositoryIdentity,
  RepositoryMetadata,
} from "../src/types.js";

function discovery(root: string | null): RepositoryDiscoveryOutcome {
  return root ? { kind: "repository", root } : { kind: "not-repository" };
}

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
  assert.deepEqual(extractBashPaths("grep needle /work/repo/src"), [
    { path: "/work/repo/src", source: "bash" },
  ]);
  assert.deepEqual(extractBashPaths("cd /work/a && cat /work/b/file"), [
    { path: "/work/b/file", source: "bash" },
  ]);
  assert.deepEqual(extractBashPaths("echo /work/not-evidence"), []);
  assert.deepEqual(extractBashPaths("cat /work/a | tee /work/b"), []);
  assert.deepEqual(extractBashPaths("cat /work/a & touch /work/b"), []);
  assert.deepEqual(extractBashPaths("cat /work/a /work/b"), []);
  assert.deepEqual(extractBashPaths("git -C /work/a -C /work/b status"), []);
  assert.deepEqual(extractBashPaths("git -C relative status"), []);
  assert.deepEqual(extractBashPaths("cd relative && npm test"), []);
  assert.deepEqual(extractBashPaths("cd /work/repo && npm test && pwd"), []);
  assert.deepEqual(extractBashPaths("cat /work/a\npwd"), []);
});

test("infers relative literal cwd, git -C, worktree, and gh effects", () => {
  assert.deepEqual(
    inferBashCommand("cd ../b && git status", "/work/a"),
    {
      hints: [{ path: "/work/b", source: "bash" }],
      effects: [],
    },
  );
  assert.deepEqual(
    inferBashCommand("git -C ../b switch feature/footer", "/work/a"),
    {
      hints: [{ path: "/work/b", source: "bash" }],
      effects: [{ kind: "git-mutation", rootPath: "/work/b" }],
    },
  );
  assert.deepEqual(
    inferBashCommand("git worktree add ../b feature/footer", "/work/a"),
    {
      hints: [
        { path: "/work/b", source: "file" },
        { path: "/work/a", source: "bash" },
      ],
      effects: [{
        kind: "worktree-add",
        rootPath: "/work/a",
        destinationPath: "/work/b",
      }],
    },
  );
  assert.deepEqual(
    inferBashCommand("gh pr create --title 'Footer refresh'", "/work/a"),
    {
      hints: [{ path: "/work/a", source: "bash" }],
      effects: [{ kind: "github-pr-mutation", rootPath: "/work/a" }],
    },
  );
  assert.deepEqual(
    inferToolCall("custom.read", { path: "/work/b" }, "/work/a"),
    { hints: [], effects: [] },
  );
});

test("effect inference rejects unsafe syntax, cwd conflicts, and unsupported options", () => {
  for (const command of [
    "cd $TARGET && git status",
    "cd $(pwd) && git status",
    "cd ../* && git status",
    "cd ~/repo && git status",
    "cd ../b && git status > /tmp/out",
    "cd ../b && git status | cat",
    "cd ../b && (git status)",
    "cd ../b; git status",
    "cd ../b && cd ../c",
    "cd ../b && git -C . switch feature",
    "git -C ../b -C ../c switch feature",
    "git worktree add -b feature ../b",
    "git config --get remote.origin.url",
    "gh pr create --repo acme/widget",
    "gh pr create -Racme/widget",
    "cd ../b && gh pr create --repo acme/widget",
    "cd ../b && npm\0 test",
  ]) {
    assert.deepEqual(inferBashCommand(command, "/work/a"), {
      hints: [],
      effects: [],
    }, command);
  }
  assert.deepEqual(inferBashCommand("gh pr list", "/work/a"), {
    hints: [],
    effects: [],
  });
  assert.deepEqual(
    inferBashCommand("git config remote.origin.url git@github.com:acme/widget.git", "/work/a"),
    {
      hints: [{ path: "/work/a", source: "bash" }],
      effects: [{ kind: "git-mutation", rootPath: "/work/a" }],
    },
  );
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
  assert.deepEqual(await inspector.findRoot("/work/repo/file;touch bad"), {
    kind: "repository",
    root: "/real/repo",
  });
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

test("PR query fingerprints normalize repository case without losing tuple boundaries", () => {
  const fingerprint = pullRequestQueryFingerprint({
    repository: { owner: "Acme", repo: "Widget" },
    branch: "feature/Footer",
  });
  assert.equal(
    fingerprint,
    pullRequestQueryFingerprint({
      repository: { owner: "acme", repo: "widget" },
      branch: "feature/Footer",
    }),
  );
  assert.notEqual(
    fingerprint,
    pullRequestQueryFingerprint({
      repository: { owner: "acme", repo: "widget" },
      branch: "feature/footer",
    }),
  );
  assert.notEqual(
    pullRequestQueryFingerprint({
      repository: { owner: "acme-a", repo: "b" },
      branch: "main",
    }),
    pullRequestQueryFingerprint({
      repository: { owner: "acme", repo: "a-b" },
      branch: "main",
    }),
  );
  assert.throws(
    () => pullRequestQueryFingerprint({
      repository: { owner: "-invalid", repo: "widget" },
      branch: "main",
    }),
    /invalid pull request query identity/u,
  );
});

test("PR lookup cache keeps no-PR results for 60 seconds and errors for 10 seconds", async () => {
  let now = 0;
  const calls: string[] = [];
  const lookup = new CachedPullRequestLookup(
    {
      async findOpenPullRequest(_repository, branch) {
        calls.push(branch);
        if (branch === "error") throw new Error("gh unavailable");
        return undefined;
      },
    },
    { now: () => now },
  );
  const repository = { owner: "acme", repo: "widget" };

  assert.equal(await lookup.findOpenPullRequest(repository, "none"), undefined);
  assert.equal(await lookup.findOpenPullRequest(repository, "none"), undefined);
  now = 59_999;
  assert.equal(await lookup.findOpenPullRequest(repository, "none"), undefined);
  assert.equal(calls.filter((branch) => branch === "none").length, 1);
  now = 60_000;
  assert.equal(await lookup.findOpenPullRequest(repository, "none"), undefined);
  assert.equal(calls.filter((branch) => branch === "none").length, 2);

  await assert.rejects(
    lookup.findOpenPullRequest(repository, "error"),
    /gh unavailable/u,
  );
  await assert.rejects(
    lookup.findOpenPullRequest(repository, "error"),
    /gh unavailable/u,
  );
  now = 69_999;
  await assert.rejects(
    lookup.findOpenPullRequest(repository, "error"),
    /gh unavailable/u,
  );
  assert.equal(calls.filter((branch) => branch === "error").length, 1);
  now = 70_000;
  await assert.rejects(
    lookup.findOpenPullRequest(repository, "error"),
    /gh unavailable/u,
  );
  assert.equal(calls.filter((branch) => branch === "error").length, 2);
});

test("PR lookup cache evicts old query identities at its configured bound", async () => {
  let calls = 0;
  const lookup = new CachedPullRequestLookup(
    {
      async findOpenPullRequest() {
        calls += 1;
        return undefined;
      },
    },
    { maxEntries: 2 },
  );
  const repository = { owner: "acme", repo: "widget" };

  await lookup.findOpenPullRequest(repository, "one");
  await lookup.findOpenPullRequest(repository, "two");
  await lookup.findOpenPullRequest(repository, "three");
  await lookup.findOpenPullRequest(repository, "one");
  assert.equal(calls, 4);
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
      return discovery(roots.get(candidate) ?? null);
    },
    async validateRoot(candidate) {
      return discovery(roots.get(candidate) ?? null);
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

test("file tools accept Pi 0.80.7 path inputs and normalize relative arrays", () => {
  const piInputs: Array<[string, FindToolInput | GrepToolInput | LsToolInput]> = [
    ["find", { pattern: "*.ts", path: "src" }],
    ["grep", { pattern: "needle", path: "/other/repo" }],
    ["ls", { path: "." }],
  ];
  assert.deepEqual(
    piInputs.flatMap(([toolName, input]) => extractFileToolPaths(toolName, input, "/repo")),
    [
      { path: "/repo/src", source: "file" },
      { path: "/other/repo", source: "file" },
      { path: "/repo", source: "file" },
    ],
  );
  assert.deepEqual(
    extractFileToolPaths(
      "functions.edit",
      { paths: ["src/a.ts", "/repo/b.ts", "src/a.ts", 7], path: "README.md" },
      "/repo",
    ),
    [
      { path: "/repo/README.md", source: "file" },
      { path: "/repo/src/a.ts", source: "file" },
      { path: "/repo/b.ts", source: "file" },
    ],
  );
  assert.deepEqual(
    extractFileToolPaths("write", { file_path: "new/file.ts" }, "/repo"),
    [{ path: "/repo/new/file.ts", source: "file" }],
  );
  assert.deepEqual(extractFileToolPaths("bash", { path: "/repo" }, "/repo"), []);
  assert.deepEqual(extractFileToolPaths("read", null, "/repo"), []);
});

test("bash extraction rejects ambiguous and injection-like syntax", () => {
  for (const command of [
    "cat relative.txt",
    "cat /repo/a; touch /tmp/pwned",
    "cat /repo/a || touch /tmp/pwned",
    "cat $(touch /tmp/pwned)",
    "cat `touch /tmp/pwned`",
    "cat \"$HOME/file\"",
    "cat /repo/a > /tmp/out",
    "cd /repo &&",
    "cd /repo && npm test && echo done",
    "git -C /repo -C /other status",
    "grep /absolute-looking-regex relative.txt",
    "sed /absolute-looking-program/d relative.txt",
    "find relative -name /absolute-looking-pattern",
    "head -n /absolute-looking-count relative.txt",
    "cd /repo && cd /other",
    "cd /repo && cat /other/a /third/b",
  ]) {
    assert.deepEqual(extractBashPaths(command), [], command);
  }
});

test("parses URL variants without accepting lookalike or non-GitHub remotes", () => {
  for (const remote of [
    " http://github.com/acme/widget ",
    "https://GITHUB.com/acme/widget.git/",
    "ssh://git@github.com:22/acme/widget.git",
    "git@GITHUB.COM:acme/widget.GIT",
    "github.com:acme/widget",
    "https://github.com/acme/widget.git?tab=readme#top",
  ]) {
    assert.deepEqual(parseGitHubRemote(remote), { owner: "acme", repo: "widget" }, remote);
  }
  for (const remote of [
    "",
    "https://github.example/acme/widget.git",
    "https://github.com.evil.test/acme/widget.git",
    "https://github.com@evil.test/acme/widget.git",
    "file://github.com/acme/widget.git",
    "git@gitlab.com:acme/widget.git",
    "https://github.com/acme",
    "https://github.com/acme/widget/extra",
    "https://github.com/acme/widget%2Fextra.git",
    "https://github.com/-invalid/widget.git",
  ]) {
    assert.equal(parseGitHubRemote(remote), undefined, remote);
  }
});

test("process runner preserves stderr separately from its display message", async () => {
  const runner = new ExecFileRunner();
  await assert.rejects(
    runner.run(process.execPath, ["-e", "process.stderr.write('structured stderr\\n'); process.exit(7)"]),
    (error: unknown) => {
      assert.ok(error instanceof ProcessExecutionError);
      assert.equal(error.kind, "exit");
      assert.equal(error.exitCode, 7);
      assert.equal(error.stderr, "structured stderr\n");
      return true;
    },
  );
});

test("git discovery confirms only canonical no-repository failures", async () => {
  const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
  let failure: Error = new Error("spawn git ENOENT");
  const inspector = new GitRepositoryInspector(
    {
      async run() {
        throw failure;
      },
    },
    {
      async stat(value) {
        if (value === "/") return { isDirectory: () => true };
        throw missing;
      },
      async realpath(value) {
        return value;
      },
    },
  );

  assert.deepEqual(await inspector.validateRoot("/deleted/repo"), {
    kind: "not-repository",
  });

  const indeterminateFailures = [
    new ProcessExecutionError("missing git", { kind: "spawn" }),
    new ProcessExecutionError("git timed out", { kind: "timeout" }),
    new ProcessExecutionError("permission denied", {
      kind: "exit",
      exitCode: 128,
      stderr: "fatal: cannot change to '/private/repo': Permission denied\n",
    }),
    new ProcessExecutionError("unsafe ownership", {
      kind: "exit",
      exitCode: 128,
      stderr: "fatal: detected dubious ownership in repository at '/repo'\n",
    }),
    new ProcessExecutionError("bad config", {
      kind: "exit",
      exitCode: 128,
      stderr: "fatal: bad config line 1 in file .git/config\n",
    }),
    new ProcessExecutionError("not a repository", {
      kind: "exit",
      exitCode: 128,
      stderr: "fatal: loose object abc is corrupt\n",
    }),
  ];
  for (const processFailure of indeterminateFailures) {
    failure = processFailure;
    assert.equal((await inspector.findRoot("/outside/new.ts")).kind, "indeterminate");
  }

  failure = new ProcessExecutionError("generic user-facing message", {
    kind: "exit",
    exitCode: 128,
    stderr: "fatal: not a git repository (or any of the parent directories): .git\n",
  });
  assert.deepEqual(await inspector.findRoot("/outside/new.ts"), {
    kind: "not-repository",
  });
});

test("git discovery keeps filesystem permission and realpath failures indeterminate", async () => {
  const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
  const permissionInspector = new GitRepositoryInspector(
    { async run() { throw new Error("not reached"); } },
    {
      async stat() { throw denied; },
      async realpath(value) { return value; },
    },
  );
  assert.deepEqual(await permissionInspector.validateRoot("/private/repo"), {
    kind: "indeterminate",
    reason: "permission denied",
  });

  const realpathInspector = new GitRepositoryInspector(
    { async run() { return { stdout: "/repo\n", stderr: "" }; } },
    {
      async stat() { return { isDirectory: () => true }; },
      async realpath() { throw denied; },
    },
  );
  assert.deepEqual(await realpathInspector.findRoot("/repo"), {
    kind: "indeterminate",
    reason: "permission denied",
  });
});

test("git identity handles detached HEAD and skips non-GitHub remotes", async () => {
  const calls: string[] = [];
  const inspector = new GitRepositoryInspector(
    {
      async run(_file, args) {
        const key = args.slice(2).join(" ");
        calls.push(key);
        if (key === "symbolic-ref --quiet --short HEAD") throw new Error("detached");
        if (key === "rev-parse --short HEAD") return { stdout: "abc1234\n", stderr: "" };
        if (key === "remote") return { stdout: "upstream\norigin\n", stderr: "" };
        if (key === "config --get remote.origin.url") {
          return { stdout: "git@gitlab.com:acme/local.git\n", stderr: "" };
        }
        if (key === "config --get remote.upstream.url") {
          return { stdout: "https://example.com/acme/local.git\n", stderr: "" };
        }
        throw new Error(`unexpected argv: ${key}`);
      },
    },
    {
      async stat() {
        return { isDirectory: () => true };
      },
      async realpath() {
        return "/real/local";
      },
    },
  );

  assert.deepEqual(await inspector.readIdentity("/linked/local"), {
    root: "/real/local",
    name: "local",
    ref: { name: "abc1234", detached: true },
  });
  assert.deepEqual(calls.slice(-3), [
    "remote",
    "config --get remote.origin.url",
    "config --get remote.upstream.url",
  ]);
});

test("git identity prefers origin but can find a later GitHub remote", async () => {
  const inspector = new GitRepositoryInspector(
    {
      async run(_file, args) {
        const key = args.slice(2).join(" ");
        if (key === "symbolic-ref --quiet --short HEAD") {
          return { stdout: "feature/x\n", stderr: "" };
        }
        if (key === "remote") return { stdout: "upstream\norigin\n", stderr: "" };
        if (key === "config --get remote.origin.url") {
          return { stdout: "https://gitlab.com/acme/widget.git\n", stderr: "" };
        }
        if (key === "config --get remote.upstream.url") {
          return { stdout: "git@github.com:acme/widget.git\n", stderr: "" };
        }
        throw new Error(`unexpected argv: ${key}`);
      },
    },
    {
      async stat() {
        return { isDirectory: () => true };
      },
      async realpath() {
        return "/repo/widget";
      },
    },
  );

  assert.deepEqual(await inspector.readIdentity("/repo/widget"), {
    root: "/repo/widget",
    name: "widget",
    ref: { name: "feature/x", detached: false },
    github: { owner: "acme", repo: "widget" },
  });
});

test("metadata loader degrades safely for local-only, detached, and failed gh lookups", async () => {
  const identities = new Map<string, LocalRepositoryIdentity>([
    ["/local", {
      root: "/local",
      name: "local",
      ref: { name: "main", detached: false },
    }],
    ["/detached", {
      root: "/detached",
      name: "detached",
      ref: { name: "abc1234", detached: true },
      github: { owner: "acme", repo: "detached" },
    }],
    ["/github", {
      root: "/github",
      name: "github",
      ref: { name: "main", detached: false },
      github: { owner: "acme", repo: "github" },
    }],
  ]);
  let ghCalls = 0;
  const repositories: RepositoryInspector = {
    async findRoot() {
      return discovery(null);
    },
    async validateRoot() {
      return discovery(null);
    },
    async readIdentity(root) {
      const identity = identities.get(root);
      if (!identity) throw new Error("missing git");
      return identity;
    },
  };
  const loader = new DefaultRepositoryMetadataLoader(repositories, {
    async findOpenPullRequest() {
      ghCalls += 1;
      throw new Error("gh auth required");
    },
  });

  assert.deepEqual(await loader.load("/local"), {
    metadata: { ...identities.get("/local")!, degraded: ["no-github-remote"] },
    polarity: "negative",
  });
  assert.deepEqual(await loader.load("/detached"), {
    metadata: { ...identities.get("/detached")!, degraded: ["detached-head"] },
    polarity: "negative",
  });
  assert.deepEqual(await loader.load("/github"), {
    metadata: { ...identities.get("/github")!, degraded: ["github-unavailable"] },
    polarity: "negative",
  });
  assert.equal(ghCalls, 1);
});

test("local identity invalidation reuses only the matching PR query", async () => {
  let identityReads = 0;
  let identity: LocalRepositoryIdentity = {
    root: "/repo",
    name: "widget",
    ref: { name: "main", detached: false },
    github: { owner: "acme", repo: "widget" },
  };
  const ghCalls: string[] = [];
  const repositories: RepositoryInspector = {
    async findRoot() {
      return discovery("/repo");
    },
    async validateRoot() {
      return discovery("/repo");
    },
    async readIdentity() {
      identityReads += 1;
      return identity;
    },
  };
  const loader = new DefaultRepositoryMetadataLoader(repositories, {
    async findOpenPullRequest(repository, branch) {
      ghCalls.push(`${repository.owner}/${repository.repo}:${branch}`);
      if (repository.repo !== "widget") return undefined;
      return {
        number: branch === "main" ? 1 : 2,
        state: "OPEN",
        isDraft: false,
        url: `https://example/${branch}`,
      };
    },
  });
  const core = new ContextCore({ repositories, metadata: loader });
  const resolveMetadata = async (): Promise<RepositoryMetadata> => {
    const outcome = await core.resolve([{ path: "/repo/file.ts", source: "file" }]);
    assert.equal(outcome.kind, "resolved");
    if (outcome.kind !== "resolved") throw new Error("expected resolved metadata");
    return outcome.metadata;
  };

  assert.equal((await resolveMetadata()).pullRequest?.number, 1);
  assert.equal((await resolveMetadata()).pullRequest?.number, 1);
  assert.equal(identityReads, 1);
  assert.equal(ghCalls.length, 1);

  core.invalidateLocalIdentity("/repo");
  assert.equal((await resolveMetadata()).pullRequest?.number, 1);
  assert.equal(identityReads, 2);
  assert.equal(ghCalls.length, 1);

  identity = { ...identity, ref: { name: "feature/cache", detached: false } };
  core.invalidateLocalIdentity("/repo");
  assert.equal((await resolveMetadata()).pullRequest?.number, 2);
  assert.equal(ghCalls.length, 2);

  identity = {
    ...identity,
    name: "other",
    github: { owner: "acme", repo: "other" },
  };
  core.invalidateLocalIdentity("/repo");
  assert.equal((await resolveMetadata()).pullRequest, undefined);
  assert.equal(ghCalls.length, 3);

  identity = {
    ...identity,
    name: "widget",
    github: { owner: "acme", repo: "widget" },
  };
  core.invalidateLocalIdentity("/repo");
  assert.equal((await resolveMetadata()).pullRequest?.number, 2);
  assert.equal(ghCalls.length, 3);

  identity = { ...identity, ref: { name: "main", detached: false } };
  core.invalidateRepository("/repo");
  assert.equal((await resolveMetadata()).pullRequest?.number, 1);
  assert.equal(identityReads, 6);
  assert.equal(ghCalls.length, 4);
});

test("gh lookup distinguishes no PR from command and response failures", async () => {
  const noPullRequest = new GhPullRequestLookup({
    async run() {
      return { stdout: "[]", stderr: "" };
    },
  });
  assert.equal(
    await noPullRequest.findOpenPullRequest({ owner: "acme", repo: "widget" }, "main"),
    undefined,
  );

  for (const message of ["spawn gh ENOENT", "gh auth login required", "network failed"]) {
    const lookup = new GhPullRequestLookup({
      async run() {
        throw new Error(message);
      },
    });
    await assert.rejects(
      lookup.findOpenPullRequest({ owner: "acme", repo: "widget" }, "main"),
      new RegExp(message),
    );
  }

  const malformed = new GhPullRequestLookup({
    async run() {
      return { stdout: "not json", stderr: "" };
    },
  });
  await assert.rejects(
    malformed.findOpenPullRequest({ owner: "acme", repo: "widget" }, "main"),
    SyntaxError,
  );

  for (const stdout of [
    "{}",
    '[{"number":7,"state":"CLOSED","isDraft":false,"url":"https://example/7"}]',
    '[{"number":"7","state":"OPEN","isDraft":false,"url":"https://example/7"}]',
    '[{"number":7,"state":"OPEN","isDraft":false,"url":"not a URL"}]',
  ]) {
    const invalid = new GhPullRequestLookup({
      async run() {
        return { stdout, stderr: "" };
      },
    });
    await assert.rejects(
      invalid.findOpenPullRequest({ owner: "acme", repo: "widget" }, "main"),
      /gh returned/u,
    );
  }
});

test("context falls through non-repositories and coalesces candidates for one root", async () => {
  const seen: string[] = [];
  const repositories: RepositoryInspector = {
    async findRoot(candidate) {
      seen.push(candidate);
      return discovery(candidate.startsWith("/repo/") ? "/repo" : null);
    },
    async validateRoot(candidate) {
      return discovery(candidate === "/repo" ? "/repo" : null);
    },
    async readIdentity() {
      throw new Error("not used");
    },
  };
  const core = new ContextCore({
    repositories,
    metadata: {
      async load() {
        return { metadata: { ...metadata, root: "/repo" }, polarity: "positive" };
      },
    },
  });

  assert.equal(
    (await core.resolve([
      { path: "/outside/file", source: "file" },
      { path: "/repo/a", source: "bash" },
      { path: "/repo/b", source: "bash" },
    ])).kind,
    "resolved",
  );
  assert.deepEqual(seen, ["/outside/file", "/repo/a", "/repo/b"]);
  assert.deepEqual(await core.resolve([{ path: "/outside/again", source: "file" }]), {
    kind: "no-repository",
  });
});

test("context converts metadata failures to unavailable outcomes", async () => {
  const repositories: RepositoryInspector = {
    async findRoot() {
      return discovery("/repo");
    },
    async validateRoot() {
      return discovery("/repo");
    },
    async readIdentity() {
      throw new Error("not used");
    },
  };
  const core = new ContextCore({
    repositories,
    metadata: {
      async load() {
        throw new Error("git disappeared");
      },
    },
  });
  assert.deepEqual(await core.resolve([{ path: "/repo", source: "file" }]), {
    kind: "unavailable",
    reason: "git disappeared",
    root: "/repo",
  });
});

test("late discovery cannot repopulate a path cache after reconciliation", async () => {
  let discoveryCalls = 0;
  let releaseOlder: (() => void) | undefined;
  let markOlderStarted: (() => void) | undefined;
  const olderStarted = new Promise<void>((resolve) => {
    markOlderStarted = resolve;
  });
  const repositories: RepositoryInspector = {
    async findRoot() {
      discoveryCalls += 1;
      if (discoveryCalls === 1) {
        markOlderStarted?.();
        await new Promise<void>((resolve) => {
          releaseOlder = resolve;
        });
        return discovery("/repo/old");
      }
      return discovery("/repo/new");
    },
    async validateRoot(candidate) {
      return await this.findRoot(candidate);
    },
    async readIdentity(root) {
      return metadataForRoot(root);
    },
  };
  const metadataForRoot = (root: string): RepositoryMetadata => ({
    ...metadata,
    root,
    name: root.endsWith("old") ? "old" : "new",
    github: { owner: "acme", repo: root.endsWith("old") ? "old" : "new" },
  });
  const core = new ContextCore({
    repositories,
    metadata: {
      async load(root) {
        return { metadata: metadataForRoot(root), polarity: "positive" };
      },
    },
  });
  const hints = [{ path: "/work/target", source: "file" as const }];

  const older = core.resolve(hints);
  await olderStarted;
  const reconciled = await core.reconcile(hints, { sequence: 2 });
  assert.equal(reconciled.kind, "resolved");
  if (reconciled.kind === "resolved") assert.equal(reconciled.metadata.root, "/repo/new");

  releaseOlder?.();
  await older;
  const current = await core.resolve(hints);
  assert.equal(current.kind, "resolved");
  if (current.kind === "resolved") assert.equal(current.metadata.root, "/repo/new");
  assert.equal(discoveryCalls, 2);
});

test("late metadata cannot repopulate an invalidated repository snapshot", async () => {
  let loads = 0;
  let releaseOlder: (() => void) | undefined;
  let markOlderStarted: (() => void) | undefined;
  const olderStarted = new Promise<void>((resolve) => {
    markOlderStarted = resolve;
  });
  const repositories: RepositoryInspector = {
    async findRoot() {
      return discovery("/repo");
    },
    async validateRoot() {
      return discovery("/repo");
    },
    async readIdentity(root) {
      return metadataForBranch(root, "main");
    },
  };
  const metadataForBranch = (root: string, branch: string): RepositoryMetadata => ({
    ...metadata,
    root,
    ref: { name: branch, detached: false },
  });
  const core = new ContextCore({
    repositories,
    metadata: {
      async load(root) {
        loads += 1;
        if (loads === 1) {
          markOlderStarted?.();
          await new Promise<void>((resolve) => {
            releaseOlder = resolve;
          });
          return { metadata: metadataForBranch(root, "old"), polarity: "positive" };
        }
        return { metadata: metadataForBranch(root, "new"), polarity: "positive" };
      },
    },
  });
  const hints = [{ path: "/repo", source: "file" as const }];

  const older = core.resolve(hints);
  await olderStarted;
  core.invalidateLocalIdentity("/repo");
  const current = await core.resolve(hints);
  assert.equal(current.kind, "resolved");
  if (current.kind === "resolved") assert.equal(current.metadata.ref.name, "new");

  releaseOlder?.();
  await older;
  const cached = await core.resolve(hints);
  assert.equal(cached.kind, "resolved");
  if (cached.kind === "resolved") assert.equal(cached.metadata.ref.name, "new");
  assert.equal(loads, 2);
});

test("git discovery walks to an existing ancestor for nested write targets", async () => {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const inspector = new GitRepositoryInspector(
    {
      async run(file, args) {
        calls.push({ file, args });
        return { stdout: "/repo\n", stderr: "" };
      },
    },
    {
      async stat(value) {
        if (value === "/repo") return { isDirectory: () => true };
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
      async realpath(value) {
        return value;
      },
    },
  );

  assert.deepEqual(await inspector.findRoot("/repo/new/deep/file.ts"), {
    kind: "repository",
    root: "/repo",
  });
  assert.deepEqual(calls[0], {
    file: "git",
    args: ["-C", "/repo", "rev-parse", "--show-toplevel"],
  });
});

test("formatter bounds dynamic labels and removes all control text", () => {
  assert.equal(formatDisplaySegment("feature\u001b[31m\nnext", 12), "feature [31…");
  const unsafe: FooterSessionState = {
    mode: "auto",
    startedAt: 0,
    generation: 1,
    ownsStatus: true,
    outcome: {
      kind: "resolved",
      metadata: {
        root: "/repo",
        name: `repo\u0000${"x".repeat(100)}`,
        ref: { name: "main\u009bcontrol", detached: false },
        degraded: [],
      },
    },
  };
  const text = formatFooter(unsafe, 1_000);
  assert.doesNotMatch(text, /[\u0000-\u001f\u007f-\u009f]/u);
  assert.ok(text.length < 140, text);
});
