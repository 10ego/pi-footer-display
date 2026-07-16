import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const NUMERIC_IDENTIFIER = "(?:0|[1-9]\\d*)";
const PRERELEASE_IDENTIFIER = `(?:${NUMERIC_IDENTIFIER}|\\d*[A-Za-z-][0-9A-Za-z-]*)`;
const SEMVER = new RegExp(`^${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}(?:-${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read ${filePath}: ${message}`);
  }
}

function assertVersion(location, value) {
  if (typeof value !== "string" || !SEMVER.test(value)) {
    throw new Error(`${location} must contain a valid semantic version; received ${JSON.stringify(value)}`);
  }
}

export function verifyRootReleaseVersion(rootDir = process.cwd(), expectedVersion) {
  const packageJson = readJson(path.join(rootDir, "package.json"));
  const packageLock = readJson(path.join(rootDir, "package-lock.json"));
  const manifest = readJson(path.join(rootDir, ".release-please-manifest.json"));
  const versions = new Map([
    ["package.json.version", packageJson.version],
    ["package-lock.json.version", packageLock.version],
    ["package-lock.json packages[''].version", packageLock.packages?.[""]?.version],
    [".release-please-manifest.json['.']", manifest["."]],
  ]);

  for (const [location, version] of versions) assertVersion(location, version);
  if (expectedVersion !== undefined) assertVersion("expected release version", expectedVersion);

  const [canonicalLocation, canonicalVersion] = versions.entries().next().value;
  for (const [location, version] of versions) {
    if (version !== canonicalVersion) {
      throw new Error(`Root release version mismatch: ${canonicalLocation} is ${canonicalVersion}, but ${location} is ${version}`);
    }
  }
  if (expectedVersion !== undefined && canonicalVersion !== expectedVersion) {
    throw new Error(`Root release version mismatch: ${canonicalLocation} is ${canonicalVersion}, but expected release version is ${expectedVersion}`);
  }

  return canonicalVersion;
}

function main(args) {
  if (args.length === 0) return verifyRootReleaseVersion();
  if (args.length === 2 && args[0] === "--expected") return verifyRootReleaseVersion(process.cwd(), args[1]);
  throw new Error("Usage: node scripts/verify-release-version.mjs [--expected <version>]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const version = main(process.argv.slice(2));
    console.log(`Verified root release version ${version}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
