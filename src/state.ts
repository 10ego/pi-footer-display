import type {
  FooterSessionState,
  RepositoryMetadata,
  ResolutionOutcome,
} from "./types.js";

const INITIAL_OUTCOME: ResolutionOutcome = {
  kind: "unavailable",
  reason: "not resolved",
};

/** Owns session transitions and rejects commits from superseded async work. */
export class FooterSessionController {
  #state: FooterSessionState;

  constructor(startedAt = Date.now()) {
    this.#state = {
      mode: "auto",
      startedAt,
      generation: 0,
      ownsStatus: false,
      outcome: INITIAL_OUTCOME,
    };
  }

  get state(): FooterSessionState {
    return this.#state;
  }

  beginRefresh(): number {
    return this.#advance();
  }

  pin(root: string): number {
    const generation = this.#advance();
    this.#state = { ...this.#state, mode: "pinned", pinnedRoot: root };
    return generation;
  }

  unpin(): number {
    const generation = this.#advance();
    const { pinnedRoot: _removed, ...withoutPin } = this.#state;
    this.#state = { ...withoutPin, mode: "auto" };
    return generation;
  }

  /** Returns false rather than publishing when a newer generation exists. */
  commit(generation: number, outcome: ResolutionOutcome): boolean {
    if (generation !== this.#state.generation) return false;
    this.#state = { ...this.#state, outcome, ownsStatus: true };
    return true;
  }

  markStale(reason: string): number {
    const previous =
      this.#state.outcome.kind === "resolved"
        ? this.#state.outcome.metadata
        : this.#state.outcome.kind === "stale"
          ? this.#state.outcome.previous
          : undefined;
    const generation = this.#advance();
    this.#state = {
      ...this.#state,
      outcome: {
        kind: "stale",
        reason,
        ...(previous ? { previous } : {}),
      },
    };
    return generation;
  }

  cleanup(): void {
    this.#advance();
    this.#state = { ...this.#state, ownsStatus: false };
  }

  async resolveAndCommit(
    work: () => Promise<ResolutionOutcome>,
  ): Promise<boolean> {
    const generation = this.beginRefresh();
    const outcome = await work();
    return this.commit(generation, outcome);
  }

  #advance(): number {
    const generation = this.#state.generation + 1;
    this.#state = { ...this.#state, generation };
    return generation;
  }
}

export function previousMetadata(
  outcome: ResolutionOutcome,
): RepositoryMetadata | undefined {
  if (outcome.kind === "resolved") return outcome.metadata;
  if (outcome.kind === "stale") return outcome.previous;
  return undefined;
}
