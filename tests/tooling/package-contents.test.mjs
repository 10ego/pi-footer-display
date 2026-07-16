import assert from "node:assert/strict";
import * as fs from "node:fs";
import { describe, test } from "node:test";
import {
  assertPackageContents,
  assertPackageMetadata,
  REQUIRED_PACKAGE_FILES,
  verifyPackageContents,
} from "../../scripts/verify-package-contents.mjs";

function files(paths = REQUIRED_PACKAGE_FILES) {
  return paths.map((filePath) => ({ path: filePath }));
}

describe("npm package contents", () => {
  test("accepts the current npm pack dry-run", () => {
    const result = verifyPackageContents(process.cwd());
    const packageJson = JSON.parse(requirePackageJson());
    assert.equal(result.package.name, "pi-footer-display");
    assert.equal(result.package.version, packageJson.version);
    assert.match(result.package.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
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

  test("rejects files outside the exact audited allowlist and duplicate paths", () => {
    assert.throws(() => assertPackageContents([...files(), { path: "src/unreviewed.ts" }]), /outside the audited allowlist/);
    assert.throws(() => assertPackageContents([...files(), { path: REQUIRED_PACKAGE_FILES[0] }]), /duplicate file paths/);
  });

  test("rejects malformed npm pack file records", () => {
    assert.throws(() => assertPackageContents(undefined), /files array/);
    assert.throws(() => assertPackageContents([...files(), {}]), /without a string path/);
  });

  test("rejects unsafe or inconsistent package metadata", () => {
    const result = verifyPackageContents(process.cwd());
    const packageJson = JSON.parse(JSON.stringify(result.package));
    const manifest = JSON.parse(requirePackageJson());
    assert.doesNotThrow(() => assertPackageMetadata(packageJson, manifest, result.paths.length));

    const wrongVersion = { ...packageJson, version: "9.9.9" };
    assert.throws(() => assertPackageMetadata(wrongVersion, manifest, result.paths.length), /version must match/);
    const wrongCount = { ...packageJson, entryCount: result.paths.length + 1 };
    assert.throws(() => assertPackageMetadata(wrongCount, manifest, result.paths.length), /entry count/);
    const privateManifest = { ...manifest, private: true };
    assert.throws(() => assertPackageMetadata(packageJson, privateManifest, result.paths.length), /must not be private/);
    const localRepository = { ...manifest, repository: { url: "file:///tmp/package" } };
    assert.throws(() => assertPackageMetadata(packageJson, localRepository, result.paths.length), /repository URL/);
    const noProvenance = { ...manifest, publishConfig: { ...manifest.publishConfig, provenance: false } };
    assert.throws(() => assertPackageMetadata(packageJson, noProvenance, result.paths.length), /provenance/);
  });
});

function requirePackageJson() {
  return fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8");
}
