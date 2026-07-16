import path from "node:path";
import { realpath, stat } from "node:fs/promises";
import type { CommandRunner } from "./process.js";
import type {
  GitHubRepository,
  GitReference,
  LocalRepositoryIdentity,
} from "./types.js";

export interface PathFileSystem {
  stat(path: string): Promise<{ isDirectory(): boolean }>;
  realpath(path: string): Promise<string>;
}

export const nodePathFileSystem: PathFileSystem = { stat, realpath };

export interface RepositoryInspector {
  findRoot(candidatePath: string): Promise<string | null>;
  readIdentity(root: string): Promise<LocalRepositoryIdentity>;
}

function cleanOutput(value: string): string {
  return value.trim();
}

/** Parses common HTTPS, SSH, SCP-like, and git GitHub remote URL forms. */
export function parseGitHubRemote(remote: string): GitHubRepository | undefined {
  const value = remote.trim();
  let pathname: string | undefined;

  try {
    const url = new URL(value);
    if (
      ["https:", "http:", "ssh:", "git:"].includes(url.protocol) &&
      url.hostname.toLowerCase() === "github.com"
    ) {
      pathname = url.pathname;
    }
  } catch {
    // SCP-like remotes are handled below; other invalid URLs remain unsupported.
  }

  if (!pathname) {
    const scp = /^(?:[^@\s]+@)?github\.com:([^\s]+)$/iu.exec(value);
    pathname = scp?.[1];
  }
  if (!pathname) return undefined;
  const parts = pathname.replace(/^\/+|\/+$/gu, "").split("/");
  if (parts.length !== 2) return undefined;
  const owner = parts[0];
  const repoPart = parts[1];
  if (!owner || !repoPart) return undefined;
  const repo = repoPart.replace(/\.git$/iu, "");
  if (!repo) return undefined;
  return { owner, repo };
}

export class GitRepositoryInspector implements RepositoryInspector {
  readonly #runner: CommandRunner;
  readonly #fs: PathFileSystem;

  constructor(runner: CommandRunner, fs: PathFileSystem = nodePathFileSystem) {
    this.#runner = runner;
    this.#fs = fs;
  }

  async findRoot(candidatePath: string): Promise<string | null> {
    const directory = await this.#candidateDirectory(candidatePath);
    try {
      const result = await this.#runner.run("git", [
        "-C",
        directory,
        "rev-parse",
        "--show-toplevel",
      ]);
      const root = cleanOutput(result.stdout);
      if (!path.isAbsolute(root)) return null;
      return await this.#fs.realpath(root);
    } catch {
      return null;
    }
  }

  async readIdentity(root: string): Promise<LocalRepositoryIdentity> {
    const canonicalRoot = await this.#fs.realpath(root);
    const ref = await this.#readReference(canonicalRoot);
    const github = await this.#readGitHubRemote(canonicalRoot);
    return {
      root: canonicalRoot,
      name: github?.repo ?? path.basename(canonicalRoot),
      ref,
      ...(github ? { github } : {}),
    };
  }

  async #candidateDirectory(candidatePath: string): Promise<string> {
    try {
      const info = await this.#fs.stat(candidatePath);
      return info.isDirectory() ? candidatePath : path.dirname(candidatePath);
    } catch {
      // File-tool paths often identify a file that is about to be created.
      return path.dirname(candidatePath);
    }
  }

  async #readReference(root: string): Promise<GitReference> {
    try {
      const branch = cleanOutput(
        (await this.#runner.run("git", ["-C", root, "symbolic-ref", "--quiet", "--short", "HEAD"]))
          .stdout,
      );
      if (branch) return { name: branch, detached: false };
    } catch {
      // A failed symbolic-ref is expected for detached HEAD.
    }

    const shortHead = cleanOutput(
      (await this.#runner.run("git", ["-C", root, "rev-parse", "--short", "HEAD"]))
        .stdout,
    );
    return { name: shortHead, detached: true };
  }

  async #readGitHubRemote(root: string): Promise<GitHubRepository | undefined> {
    const remoteNames = await this.#remoteNames(root);
    const ordered = ["origin", ...remoteNames.filter((name) => name !== "origin")];
    for (const name of ordered) {
      try {
        const value = cleanOutput(
          (await this.#runner.run("git", ["-C", root, "config", "--get", `remote.${name}.url`]))
            .stdout,
        );
        const parsed = parseGitHubRemote(value);
        if (parsed) return parsed;
      } catch {
        // Missing or unreadable remotes are skipped.
      }
    }
    return undefined;
  }

  async #remoteNames(root: string): Promise<string[]> {
    try {
      return cleanOutput((await this.#runner.run("git", ["-C", root, "remote"])).stdout)
        .split(/\r?\n/u)
        .map((name) => name.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }
}
