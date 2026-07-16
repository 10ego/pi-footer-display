import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { compareSemVer } from "../../scripts/compare-semver.mjs";

describe("deterministic semantic-version comparison", () => {
  test("compares stable and prerelease versions by SemVer precedence", () => {
    assert.equal(compareSemVer("1.2.4", "1.2.3"), 1);
    assert.equal(compareSemVer("1.2.3", "1.2.4"), -1);
    assert.equal(compareSemVer("1.2.3", "1.2.3"), 0);
    assert.equal(compareSemVer("1.2.3", "1.2.3-rc.9"), 1);
    assert.equal(compareSemVer("1.2.3-rc.10", "1.2.3-rc.9"), 1);
    assert.equal(compareSemVer("1.2.3-1", "1.2.3-alpha"), -1);
    assert.equal(compareSemVer("1.2.3-alpha", "1.2.3-alpha.1"), -1);
  });

  test("handles unbounded numeric identifiers and ignores build metadata", () => {
    assert.equal(compareSemVer("999999999999999999999.0.0", "999999999999999999998.0.0"), 1);
    assert.equal(compareSemVer("1.2.3+build.2", "1.2.3+build.1"), 0);
  });

  test("rejects non-exact or invalid semantic versions", () => {
    for (const version of ["v1.2.3", "1.2", "01.2.3", "1.2.3-01", "1.2.3-", "1.2.3+bad!"]) {
      assert.throws(() => compareSemVer(version, "1.2.3"), /Invalid exact semantic version/);
    }
  });
});
