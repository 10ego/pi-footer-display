import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  assertPackageContents,
  REQUIRED_PACKAGE_FILES,
  verifyPackageContents,
} from "../../scripts/verify-package-contents.mjs";

function files(paths = REQUIRED_PACKAGE_FILES) {
  return paths.map((filePath) => ({ path: filePath }));
}

describe("npm package contents", () => {
  test("accepts the current npm pack dry-run", () => {
    const result = verifyPackageContents(process.cwd());
    assert.equal(result.package.name, "pi-footer-display");
    assert.equal(result.package.version, "0.1.0");
    assert.deepEqual(result.paths, REQUIRED_PACKAGE_FILES);
  });

  for (const requiredPath of REQUIRED_PACKAGE_FILES) {
    test(`rejects a package missing ${requiredPath}`, () => {
      const packageFiles = files(REQUIRED_PACKAGE_FILES.filter((filePath) => filePath !== requiredPath));
      assert.throws(() => assertPackageContents(packageFiles), new RegExp(`missing required files: .*${requiredPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    });
  }

  const unixMachinePath = ["", "Users", "example", "project", "src", "index.ts"].join("/");
  const windowsMachinePath = `C:${["", "Users", "example", "project", "src", "index.ts"].join("\\")}`;
  for (const forbiddenPath of [
    "tests/core.test.ts",
    ".github/workflows/release.yml",
    "build/index.js",
    "dist/index.js",
    "local/debug.json",
    ".pi/settings.json",
    unixMachinePath,
    windowsMachinePath,
    "../outside.txt",
  ]) {
    test(`rejects leaked path ${forbiddenPath}`, () => {
      assert.throws(
        () => assertPackageContents([...files(), { path: forbiddenPath }]),
        /forbidden build, test, CI, or local paths/,
      );
    });
  }

  test("rejects malformed npm pack file records", () => {
    assert.throws(() => assertPackageContents(undefined), /files array/);
    assert.throws(() => assertPackageContents([...files(), {}]), /without a string path/);
  });
});
