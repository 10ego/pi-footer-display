import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
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

  const unexpected = paths.filter((filePath) => !REQUIRED_PACKAGE_FILES.includes(filePath)).sort();
  if (unexpected.length > 0) throw new Error(`Package contains files outside the audited allowlist: ${unexpected.join(", ")}`);
  if (pathSet.size !== paths.length) throw new Error("Package contains duplicate file paths");

  return paths;
}

function invariant(condition, message) {
  if (!condition) throw new Error(`Package metadata invariant failed: ${message}`);
}

export function assertPackageMetadata(packageData, packageJson, pathCount) {
  invariant(packageData && typeof packageData === "object", "npm pack must describe one package object");
  invariant(packageJson && typeof packageJson === "object", "package.json must be readable");
  invariant(packageJson.name === "pi-footer-display", "package name must be pi-footer-display");
  invariant(packageData.name === packageJson.name, "npm pack name must match package.json");
  invariant(packageData.version === packageJson.version, "npm pack version must match package.json");
  invariant(packageData.id === `${packageJson.name}@${packageJson.version}`, "npm pack id must match name and version");
  invariant(packageData.filename === `${packageJson.name}-${packageJson.version}.tgz`, "tarball filename must match name and version");
  invariant(packageData.entryCount === pathCount, "npm pack entry count must match the audited file list");
  invariant(Number.isInteger(packageData.size) && packageData.size > 0, "tarball size must be a positive integer");
  invariant(Number.isInteger(packageData.unpackedSize) && packageData.unpackedSize > 0, "unpacked size must be a positive integer");
  invariant(typeof packageData.shasum === "string" && /^[0-9a-f]{40}$/.test(packageData.shasum), "npm pack must emit a SHA-1 shasum");
  invariant(typeof packageData.integrity === "string" && packageData.integrity.startsWith("sha512-"), "npm pack must emit SHA-512 integrity");
  invariant(Array.isArray(packageData.bundled) && packageData.bundled.length === 0, "package must not bundle dependencies");
  invariant(packageJson.repository?.url === "git+https://github.com/10ego/pi-footer-display.git", "repository URL must be canonical");
  invariant(packageJson.homepage === "https://github.com/10ego/pi-footer-display#readme", "homepage must be canonical");
  invariant(packageJson.bugs?.url === "https://github.com/10ego/pi-footer-display/issues", "bug URL must be canonical");
  invariant(packageJson.publishConfig?.access === "public", "publish access must be public");
  invariant(packageJson.publishConfig?.registry === "https://registry.npmjs.org/", "publish registry must be npmjs");
  invariant(packageJson.publishConfig?.provenance === true, "publish provenance must be enabled");
  invariant(packageJson.private === undefined, "package must not be private");
  invariant(packageJson.engines?.node === ">=22.19.0", "Node engine must match the tested minimum");
  invariant(JSON.stringify(packageJson.files) === JSON.stringify(["src", "ARCHITECTURE.md", "README.md"]), "package files allowlist must be exact");
  invariant(JSON.stringify(packageJson.pi?.extensions) === JSON.stringify(["./src/index.ts"]), "Pi extension entry point must be exact");
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

  const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
  const paths = assertPackageContents(output[0]?.files);
  assertPackageMetadata(output[0], packageJson, paths.length);
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
