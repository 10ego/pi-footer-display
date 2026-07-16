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

  test("rejects a missing pull-request event or a release pull-request trigger", () => {
    rejects({ pullRequest: valid.pullRequest.replace("      - edited\n", "") }, "approved activity types");
    rejects({ release: replace(valid.release, "on:\n  push:", "on:\n  pull_request:\n  push:") }, "never pull requests");
  });

  test("rejects either missing fail-closed release gate or a non-main normal dispatch", () => {
    rejects({
      release: replace(valid.release, "vars.RELEASE_AUTOMATION_ENABLED == 'true' && vars.NPM_TRUSTED_PUBLISHING_READY == 'true' && (github.event_name", "vars.RELEASE_AUTOMATION_ENABLED == 'true' && (github.event_name"),
    }, "release job must fail closed");
    rejects({
      release: replace(valid.release, "if: ${{ vars.RELEASE_AUTOMATION_ENABLED == 'true'", "if: ${{ true"),
    }, "release job must fail closed");
    rejects({
      release: replace(valid.release, " && github.ref == 'refs/heads/main'", ""),
    }, "release job must fail closed");
    rejects({
      release: replace(valid.release, "github.ref == 'refs/heads/main'", "github.ref != 'refs/heads/main'"),
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

  test("rejects excessive workflow permissions or weakened App token permissions", () => {
    rejects({ release: replace(valid.release, "      contents: read\n    outputs:", "      contents: write\n    outputs:") }, "contents:read");
    rejects({ release: replace(valid.release, "      id-token: write\n    steps:", "      id-token: write\n      packages: write\n    steps:") }, "write permissions");
    rejects({ release: replace(valid.release, "permission-issues: write", "permission-issues: read") }, "issues:write");
    rejects({ release: replace(valid.release, "permission-pull-requests: write", "permission-pull-requests: read") }, "pull-requests:write");
    rejects({ release: replace(valid.release, "permission-contents: read", "permission-contents: read\n          permission-issues: read") }, "exactly contents:read");
  });

  test("rejects undocumented version outputs or version derivation not based on a validated tag", () => {
    rejects({
      release: replace(valid.release, "      release_created: ${{ steps.release.outputs.release_created }}\n", "      release_created: ${{ steps.release.outputs.release_created }}\n      version: ${{ steps.release.outputs.version }}\n"),
    }, "only documented release_created and tag_name outputs");
    rejects({
      release: replace(valid.release, "RELEASE_TAG: ${{ needs.release.outputs.tag_name }}", "RELEASE_TAG: ${{ needs.release.outputs.version }}"),
    }, "undocumented Release Please version output");
    rejects({ release: replace(valid.release, "SEMVER_PATTERN='^v", "SEMVER_PATTERN='^") }, "exact v-prefixed semantic versions");
    rejects({ release: replace(valid.release, 'VERSION="${TARGET_TAG#v}"', 'VERSION="$TARGET_TAG"') }, "derived only after strict validation");
    rejects({
      release: replace(valid.release, 'if [[ -z "$TARGET_TAG" ]]; then\n              echo "Release Please did not emit a tag" >&2\n              exit 1\n            fi', 'if [[ -z "$TARGET_TAG" ]]; then\n              echo "Release Please did not emit a tag" >&2\n            fi'),
    }, "normal publish must fail");
    rejects({
      release: replace(valid.release, 'if [[ ! "$TARGET_TAG" =~ $SEMVER_PATTERN ]]; then\n            echo "Release tag must be an exact v-prefixed semantic version: $TARGET_TAG" >&2\n            exit 1\n          fi', 'if [[ ! "$TARGET_TAG" =~ $SEMVER_PATTERN ]]; then\n            echo "Ignoring malformed tag: $TARGET_TAG"\n          fi'),
    }, "malformed normal and recovery tags must fail");
  });

  test("rejects checkout that is not the resolved exact tag with main ancestry", () => {
    rejects({ release: replace(valid.release, "ref: ${{ steps.target.outputs.tag }}", "ref: main") }, "exact emitted or recovery tag");
    rejects({ release: replace(valid.release, "fetch-depth: 0", "fetch-depth: 1") }, "fetch main history");
    rejects({ release: replace(valid.release, "git merge-base --is-ancestor HEAD refs/remotes/origin/main", "git merge-base --is-ancestor HEAD HEAD") }, "outside main history");
  });

  test("rejects missing recovery and npm availability safeguards", () => {
    rejects({ release: replace(valid.release, "--json isDraft,tagName", "--json tagName") }, "existing GitHub release");
    rejects({
      release: replace(valid.release, 'elif node --input-type=module - "$dist_tag_output" <<\'NODE\'\n          import fs from "node:fs";\n          const payload = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));\n          if (payload?.error?.code !== "E404") process.exit(1);', 'elif node --input-type=module - "$dist_tag_output" <<\'NODE\'\n          process.exit(0);'),
    }, "structured npm E404");
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

  test("rejects unsafe npm dist-tag selection, regressions, or any other npm publish command", () => {
    rejects({ release: replace(valid.release, "DIST_TAG=next", "DIST_TAG=latest") }, "safe next dist-tag");
    rejects({ release: replace(valid.release, '"dist-tags.$DIST_TAG"', '"dist-tags.latest"') }, "latest and next");
    rejects({ release: replace(valid.release, '"dist-tags.$DIST_TAG"', '"dist-tags.next"') }, "latest and next");
    rejects({ release: replace(valid.release, 'node scripts/compare-semver.mjs "$VERSION" "$CURRENT_VERSION"', 'printf 1') }, "deterministic SemVer comparator");
    rejects({
      release: replace(valid.release, '-1)\n                echo "$VERSION is lower than current $DIST_TAG version $CURRENT_VERSION; refusing dist-tag regression." >&2\n                exit 1', '-1)\n                echo "Ignoring lower version"'),
    }, "lower versions must not regress");
    rejects({
      release: replace(valid.release, '0)\n                echo "$VERSION equals current $DIST_TAG version $CURRENT_VERSION after the exact-version absence check; refusing inconsistent npm state." >&2\n                exit 1', '0)\n                echo "Ignoring equal version"'),
    }, "equal dist-tag versions must fail closed");
    rejects({ release: replace(valid.release, "latest|next", "latest|beta|next") }, "unexpected npm dist-tags");
    rejects({ release: replace(valid.release, 'npm publish --access public --provenance --tag "$DIST_TAG"', "npm publish") }, "validated dist-tag exactly once");
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
