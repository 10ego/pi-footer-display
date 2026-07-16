import { BoundedTtlCache, type CachePolarity } from "./cache.js";
import type { PullRequestLookup } from "./github.js";
import type { RepositoryInspector } from "./git.js";
import type {
  DiscoverySource,
  PathHint,
  RepositoryMetadata,
  ResolutionOutcome,
} from "./types.js";

export interface MetadataLoadResult {
  readonly metadata: RepositoryMetadata;
  readonly polarity: CachePolarity;
}

export interface RepositoryMetadataLoader {
  load(root: string): Promise<MetadataLoadResult>;
}

export class DefaultRepositoryMetadataLoader implements RepositoryMetadataLoader {
  readonly #repositories: RepositoryInspector;
  readonly #pullRequests: PullRequestLookup;

  constructor(repositories: RepositoryInspector, pullRequests: PullRequestLookup) {
    this.#repositories = repositories;
    this.#pullRequests = pullRequests;
  }

  async load(root: string): Promise<MetadataLoadResult> {
    const identity = await this.#repositories.readIdentity(root);
    if (!identity.github) {
      return {
        metadata: { ...identity, degraded: ["no-github-remote"] },
        polarity: "positive",
      };
    }
    if (identity.ref.detached) {
      return {
        metadata: { ...identity, degraded: ["detached-head"] },
        polarity: "positive",
      };
    }

    try {
      const pullRequest = await this.#pullRequests.findOpenPullRequest(
        identity.github,
        identity.ref.name,
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
}

export interface ContextCoreOptions {
  readonly repositories: RepositoryInspector;
  readonly metadata: RepositoryMetadataLoader;
  readonly pathCache?: BoundedTtlCache<string, string | null>;
  readonly metadataCache?: BoundedTtlCache<string, RepositoryMetadata>;
}

const SOURCES: readonly DiscoverySource[] = ["file", "bash", "fallback"];

/** Resolves one unconflicted root from the strongest available evidence tier. */
export class ContextCore {
  readonly #repositories: RepositoryInspector;
  readonly #metadata: RepositoryMetadataLoader;
  readonly #pathCache: BoundedTtlCache<string, string | null>;
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
      const roots = [...new Set((await Promise.all(candidates.map((candidate) => this.#root(candidate)))).filter(
        (root): root is string => root !== null,
      ))].sort();
      if (roots.length === 0) continue;
      if (roots.length > 1) return { kind: "ambiguous", roots };
      const root = roots[0];
      if (!root) continue;

      try {
        return { kind: "resolved", metadata: await this.#repositoryMetadata(root) };
      } catch (error) {
        return {
          kind: "unavailable",
          reason: error instanceof Error ? error.message : "metadata lookup failed",
        };
      }
    }
    return { kind: "unavailable", reason: "no repository found" };
  }

  invalidatePath(path: string): void {
    this.#pathCache.delete(path);
  }

  invalidateRepository(root: string): void {
    this.#metadataCache.delete(root);
  }

  clear(): void {
    this.#pathCache.clear();
    this.#metadataCache.clear();
  }

  async #root(candidate: string): Promise<string | null> {
    const cached = this.#pathCache.get(candidate);
    if (cached) return cached.value;
    const root = await this.#repositories.findRoot(candidate);
    this.#pathCache.set(candidate, root, root ? "positive" : "negative");
    return root;
  }

  async #repositoryMetadata(root: string): Promise<RepositoryMetadata> {
    const cached = this.#metadataCache.get(root);
    if (cached) return cached.value;
    const loaded = await this.#metadata.load(root);
    this.#metadataCache.set(root, loaded.metadata, loaded.polarity);
    return loaded.metadata;
  }
}
