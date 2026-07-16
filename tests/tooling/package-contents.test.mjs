import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";
import {
  assertPackageContents,
  assertPackageMetadata,
  REQUIRED_PACKAGE_FILES,
  verifyPackageContents,
} from "../../scripts/verify-package-contents.mjs";

function files(paths = REQUIRED_PACKAGE_FILES) {
  return paths.map((filePath) => ({ path: filePath, size: 1, mode: 0o644 }));
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
        () => assertPackageContents([...files(), { path: forbiddenPath, size: 1, mode: 0o644 }]),
        /forbidden build, test, CI, or local paths|unsafe path|unsupported file type/,
      );
    });
  }

  test("rejects files outside the exact audited allowlist and duplicate paths", () => {
    assert.throws(() => assertPackageContents([...files(), { path: "src/unreviewed.ts", size: 1, mode: 0o644 }]), /outside the audited allowlist/);
    assert.throws(() => assertPackageContents([...files(), files()[0]]), /duplicate file paths/);
  });

  test("rejects executable, oversized, and unsupported package files", () => {
    const current = files();
    assert.throws(() => assertPackageContents(current.map((file, index) => index === 0 ? { ...file, mode: 0o755 } : file)), /unsafe file mode/);
    assert.throws(() => assertPackageContents(current.map((file, index) => index === 0 ? { ...file, size: 6 * 1024 * 1024 } : file)), /file size metadata/);
    assert.throws(() => assertPackageContents([...current, { path: "src/payload.sh", size: 1, mode: 0o644 }]), /unsupported file type/);
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
    const lifecycle = { ...manifest, scripts: { ...manifest.scripts, prepack: "node payload.js" } };
    assert.throws(() => assertPackageMetadata(packageJson, lifecycle, result.paths.length), /lifecycle script is forbidden/);
  });

  test("package inspection never runs lifecycle scripts", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-footer-package-policy-"));
    try {
      fs.writeFileSync(path.join(directory, "README.md"), "probe\n");
      fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({
        name: "pi-footer-display",
        version: "1.0.0",
        files: ["README.md"],
        scripts: { prepack: "node -e \"require('node:fs').writeFileSync('lifecycle-ran', 'yes')\"" },
      }));
      assert.throws(() => verifyPackageContents(directory), /Package metadata invariant failed|Package is missing required files/);
      assert.equal(fs.existsSync(path.join(directory, "lifecycle-ran")), false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

function requirePackageJson() {
  return fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8");
}
