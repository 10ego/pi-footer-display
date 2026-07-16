import path from "node:path";
import { realpath, stat } from "node:fs/promises";
import { ProcessExecutionError, type CommandRunner } from "./process.js";
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

export type RepositoryDiscoveryOutcome =
  | { readonly kind: "repository"; readonly root: string }
  | { readonly kind: "not-repository" }
  | { readonly kind: "indeterminate"; readonly reason: string };

export interface RepositoryInspector {
  findRoot(candidatePath: string): Promise<RepositoryDiscoveryOutcome>;
  validateRoot(candidateRoot: string): Promise<RepositoryDiscoveryOutcome>;
  readIdentity(root: string): Promise<LocalRepositoryIdentity>;
}

function cleanOutput(value: string): string {
  return value.trim();
}

function errorReason(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function isMissingPathError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = (error as { readonly code?: unknown }).code;
  return code === "ENOENT" || code === "ENOTDIR";
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
  // Reject encoded separators and URL-shaped lookalikes before passing a slug to gh.
  if (
    !/^(?!-)[A-Za-z0-9-]{1,39}(?<!-)$/u.test(owner) ||
    !/^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/u.test(repo)
  ) {
    return undefined;
  }
  return { owner, repo };
}

export class GitRepositoryInspector implements RepositoryInspector {
  readonly #runner: CommandRunner;
  readonly #fs: PathFileSystem;

  constructor(runner: CommandRunner, fs: PathFileSystem = nodePathFileSystem) {
    this.#runner = runner;
    this.#fs = fs;
  }

  async findRoot(candidatePath: string): Promise<RepositoryDiscoveryOutcome> {
    let directory: string;
    try {
      directory = await this.#candidateDirectory(candidatePath);
    } catch (error) {
      return { kind: "indeterminate", reason: errorReason(error, "path lookup failed") };
    }
    return await this.#discoverDirectory(directory);
  }

  async validateRoot(candidateRoot: string): Promise<RepositoryDiscoveryOutcome> {
    try {
      const info = await this.#fs.stat(candidateRoot);
      if (!info.isDirectory()) return { kind: "not-repository" };
    } catch (error) {
      if (isMissingPathError(error)) return { kind: "not-repository" };
      return { kind: "indeterminate", reason: errorReason(error, "path validation failed") };
    }
    return await this.#discoverDirectory(candidateRoot);
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

  async #discoverDirectory(directory: string): Promise<RepositoryDiscoveryOutcome> {
    let result;
    try {
      result = await this.#runner.run("git", [
        "-C",
        directory,
        "rev-parse",
        "--show-toplevel",
      ]);
    } catch (error) {
      if (
        error instanceof ProcessExecutionError &&
        error.kind === "exit" &&
        error.exitCode === 128
      ) {
        return { kind: "not-repository" };
      }
      return { kind: "indeterminate", reason: errorReason(error, "git lookup failed") };
    }

    const root = cleanOutput(result.stdout);
    if (!path.isAbsolute(root)) {
      return { kind: "indeterminate", reason: "git returned a non-absolute repository root" };
    }
    try {
      return { kind: "repository", root: await this.#fs.realpath(root) };
    } catch (error) {
      return { kind: "indeterminate", reason: errorReason(error, "repository realpath failed") };
    }
  }

  async #candidateDirectory(candidatePath: string): Promise<string> {
    try {
      const info = await this.#fs.stat(candidatePath);
      return info.isDirectory() ? candidatePath : path.dirname(candidatePath);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      // Tool calls happen before execution, so a write target may have several
      // not-yet-created parent directories. Walk to the nearest existing directory.
      let current = path.dirname(candidatePath);
      while (true) {
        try {
          const info = await this.#fs.stat(current);
          if (info.isDirectory()) return current;
        } catch (ancestorError) {
          if (!isMissingPathError(ancestorError)) throw ancestorError;
        }
        const parent = path.dirname(current);
        if (parent === current) return current;
        current = parent;
      }
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
