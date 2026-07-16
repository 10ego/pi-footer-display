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

function asPullRequest(value: GhPullRequest): PullRequest | undefined {
  if (
    typeof value.number !== "number" ||
    typeof value.state !== "string" ||
    typeof value.isDraft !== "boolean" ||
    typeof value.url !== "string"
  ) {
    return undefined;
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
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
    return asPullRequest(parsed[0] as GhPullRequest);
  }
}
