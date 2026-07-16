import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { verifyRootReleaseVersion } from "../../scripts/verify-release-version.mjs";

const tempDirs = [];

function writeVersionFiles(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-footer-display-release-version-test-"));
  tempDirs.push(dir);
  const values = {
    packageJson: "1.2.3",
    packageLock: "1.2.3",
    packageLockRoot: "1.2.3",
    manifest: "1.2.3",
    ...overrides,
  };
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: values.packageJson }));
  fs.writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify({
    version: values.packageLock,
    packages: { "": { version: values.packageLockRoot } },
  }));
  fs.writeFileSync(path.join(dir, ".release-please-manifest.json"), JSON.stringify({ ".": values.manifest }));
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("root release-version invariant", () => {
  test("accepts matching npm, lockfile, and Release Please versions", () => {
    assert.equal(verifyRootReleaseVersion(writeVersionFiles()), "1.2.3");
    assert.equal(verifyRootReleaseVersion(writeVersionFiles(), "1.2.3"), "1.2.3");
    assert.equal(verifyRootReleaseVersion(process.cwd()), "0.1.0");
  });

  const mismatchCases = [
    ["package.json.version", "packageJson"],
    ["package-lock.json.version", "packageLock"],
    ["package-lock.json packages[''].version", "packageLockRoot"],
    [".release-please-manifest.json['.']", "manifest"],
  ];
  for (const [location, key] of mismatchCases) {
    test(`rejects a mismatch at ${location}`, () => {
      const dir = writeVersionFiles({ [key]: "1.2.4" });
      assert.throws(
        () => verifyRootReleaseVersion(dir),
        (error) => error instanceof Error
          && error.message.includes("Root release version mismatch")
          && error.message.includes(location),
      );
    });
  }

  const invalidCases = [
    ["package.json.version", "packageJson"],
    ["package-lock.json.version", "packageLock"],
    ["package-lock.json packages[''].version", "packageLockRoot"],
    [".release-please-manifest.json['.']", "manifest"],
  ];
  for (const [location, key] of invalidCases) {
    test(`rejects an invalid semantic version at ${location}`, () => {
      const dir = writeVersionFiles({ [key]: "1.2.3-01" });
      assert.throws(
        () => verifyRootReleaseVersion(dir),
        (error) => error instanceof Error
          && error.message.includes(location)
          && error.message.includes("valid semantic version"),
      );
    });
  }

  test("rejects invalid and mismatched expected versions", () => {
    const dir = writeVersionFiles();
    assert.throws(() => verifyRootReleaseVersion(dir, "not-semver"), /expected release version must contain a valid semantic version/);
    assert.throws(() => verifyRootReleaseVersion(dir, "1.2.4"), /expected release version is 1\.2\.4/);
  });
});
