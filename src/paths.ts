import path from "node:path";
import type { PathHint } from "./types.js";

// Pi 0.80.7's built-in file-oriented ToolCallEvent variants all expose `path`.
const FILE_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);
const DIRECT_PATH_COMMANDS = new Set([
  "cat",
  "file",
  "head",
  "less",
  "ls",
  "readlink",
  "realpath",
  "stat",
  "tail",
  "wc",
]);
const PROGRAM_THEN_PATH_COMMANDS = new Set(["grep", "rg", "sed"]);
const PATH_KEYS = new Set(["path", "filePath", "file_path"]);
const GIT_REMOTE_MUTATIONS = new Set([
  "add",
  "prune",
  "remove",
  "rename",
  "set-branches",
  "set-head",
  "set-url",
  "update",
]);
const GIT_WORKTREE_MUTATIONS = new Set([
  "lock",
  "move",
  "prune",
  "remove",
  "repair",
  "unlock",
]);
const GH_PR_MUTATIONS = new Set([
  "close",
  "create",
  "edit",
  "merge",
  "ready",
  "reopen",
  "update-branch",
]);

export type RepositoryEffectKind =
  | "git-mutation"
  | "github-pr-mutation"
  | "worktree-add";

/** A deterministic repository-affecting operation staged until tool_result. */
export interface RepositoryEffect {
  readonly kind: RepositoryEffectKind;
  readonly rootPath: string;
  readonly destinationPath?: string;
}

export interface ToolCallInference {
  readonly hints: readonly PathHint[];
  readonly effects: readonly RepositoryEffect[];
}

function toolBasename(toolName: string): string {
  return toolName.split(/[.:/]/u).at(-1) ?? toolName;
}

function stringsAtKnownKeys(input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const record = input as Record<string, unknown>;
  const values: string[] = [];
  for (const key of PATH_KEYS) {
    const value = record[key];
    if (typeof value === "string") values.push(value);
  }
  const paths = record.paths;
  if (Array.isArray(paths)) {
    for (const value of paths) if (typeof value === "string") values.push(value);
  }
  return values;
}

/** File-tool paths are strong evidence and may be relative to the tool cwd. */
export function extractFileToolPaths(
  toolName: string,
  input: unknown,
  cwd: string,
): PathHint[] {
  if (!FILE_TOOLS.has(toolBasename(toolName))) return [];
  return [...new Set(stringsAtKnownKeys(input))]
    .filter((value) => value.length > 0 && !value.includes("\0"))
    .map((value) => ({
      path: path.resolve(cwd, value),
      source: "file" as const,
    }));
}

/**
 * Tokenize only shell words whose value is deterministic without expansion.
 * Quotes may preserve literal metacharacters; shell operators and unquoted
 * expansions, globs, comments, brace syntax, and tilde expansion are rejected.
 */
function tokenizeLiteralCommand(command: string): string[] | undefined {
  const words: string[] = [];
  let word = "";
  let wordStarted = false;
  let quote: "'" | '"' | undefined;

  const push = (): void => {
    if (wordStarted) words.push(word);
    word = "";
    wordStarted = false;
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === undefined) continue;
    if (char === "\0") return undefined;

    if (quote) {
      if (char === quote) {
        quote = undefined;
        wordStarted = true;
        continue;
      }
      if (char === "\n" || char === "\r" || char === "\\") return undefined;
      if (quote === '"' && (char === "$" || char === "`")) return undefined;
      word += char;
      wordStarted = true;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      wordStarted = true;
      continue;
    }
    if (char === "\n" || char === "\r" || char === "\\") return undefined;
    if (/\s/u.test(char)) {
      push();
      continue;
    }
    if (char === "&" && command[index + 1] === "&") {
      push();
      words.push("&&");
      index += 1;
      continue;
    }
    if ("&;$`|<>(){}!".includes(char)) return undefined;
    if ("*?[".includes(char)) return undefined;
    if (char === "#") return undefined;
    if (char === "~" && !wordStarted) return undefined;
    word += char;
    wordStarted = true;
  }
  if (quote) return undefined;
  push();
  return words;
}

function executableName(value: string): string {
  return path.basename(value);
}

function oneUnambiguousAbsolute(values: readonly string[]): string[] {
  const absolute = [...new Set(values.filter((value) => path.isAbsolute(value)))];
  return absolute.length === 1 ? absolute : [];
}

/** Return operands only when no option can consume a value and masquerade as a path. */
function optionFreeOperands(args: readonly string[]): readonly string[] | undefined {
  if (args[0] === "--") return args.slice(1);
  return args.some((value) => value.startsWith("-")) ? undefined : args;
}

