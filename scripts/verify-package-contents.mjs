import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

export const REQUIRED_PACKAGE_FILES = Object.freeze([
  "ARCHITECTURE.md",
  "README.md",
  "package.json",
  "src/cache.ts",
  "src/context.ts",
  "src/extension.ts",
  "src/format.ts",
  "src/git.ts",
  "src/github.ts",
  "src/index.ts",
  "src/paths.ts",
  "src/process.ts",
  "src/state.ts",
  "src/types.ts",
]);

const FORBIDDEN_PATH_SEGMENTS = new Set([
  ".git",
  ".github",
  ".idea",
  ".local",
  ".pi",
  ".test-dist",
  ".vscode",
  "build",
  "coverage",
  "dist",
  "local",
  "node_modules",
  "temp",
  "tests",
  "tmp",
]);

function normalizePackagePath(filePath) {
  return filePath.replaceAll("\\", "/").replace(/^\.\//, "");
}

function isLocalOrForbiddenPath(filePath) {
  const normalized = normalizePackagePath(filePath);
  const segments = normalized.split("/");
  return normalized.startsWith("/")
    || /^[A-Za-z]:\//.test(normalized)
    || segments.includes("..")
    || segments.some((segment) => FORBIDDEN_PATH_SEGMENTS.has(segment));
}

export function assertPackageContents(files) {
  if (!Array.isArray(files)) throw new Error("npm pack output did not contain a files array");

  const paths = files.map((file) => {
    if (typeof file?.path !== "string") throw new Error("npm pack output contained a file without a string path");
    return normalizePackagePath(file.path);
  });
  const pathSet = new Set(paths);

  const missing = REQUIRED_PACKAGE_FILES.filter((requiredPath) => !pathSet.has(requiredPath));
  if (missing.length > 0) throw new Error(`Package is missing required files: ${missing.join(", ")}`);

  const forbidden = paths.filter(isLocalOrForbiddenPath).sort();
  if (forbidden.length > 0) throw new Error(`Package contains forbidden build, test, CI, or local paths: ${forbidden.join(", ")}`);

  return paths;
}

export function verifyPackageContents(rootDir = process.cwd()) {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npmCommand, ["pack", "--dry-run", "--json"], {
    cwd: rootDir,
    encoding: "utf8",
    shell: false,
  });

  if (result.error) throw new Error(`Could not run npm pack: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit status ${result.status}`;
    throw new Error(`npm pack --dry-run failed: ${detail}`);
  }

  let output;
  try {
    output = JSON.parse(result.stdout);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse npm pack JSON output: ${message}`);
  }
  if (!Array.isArray(output) || output.length !== 1) {
    throw new Error(`Expected npm pack to describe exactly one package; received ${Array.isArray(output) ? output.length : "non-array output"}`);
  }

  const paths = assertPackageContents(output[0]?.files);
  return { package: output[0], paths };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = verifyPackageContents();
    console.log(`Verified ${result.paths.length} files in ${result.package.filename}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
