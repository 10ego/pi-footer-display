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

function toolBasename(toolName: string): string {
  return toolName.split(/[.:/]/).at(-1) ?? toolName;
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
    .filter((value) => value.length > 0)
    .map((value) => ({
      path: path.resolve(cwd, value),
      source: "file" as const,
    }));
}

/**
 * Tokenizes only simple shell words. Expansions, redirections, pipes, newlines,
 * command substitutions, and separators other than a single `&&` are rejected.
 */
function tokenizeSimpleCommand(command: string): string[] | undefined {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;

  const push = (): void => {
    if (word.length > 0) words.push(word);
    word = "";
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === undefined) continue;
    if (escaping) {
      word += char;
      escaping = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else {
        if (quote === '"' && (char === "$" || char === "`")) return undefined;
        word += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "\n" || char === "\r") return undefined;
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
    if ("&;$`|<>(){}".includes(char)) return undefined;
    word += char;
  }
  if (escaping || quote) return undefined;
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

  if (executable === "git") {
    const paths: string[] = [];
    for (let index = 0; index < args.length - 1; index += 1) {
      if (args[index] === "-C") paths.push(args[index + 1] ?? "");
    }
    return oneUnambiguousAbsolute(paths);
  }

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

/**
 * Accepts only three bash hint shapes: `git -C /absolute`, explicit absolute
 * operands to a small path-oriented command allowlist, and
 * `cd /absolute && <one simple command>`.
 */
export function extractBashPaths(command: string): PathHint[] {
  const words = tokenizeSimpleCommand(command.trim());
  if (!words || words.length === 0) return [];

  const conjunction = words.indexOf("&&");
  if (conjunction !== -1) {
    if (conjunction !== 2 || words.indexOf("&&", conjunction + 1) !== -1) return [];
    if (words[0] !== "cd" || !path.isAbsolute(words[1] ?? "")) return [];
    const tail = words.slice(3);
    if (tail.length === 0 || executableName(tail[0] ?? "") === "cd") return [];

    // An explicit file operand in the command after `cd` is stronger than its cwd.
    const explicit = directPaths(tail);
    if (explicit.length === 1) {
      return [{ path: explicit[0] as string, source: "bash" }];
    }
    // Multiple or unrecognized absolute operands make the shell evidence ambiguous.
    if (tail.some((value) => path.isAbsolute(value))) return [];
    return [{ path: words[1] as string, source: "bash" }];
  }

  return directPaths(words).map((value) => ({ path: value, source: "bash" }));
}

export function fallbackPath(cwd: string): PathHint {
  return { path: path.resolve(cwd), source: "fallback" };
}