function directPaths(words: readonly string[]): string[] {
  const executable = executableName(words[0] ?? "");
  const args = words.slice(1);

  if (DIRECT_PATH_COMMANDS.has(executable)) {
    const operands = optionFreeOperands(args);
    return operands ? oneUnambiguousAbsolute(operands) : [];
  }

  if (PROGRAM_THEN_PATH_COMMANDS.has(executable)) {
    const operands = optionFreeOperands(args);
    // grep/rg patterns and sed programs are not file operands, even when absolute-looking.
    return operands ? oneUnambiguousAbsolute(operands.slice(1)) : [];
  }

  if (executable === "find") {
    const operands: string[] = [];
    for (const value of args) {
      if (value.startsWith("-") || value === "!" || value === "(" || value === ")") break;
      operands.push(value);
    }
    return oneUnambiguousAbsolute(operands);
  }

  return [];
}

function literalPath(value: string): boolean {
  return value.length > 0 && !value.includes("\0") && !value.startsWith("-");
}

function resolveLiteralPath(value: string, cwd: string | undefined): string | undefined {
  if (!literalPath(value)) return undefined;
  if (path.isAbsolute(value)) return path.resolve(value);
  return cwd === undefined ? undefined : path.resolve(cwd, value);
}

interface ParsedShellCommand {
  readonly words: readonly string[];
  readonly cwd: string | undefined;
  readonly changedDirectory: boolean;
}

function parseShellCommand(
  command: string,
  cwd: string | undefined,
): ParsedShellCommand | undefined {
  const words = tokenizeLiteralCommand(command.trim());
  if (!words || words.length === 0) return undefined;

  const conjunction = words.indexOf("&&");
  if (conjunction === -1) {
    return { words, cwd, changedDirectory: false };
  }
  if (
    conjunction !== 2 ||
    words.indexOf("&&", conjunction + 1) !== -1 ||
    words[0] !== "cd"
  ) {
    return undefined;
  }

  const changedCwd = resolveLiteralPath(words[1] ?? "", cwd);
  const tail = words.slice(3);
  if (
    !changedCwd ||
    tail.length === 0 ||
    executableName(tail[0] ?? "") === "cd"
  ) {
    return undefined;
  }
  return { words: tail, cwd: changedCwd, changedDirectory: true };
}

interface ParsedGitCommand {
  readonly rootPath: string;
  readonly subcommand: string | undefined;
  readonly args: readonly string[];
  readonly explicitRoot: boolean;
}

function parseGitCommand(command: ParsedShellCommand): ParsedGitCommand | undefined {
  if (executableName(command.words[0] ?? "") !== "git") return undefined;
  let args = command.words.slice(1);
  let rootPath = command.cwd;
  let explicitRoot = command.changedDirectory;

  if (args[0] === "-C") {
    // A leading cd plus git -C, repeated -C, and all other global options are
    // intentionally unsupported because they introduce another cwd candidate.
    if (command.changedDirectory || args.length < 2) return undefined;
    rootPath = resolveLiteralPath(args[1] ?? "", command.cwd);
    if (!rootPath) return undefined;
    explicitRoot = true;
    args = args.slice(2);
  }
  if (args.includes("-C")) return undefined;
  const subcommand = args[0];
  if (subcommand?.startsWith("-")) return undefined;
  if (!rootPath) return undefined;
  return {
    rootPath,
    subcommand,
    args: subcommand === undefined ? [] : args.slice(1),
    explicitRoot,
  };
}

function isGitMutation(command: ParsedGitCommand): boolean {
  const { subcommand, args } = command;
  if ((subcommand === "checkout" || subcommand === "switch") && args.length > 0) {
    return true;
  }
  if (
    subcommand === "branch" &&
    args.some((value) => ["-m", "-M", "--move"].includes(value))
  ) {
    return true;
  }
  if (subcommand === "remote" && GIT_REMOTE_MUTATIONS.has(args[0] ?? "")) {
    return true;
  }
  if (subcommand === "config") {
    const remoteUrl = (value: string | undefined): boolean =>
      value !== undefined && /^remote\.[^.]+\.url$/u.test(value);
    if (args.length === 2 && remoteUrl(args[0])) return true;
    if (
      ["--add", "--replace-all"].includes(args[0] ?? "") &&
      args.length >= 3 &&
      remoteUrl(args[1])
    ) {
      return true;
    }
    return (
      ["--unset", "--unset-all"].includes(args[0] ?? "") &&
      args.length >= 2 &&
      remoteUrl(args[1])
    );
  }
  if (subcommand === "symbolic-ref" && args[0] === "HEAD" && args.length >= 2) {
    return true;
  }
  return subcommand === "worktree" && GIT_WORKTREE_MUTATIONS.has(args[0] ?? "");
}

