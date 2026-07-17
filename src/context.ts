import { BoundedTtlCache, type CachePolarity } from "./cache.js";
import {
  CachedPullRequestLookup,
  isValidPullRequestQuery,
  type CachedPullRequestLookupOptions,
  type PullRequestLookup,
} from "./github.js";
import type {
  RepositoryDiscoveryOutcome,
  RepositoryInspector,
} from "./git.js";
import type {
  DiscoverySource,
  PathHint,
  PullRequestQuery,
  RepositoryMetadata,
  ResolutionOutcome,
} from "./types.js";

export interface MetadataLoadResult {
  readonly metadata: RepositoryMetadata;
  readonly polarity: CachePolarity;
}

export interface RepositoryMetadataLoader {
  load(root: string): Promise<MetadataLoadResult>;
  /** Invalidates network-derived data for an explicit repository refresh. */
  invalidate?(root: string): void;
  clear?(): void;
}

export interface DefaultRepositoryMetadataLoaderOptions {
  readonly pullRequestCache?: CachedPullRequestLookupOptions;
}

export class DefaultRepositoryMetadataLoader implements RepositoryMetadataLoader {
  readonly #repositories: RepositoryInspector;
  readonly #pullRequests: CachedPullRequestLookup;

  constructor(
    repositories: RepositoryInspector,
    pullRequests: PullRequestLookup,
    options: DefaultRepositoryMetadataLoaderOptions = {},
  ) {
    this.#repositories = repositories;
    this.#pullRequests = new CachedPullRequestLookup(
      pullRequests,
      options.pullRequestCache,
    );
  }

  async load(root: string): Promise<MetadataLoadResult> {
    const identity = await this.#repositories.readIdentity(root);
    if (!identity.github) {
      return {
        metadata: { ...identity, degraded: ["no-github-remote"] },
        polarity: "negative",
      };
    }
    if (identity.ref.detached) {
      return {
        metadata: { ...identity, degraded: ["detached-head"] },
        polarity: "negative",
      };
    }

    const query = {
      repository: { ...identity.github },
      branch: identity.ref.name,
    } satisfies PullRequestQuery;
    if (!isValidPullRequestQuery(query)) {
      return {
        metadata: { ...identity, degraded: ["github-unavailable"] },
        polarity: "negative",
      };
    }

    try {
      const pullRequest = await this.#pullRequests.findOpenPullRequest(
        query.repository,
        query.branch,
      );
      return {
        metadata: {
          ...identity,
          ...(pullRequest ? { pullRequest } : {}),
          degraded: [],
        },
        polarity: "positive",
      };
    } catch {
      // Local identity remains useful when gh is absent, offline, or unauthenticated.
      return {
        metadata: { ...identity, degraded: ["github-unavailable"] },
        polarity: "negative",
      };
    }
  }

  invalidate(_root: string): void {
    // Identity is read after invalidation, so clear every bounded query entry to
    // guarantee explicit refresh even when the branch changed while cached.
    this.#pullRequests.clear();
  }

  clear(): void {
    this.#pullRequests.clear();
  }
}

export interface ContextCoreOptions {
  readonly repositories: RepositoryInspector;
  readonly metadata: RepositoryMetadataLoader;
  readonly pathCache?: BoundedTtlCache<string, RepositoryDiscoveryOutcome>;
  readonly metadataCache?: BoundedTtlCache<string, RepositoryMetadata>;
}

const SOURCES: readonly DiscoverySource[] = ["file", "bash", "fallback"];

/** Resolves one unconflicted root from the strongest available evidence tier. */
export class ContextCore {
  readonly #repositories: RepositoryInspector;
  readonly #metadata: RepositoryMetadataLoader;
  readonly #pathCache: BoundedTtlCache<string, RepositoryDiscoveryOutcome>;
  readonly #metadataCache: BoundedTtlCache<string, RepositoryMetadata>;

  constructor(options: ContextCoreOptions) {
    this.#repositories = options.repositories;
    this.#metadata = options.metadata;
    this.#pathCache =
      options.pathCache ??
      new BoundedTtlCache({
        maxEntries: 128,
        positiveTtlMs: 5 * 60_000,
        negativeTtlMs: 30_000,
      });
    this.#metadataCache =
      options.metadataCache ??
      new BoundedTtlCache({
        maxEntries: 32,
        positiveTtlMs: 60_000,
        negativeTtlMs: 10_000,
      });
  }

  async resolve(hints: readonly PathHint[]): Promise<ResolutionOutcome> {
    for (const source of SOURCES) {
      const candidates = [
        ...new Set(hints.filter((hint) => hint.source === source).map((hint) => hint.path)),
      ];
      if (candidates.length === 0) continue;
      const discoveries = await Promise.all(
        candidates.map((candidate) => this.#root(candidate)),
      );
      const roots = [
        ...new Set(
          discoveries
            .filter(
              (outcome): outcome is Extract<RepositoryDiscoveryOutcome, { kind: "repository" }> =>
                outcome.kind === "repository",
            )
            .map((outcome) => outcome.root),
        ),
      ].sort();
      if (roots.length > 1) return { kind: "ambiguous", roots };
      const indeterminate = discoveries.find((outcome) => outcome.kind === "indeterminate");
      if (indeterminate?.kind === "indeterminate") {
        return { kind: "unavailable", reason: indeterminate.reason };
      }
      const root = roots[0];
      if (!root) continue;

      try {
        return { kind: "resolved", metadata: await this.#repositoryMetadata(root) };
      } catch (error) {
        return {
          kind: "unavailable",
          reason: error instanceof Error ? error.message : "metadata lookup failed",
          root,
        };
      }
    }
    return { kind: "no-repository" };
  }

  invalidatePath(path: string): void {
    this.#pathCache.delete(path);
  }

  /** Evicts the volatile local snapshot while retaining reusable PR query data. */
  invalidateLocalIdentity(root: string): void {
    this.#metadataCache.delete(root);
  }

  /** Explicit refresh invalidates both local identity and its last PR query. */
  invalidateRepository(root: string): void {
    this.invalidateLocalIdentity(root);
    this.#metadata.invalidate?.(root);
  }

  clear(): void {
    this.#pathCache.clear();
    this.#metadataCache.clear();
    this.#metadata.clear?.();
  }

  async #root(candidate: string): Promise<RepositoryDiscoveryOutcome> {
    const cached = this.#pathCache.get(candidate);
    if (cached) return cached.value;
    let outcome: RepositoryDiscoveryOutcome;
    try {
      outcome = await this.#repositories.findRoot(candidate);
    } catch (error) {
      return {
        kind: "indeterminate",
        reason: error instanceof Error ? error.message : "repository discovery failed",
      };
    }
    if (outcome.kind !== "indeterminate") {
      this.#pathCache.set(
        candidate,
        outcome,
        outcome.kind === "repository" ? "positive" : "negative",
      );
    }
    return outcome;
  }

  async #repositoryMetadata(root: string): Promise<RepositoryMetadata> {
    const cached = this.#metadataCache.get(root);
    if (cached) return cached.value;
    const loaded = await this.#metadata.load(root);
    this.#metadataCache.set(root, loaded.metadata, loaded.polarity);
    return loaded.metadata;
  }
}
