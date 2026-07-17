import { BoundedTtlCache } from "./cache.js";
import type { CommandRunner } from "./process.js";
import type {
  GitHubRepository,
  PullRequest,
  PullRequestQuery,
} from "./types.js";

export interface PullRequestLookup {
  findOpenPullRequest(
    repository: GitHubRepository,
    branch: string,
  ): Promise<PullRequest | undefined>;
}

const GITHUB_OWNER = /^(?!-)[A-Za-z0-9-]{1,39}(?<!-)$/u;
const GITHUB_REPOSITORY = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/u;

export function isValidGitHubRepository(repository: GitHubRepository): boolean {
  return GITHUB_OWNER.test(repository.owner) && GITHUB_REPOSITORY.test(repository.repo);
}

export function isValidPullRequestQuery(query: PullRequestQuery): boolean {
  return (
    isValidGitHubRepository(query.repository) &&
    query.branch.length > 0 &&
    !query.branch.includes("\0")
  );
}

/**
 * GitHub repository slugs are case-insensitive while branch names are not.
 * JSON tuple encoding preserves field boundaries without delimiter collisions.
 */
export function pullRequestQueryFingerprint(query: PullRequestQuery): string {
  if (!isValidPullRequestQuery(query)) {
    throw new TypeError("invalid pull request query identity");
  }
  return JSON.stringify([
    "github.com",
    query.repository.owner.toLowerCase(),
    query.repository.repo.toLowerCase(),
    query.branch,
  ]);
}

export const PULL_REQUEST_CACHE_MAX_ENTRIES = 32;
export const PULL_REQUEST_CACHE_TTL_MS = 60_000;
export const PULL_REQUEST_ERROR_BACKOFF_MS = 10_000;

export interface CachedPullRequestLookupOptions {
  readonly maxEntries?: number;
  readonly now?: () => number;
}

type CachedPullRequestOutcome =
  | { readonly kind: "pull-request"; readonly pullRequest: PullRequest }
  | { readonly kind: "no-pull-request" }
  | { readonly kind: "error"; readonly error: unknown };

/** Caches PR and confirmed no-PR outcomes while briefly backing off failures. */
export class CachedPullRequestLookup implements PullRequestLookup {
  readonly #delegate: PullRequestLookup;
  readonly #cache: BoundedTtlCache<string, CachedPullRequestOutcome>;

  constructor(
    delegate: PullRequestLookup,
    options: CachedPullRequestLookupOptions = {},
  ) {
    this.#delegate = delegate;
    this.#cache = new BoundedTtlCache({
      maxEntries: options.maxEntries ?? PULL_REQUEST_CACHE_MAX_ENTRIES,
      positiveTtlMs: PULL_REQUEST_CACHE_TTL_MS,
      negativeTtlMs: PULL_REQUEST_ERROR_BACKOFF_MS,
      ...(options.now ? { now: options.now } : {}),
    });
  }

  async findOpenPullRequest(
    repository: GitHubRepository,
    branch: string,
  ): Promise<PullRequest | undefined> {
    const query = { repository, branch } satisfies PullRequestQuery;
    const fingerprint = pullRequestQueryFingerprint(query);
    const cached = this.#cache.get(fingerprint)?.value;
    if (cached) {
      if (cached.kind === "error") throw cached.error;
      return cached.kind === "pull-request" ? cached.pullRequest : undefined;
    }

    try {
      const pullRequest = await this.#delegate.findOpenPullRequest(repository, branch);
      this.#cache.set(
        fingerprint,
        pullRequest
          ? { kind: "pull-request", pullRequest }
          : { kind: "no-pull-request" },
      );
      return pullRequest;
    } catch (error) {
      this.#cache.set(fingerprint, { kind: "error", error }, "negative");
      throw error;
    }
  }

  invalidate(query: PullRequestQuery): void {
    this.#cache.delete(pullRequestQueryFingerprint(query));
  }

  clear(): void {
    this.#cache.clear();
  }
}

interface GhPullRequest {
  number?: unknown;
  state?: unknown;
  isDraft?: unknown;
  url?: unknown;
}

function asPullRequest(value: GhPullRequest): PullRequest {
  if (
    typeof value.number !== "number" ||
    !Number.isSafeInteger(value.number) ||
    value.number < 1 ||
    typeof value.state !== "string" ||
    value.state.toUpperCase() !== "OPEN" ||
    typeof value.isDraft !== "boolean" ||
    typeof value.url !== "string" ||
    value.url.length === 0
  ) {
    throw new Error("gh returned invalid open pull request data");
  }
  try {
    const url = new URL(value.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("invalid protocol");
  } catch {
    throw new Error("gh returned an invalid pull request URL");
  }
  return {
    number: value.number,
    state: value.state,
    isDraft: value.isDraft,
    url: value.url,
  };
}

export class GhPullRequestLookup implements PullRequestLookup {
  readonly #runner: CommandRunner;

  constructor(runner: CommandRunner) {
    this.#runner = runner;
  }

  async findOpenPullRequest(
    repository: GitHubRepository,
    branch: string,
  ): Promise<PullRequest | undefined> {
    pullRequestQueryFingerprint({ repository, branch });
    const slug = `${repository.owner}/${repository.repo}`;
    const result = await this.#runner.run("gh", [
      "pr",
      "list",
      "--repo",
      slug,
      "--head",
      branch,
      "--state",
      "open",
      "--limit",
      "1",
      "--json",
      "number,state,isDraft,url",
    ]);
    const parsed: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(parsed)) throw new Error("gh returned a non-array pull request response");
    if (parsed.length === 0) return undefined;
    const first = parsed[0];
    if (typeof first !== "object" || first === null || Array.isArray(first)) {
      throw new Error("gh returned invalid pull request data");
    }
    return asPullRequest(first as GhPullRequest);
  }
}
