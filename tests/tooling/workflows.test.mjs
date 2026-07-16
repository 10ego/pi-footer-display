import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { verifyWorkflowSources, verifyWorkflows } from "../../scripts/verify-workflows.mjs";

const rootDir = process.cwd();
const valid = Object.freeze({
  pullRequest: fs.readFileSync(path.join(rootDir, ".github/workflows/pull-request.yml"), "utf8"),
  release: fs.readFileSync(path.join(rootDir, ".github/workflows/release-please.yml"), "utf8"),
  packageJson: JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8")),
});

function replace(source, oldText, newText) {
  assert.equal(source.split(oldText).length, 2, `test fixture fragment must occur exactly once: ${oldText}`);
  return source.replace(oldText, newText);
}

function rejects(change, message) {
  const candidate = {
    pullRequest: valid.pullRequest,
    release: valid.release,
    packageJson: structuredClone(valid.packageJson),
    ...change,
  };
  assert.throws(() => verifyWorkflowSources(candidate), new RegExp(message));
}

describe("GitHub workflow invariants", () => {
  test("accepts the checked-in workflows and package publishing metadata", () => {
    verifyWorkflows(rootDir);
  });

  test("rejects a missing pull-request event", () => {
    rejects({ pullRequest: valid.pullRequest.replace("      - edited\n", "") }, "approved activity types");
  });

  test("rejects either missing fail-closed release gate", () => {
    rejects({
      release: replace(valid.release, "vars.RELEASE_AUTOMATION_ENABLED == 'true' && vars.NPM_TRUSTED_PUBLISHING_READY == 'true' && (github.event_name", "vars.RELEASE_AUTOMATION_ENABLED == 'true' && (github.event_name"),
    }, "release job must fail closed");
    rejects({
      release: replace(valid.release, "if: ${{ vars.RELEASE_AUTOMATION_ENABLED == 'true'", "if: ${{ true"),
    }, "release job must fail closed");
  });

  test("rejects a publish gate without always, either gate, or successful release result", () => {
    rejects({
      release: replace(valid.release, "always() && vars.RELEASE_AUTOMATION_ENABLED", "vars.RELEASE_AUTOMATION_ENABLED"),
    }, "publish job must use always");
    rejects({
      release: replace(valid.release, "always() && vars.RELEASE_AUTOMATION_ENABLED == 'true' && vars.NPM_TRUSTED_PUBLISHING_READY == 'true'", "always() && vars.RELEASE_AUTOMATION_ENABLED == 'true'"),
    }, "publish job must use always");
    rejects({
      release: replace(valid.release, "needs.release.result == 'success' && needs.release.outputs.release_created == 'true'", "needs.release.outputs.release_created == 'true'"),
    }, "publish job must use always");
  });

  test("rejects GITHUB_TOKEN fallback and NPM_TOKEN", () => {
    rejects({ release: `${valid.release}\n# secrets.GITHUB_TOKEN\n` }, "GITHUB_TOKEN fallback");
    rejects({ release: `${valid.release}\n# NPM_TOKEN\n` }, "GITHUB_TOKEN fallback");
  });

  test("rejects excessive permissions", () => {
    rejects({ release: replace(valid.release, "      contents: read\n    outputs:", "      contents: write\n    outputs:") }, "contents:read");
    rejects({ release: replace(valid.release, "      id-token: write\n    steps:", "      id-token: write\n      packages: write\n    steps:") }, "write permissions");
  });

  test("rejects checkout that is not the resolved exact tag", () => {
    rejects({ release: replace(valid.release, "ref: ${{ steps.target.outputs.tag }}", "ref: main") }, "exact emitted or recovery tag");
  });

  test("rejects missing recovery safeguards", () => {
    rejects({ release: replace(valid.release, "--json isDraft,tagName", "--json tagName") }, "existing GitHub release");
    rejects({ release: replace(valid.release, "if ! grep -q 'E404'", "if false") }, "not-found response");
    rejects({ release: replace(valid.release, "refusing duplicate normal publish", "duplicate ignored") }, "normal mode must fail");
  });

  test("rejects mutable or unapproved action pins", () => {
    rejects({ release: replace(valid.release, "actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5", "actions/checkout@v4") }, "full commit SHA");
    rejects({ release: replace(valid.release, "34e114876b0b11c390a56381ad16ebd13914f8d5", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") }, "action pin is not approved");
  });

  test("rejects an unpinned actionlint archive", () => {
    rejects({ pullRequest: replace(valid.pullRequest, "ACTIONLINT_VERSION: 1.7.7", "ACTIONLINT_VERSION: latest") }, "approved pinned version");
    rejects({ pullRequest: replace(valid.pullRequest, "023070a287cd8cccd71515fedc843f1985bf96c436b7effaecce67290e7e0757", "unverified") }, "pinned checksum");
  });

  test("rejects any other npm publish command", () => {
    rejects({ release: replace(valid.release, "npm publish --access public --provenance", "npm publish") }, "publish command must be exactly");
  });

  test("rejects unsafe package publishing metadata or missing script wiring", () => {
    const privatePackage = structuredClone(valid.packageJson);
    privatePackage.private = true;
    rejects({ packageJson: privatePackage }, "must not be private");

    const noProvenance = structuredClone(valid.packageJson);
    noProvenance.publishConfig.provenance = false;
    rejects({ packageJson: noProvenance }, "publishConfig.provenance");

    const noWorkflowTests = structuredClone(valid.packageJson);
    noWorkflowTests.scripts["test:tooling"] = "node --test tests/tooling/release-version.test.mjs";
    rejects({ packageJson: noWorkflowTests }, "workflow tests must be wired");
  });
});
