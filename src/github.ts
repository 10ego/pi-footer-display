import type { CommandRunner } from "./process.js";
import type { GitHubRepository, PullRequest } from "./types.js";

export interface PullRequestLookup {
  findOpenPullRequest(
    repository: GitHubRepository,
    branch: string,
  ): Promise<PullRequest | undefined>;
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