function inferGitCommand(command: ParsedShellCommand): ToolCallInference | undefined {
  const git = parseGitCommand(command);
  if (!git) return undefined;
  const rootHint = { path: git.rootPath, source: "bash" as const };

  if (git.subcommand === "worktree" && git.args[0] === "add") {
    // Exact supported shape: worktree add <destination> [<commit-ish>].
    if (
      git.args.length < 2 ||
      git.args.length > 3 ||
      git.args.slice(1).some((value) => !literalPath(value))
    ) {
      return { hints: [], effects: [] };
    }
    const destinationPath = resolveLiteralPath(git.args[1] ?? "", git.rootPath);
    if (!destinationPath) return { hints: [], effects: [] };
    return {
      // An already-existing destination is stronger than the command's source cwd.
      hints: [
        { path: destinationPath, source: "file" },
        rootHint,
      ],
      effects: [{
        kind: "worktree-add",
        rootPath: git.rootPath,
        destinationPath,
      }],
    };
  }

  if (isGitMutation(git)) {
    return {
      hints: [rootHint],
      effects: [{ kind: "git-mutation", rootPath: git.rootPath }],
    };
  }
  return git.explicitRoot ? { hints: [rootHint], effects: [] } : undefined;
}

function hasUnsupportedGhRepositorySelector(args: readonly string[]): boolean {
  return args.some(
    (value) =>
      value.startsWith("-R") ||
      value === "--repo" ||
      value.startsWith("--repo="),
  );
}

function inferGhCommand(command: ParsedShellCommand): ToolCallInference | undefined {
  if (executableName(command.words[0] ?? "") !== "gh" || !command.cwd) return undefined;
  const args = command.words.slice(1);
  if (
    args[0] !== "pr" ||
    args.length < 2 ||
    hasUnsupportedGhRepositorySelector(args)
  ) {
    return undefined;
  }
  const action = args[1] ?? "";
  const rootHint = { path: command.cwd, source: "bash" as const };
  if (action === "checkout") {
    return {
      hints: [rootHint],
      effects: [{ kind: "git-mutation", rootPath: command.cwd }],
    };
  }
  if (!GH_PR_MUTATIONS.has(action)) return undefined;
  return {
    hints: [rootHint],
    effects: [{ kind: "github-pr-mutation", rootPath: command.cwd }],
  };
}

/**
 * Infers paths and post-execution effects from one narrowly supported literal
 * shell command. Relative cwd literals are anchored only to the event's cwd.
 */
export function inferBashCommand(
  command: string,
  cwd?: string,
): ToolCallInference {
  const parsed = parseShellCommand(command, cwd);
  if (!parsed) return { hints: [], effects: [] };

  const executable = executableName(parsed.words[0] ?? "");
  const git = inferGitCommand(parsed);
  if (git) return git;
  if (executable === "git") return { hints: [], effects: [] };
  const gh = inferGhCommand(parsed);
  if (gh) return gh;
  if (executable === "gh") return { hints: [], effects: [] };

  const explicit = directPaths(parsed.words);
  if (explicit.length === 1) {
    return {
      hints: [{ path: explicit[0] as string, source: "bash" }],
      effects: [],
    };
  }
  // Multiple or unrecognized absolute operands conflict with cwd evidence.
  if (parsed.words.some((value) => path.isAbsolute(value))) {
    return { hints: [], effects: [] };
  }
  return parsed.changedDirectory && parsed.cwd
    ? { hints: [{ path: parsed.cwd, source: "bash" }], effects: [] }
    : { hints: [], effects: [] };
}

/** Backward-compatible path-only view of the conservative shell inference. */
export function extractBashPaths(command: string, cwd?: string): PathHint[] {
  return [...inferBashCommand(command, cwd).hints];
}

/** Infer semantic built-in file paths or a supported bash command. */
export function inferToolCall(
  toolName: string,
  input: unknown,
  cwd: string,
): ToolCallInference {
  // Runtime inference accepts only Pi's exact built-in names; the exported
  // path helper retains its prefixed-name compatibility for direct callers.
  const fileHints = FILE_TOOLS.has(toolName)
    ? extractFileToolPaths(toolName, input, cwd)
    : [];
  if (fileHints.length > 0) return { hints: fileHints, effects: [] };
  if (toolName !== "bash" || !input || typeof input !== "object" || Array.isArray(input)) {
    return { hints: [], effects: [] };
  }
  const command = (input as Record<string, unknown>).command;
  return typeof command === "string"
    ? inferBashCommand(command, cwd)
    : { hints: [], effects: [] };
}

export function fallbackPath(cwd: string): PathHint {
  return { path: path.resolve(cwd), source: "fallback" };
}
