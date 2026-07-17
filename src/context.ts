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
  load(
    root: string,
    onLocalIdentity?: (result: MetadataLoadResult) => void,
  ): Promise<MetadataLoadResult>;
  /** Invalidates all network-derived data for an explicit refresh. */
  invalidate?(root: string): void;
  /** Invalidates the PR query for the root's current local identity. */
  invalidatePullRequest?(root: string): Promise<void> | void;
  clear?(): void;
}

export interface ContextReconciliationOptions {
  /** Candidate paths whose associated PR query was explicitly mutated. */
  readonly pullRequestPaths?: readonly string[];
  /** Monotonic event sequence used to reject older cache invalidations. */
  readonly sequence?: number;
  /** Publishes fresh local identity before a potentially slow PR query finishes. */
  readonly onLocalIdentity?: (metadata: RepositoryMetadata) => void;
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

  async load(
    root: string,
    onLocalIdentity?: (result: MetadataLoadResult) => void,
  ): Promise<MetadataLoadResult> {
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
    onLocalIdentity?.({
      metadata: { ...identity, degraded: ["github-pending"] },
      polarity: "negative",
    });

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

  async invalidatePullRequest(root: string): Promise<void> {
    const identity = await this.#repositories.readIdentity(root);
    if (!identity.github || identity.ref.detached) return;
    const query = {
      repository: identity.github,
      branch: identity.ref.name,
    } satisfies PullRequestQuery;
    if (isValidPullRequestQuery(query)) this.#pullRequests.invalidate(query);
  }

  invalidate(_root: string): void {
    // Identity is read after invalidation, so explicit refresh clears every
    // bounded query entry even if the branch changed while cached.
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

interface DiscoveredHint {
  readonly hint: PathHint;
  readonly outcome: RepositoryDiscoveryOutcome;
}

const RECONCILIATION_SEQUENCE_MAX_ENTRIES = 128;

/** Resolves one unconflicted root from the strongest available evidence tier. */
export class ContextCore {
  readonly #repositories: RepositoryInspector;
  readonly #metadata: RepositoryMetadataLoader;
  readonly #pathCache: BoundedTtlCache<string, RepositoryDiscoveryOutcome>;
  readonly #metadataCache: BoundedTtlCache<string, RepositoryMetadata>;
  readonly #reconciliationSequences = new Map<string, number>();
  #pathEpoch = 0;
  #metadataEpoch = 0;

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
      const sourceHints = this.#uniqueHints(hints.filter((hint) => hint.source === source));
      if (sourceHints.length === 0) continue;
      const discovered = await Promise.all(
        sourceHints.map(async (hint) => ({ hint, outcome: await this.#root(hint.path) })),
      );
      const outcome = await this.#outcomeAtTier(discovered);
      if (outcome) return outcome;
    }
    return { kind: "no-repository" };
  }

  /**
   * Re-discovers every affected path, evicts local identity for every discovered
   * root, then resolves the strongest tier. Lower-tier effects are reconciled
   * even when a worktree destination supplies the selected context.
   */
  async reconcile(
    hints: readonly PathHint[],
    options: ContextReconciliationOptions = {},
  ): Promise<ResolutionOutcome> {
    const uniqueHints = this.#uniqueHints(hints);
    for (const hint of uniqueHints) this.invalidatePath(hint.path);
    const discovered = await Promise.all(
      uniqueHints.map(async (hint) => ({ hint, outcome: await this.#root(hint.path) })),
    );
    const pullRequestPaths = new Set(options.pullRequestPaths ?? []);
    const roots = new Map<string, boolean>();
    for (const entry of discovered) {
      if (entry.outcome.kind !== "repository") continue;
      roots.set(
        entry.outcome.root,
        (roots.get(entry.outcome.root) ?? false) || pullRequestPaths.has(entry.hint.path),
      );
    }
    for (const [root, refreshPullRequest] of roots) {
      if (!this.#acceptReconciliation(root, options.sequence)) continue;
      this.#invalidateLocal(root);
      if (refreshPullRequest) {
        if (this.#metadata.invalidatePullRequest) {
          await this.#metadata.invalidatePullRequest(root);
        } else {
          this.#metadata.invalidate?.(root);
        }
      }
    }

    for (const source of SOURCES) {
      const outcome = await this.#outcomeAtTier(
        discovered.filter((entry) => entry.hint.source === source),
        options.onLocalIdentity,
      );
      if (outcome) return outcome;
    }
    return { kind: "no-repository" };
  }

  invalidatePath(path: string): void {
    this.#pathEpoch += 1;
    this.#pathCache.delete(path);
  }

  /** Evicts the volatile local snapshot while retaining reusable PR query data. */
  invalidateLocalIdentity(root: string): void {
    this.#invalidateLocal(root);
  }

  /** Explicit refresh invalidates both local identity and all bounded PR data. */
  invalidateRepository(root: string): void {
    this.#invalidateLocal(root);
    this.#metadata.invalidate?.(root);
  }

  clear(): void {
    this.#pathEpoch += 1;
    this.#metadataEpoch += 1;
    this.#pathCache.clear();
    this.#metadataCache.clear();
    this.#reconciliationSequences.clear();
    this.#metadata.clear?.();
  }

  async #outcomeAtTier(
    discovered: readonly DiscoveredHint[],
    onLocalIdentity?: (metadata: RepositoryMetadata) => void,
  ): Promise<ResolutionOutcome | undefined> {
    if (discovered.length === 0) return undefined;
    const roots = [
      ...new Set(
        discovered
          .filter(
            (entry): entry is DiscoveredHint & {
              readonly outcome: Extract<RepositoryDiscoveryOutcome, { kind: "repository" }>;
            } => entry.outcome.kind === "repository",
          )
          .map((entry) => entry.outcome.root),
      ),
    ].sort();
    if (roots.length > 1) return { kind: "ambiguous", roots };
    const indeterminate = discovered.find((entry) => entry.outcome.kind === "indeterminate");
    if (indeterminate?.outcome.kind === "indeterminate") {
      return { kind: "unavailable", reason: indeterminate.outcome.reason };
    }
    const root = roots[0];
    if (!root) return undefined;

    try {
      return {
        kind: "resolved",
        metadata: await this.#repositoryMetadata(root, onLocalIdentity),
      };
    } catch (error) {
      return {
        kind: "unavailable",
        reason: error instanceof Error ? error.message : "metadata lookup failed",
        root,
      };
    }
  }

  #uniqueHints(hints: readonly PathHint[]): PathHint[] {
    const unique = new Map<string, PathHint>();
    for (const hint of hints) unique.set(`${hint.source}\0${hint.path}`, hint);
    return [...unique.values()];
  }

  #acceptReconciliation(root: string, sequence: number | undefined): boolean {
    if (sequence === undefined) return true;
    const latest = this.#reconciliationSequences.get(root);
    if (latest !== undefined && sequence < latest) return false;
    this.#reconciliationSequences.delete(root);
    this.#reconciliationSequences.set(root, sequence);
    while (this.#reconciliationSequences.size > RECONCILIATION_SEQUENCE_MAX_ENTRIES) {
      const oldest = this.#reconciliationSequences.keys().next().value;
      if (oldest === undefined) break;
      this.#reconciliationSequences.delete(oldest);
    }
    return true;
  }

  #invalidateLocal(root: string): void {
    this.#metadataEpoch += 1;
    this.#metadataCache.delete(root);
  }

  async #root(candidate: string): Promise<RepositoryDiscoveryOutcome> {
    const cached = this.#pathCache.get(candidate);
    if (cached) return cached.value;
    const epoch = this.#pathEpoch;
    let outcome: RepositoryDiscoveryOutcome;
    try {
      outcome = await this.#repositories.findRoot(candidate);
    } catch (error) {
      return {
        kind: "indeterminate",
        reason: error instanceof Error ? error.message : "repository discovery failed",
      };
    }
    // A discovery started before a newer event may satisfy its own caller, but
    // it cannot restore a path mapping invalidated while it was in flight.
    if (outcome.kind !== "indeterminate" && epoch === this.#pathEpoch) {
      this.#pathCache.set(
        candidate,
        outcome,
        outcome.kind === "repository" ? "positive" : "negative",
      );
    }
    return outcome;
  }

  async #repositoryMetadata(
    root: string,
    onLocalIdentity?: (metadata: RepositoryMetadata) => void,
  ): Promise<RepositoryMetadata> {
    const cached = this.#metadataCache.get(root);
    if (cached) return cached.value;
    const epoch = this.#metadataEpoch;
    const loaded = await this.#metadata.load(root, (local) => {
      if (epoch === this.#metadataEpoch) onLocalIdentity?.(local.metadata);
    });
    // An older async load may satisfy its caller but cannot repopulate a cache
    // invalidated by a newer event or lifecycle cleanup.
    if (epoch === this.#metadataEpoch) {
      this.#metadataCache.set(root, loaded.metadata, loaded.polarity);
    }
    return loaded.metadata;
  }
}
