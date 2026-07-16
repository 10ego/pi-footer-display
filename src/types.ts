export type DiscoverySource = "file" | "bash" | "fallback";

export interface PathHint {
  readonly path: string;
  readonly source: DiscoverySource;
}

export interface GitHubRepository {
  readonly owner: string;
  readonly repo: string;
}

export interface GitReference {
  readonly name: string;
  readonly detached: boolean;
}

export interface LocalRepositoryIdentity {
  readonly root: string;
  readonly name: string;
  readonly ref: GitReference;
  readonly github?: GitHubRepository;
}

export interface PullRequest {
  readonly number: number;
  readonly state: string;
  readonly isDraft: boolean;
  readonly url: string;
}

export interface RepositoryMetadata extends LocalRepositoryIdentity {
  readonly pullRequest?: PullRequest;
  readonly degraded: readonly string[];
}

export type ResolutionOutcome =
  | { readonly kind: "resolved"; readonly metadata: RepositoryMetadata }
  | { readonly kind: "ambiguous"; readonly roots: readonly string[] }
  | { readonly kind: "unavailable"; readonly reason: string }
  | {
      readonly kind: "stale";
      readonly reason: string;
      readonly previous?: RepositoryMetadata;
    };

export type SessionMode = "auto" | "pinned";

export interface FooterSessionState {
  readonly mode: SessionMode;
  readonly pinnedRoot?: string;
  readonly startedAt: number;
  readonly generation: number;
  readonly ownsStatus: boolean;
  readonly outcome: ResolutionOutcome;
}
