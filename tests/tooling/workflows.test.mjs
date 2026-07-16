import assert from "node:assert/strict";
import * as fs from "node:fs";
import { describe, test } from "node:test";
import { verifyWorkflowSources } from "../../scripts/verify-workflows.mjs";

const pullRequest = fs.readFileSync(".github/workflows/pull-request.yml", "utf8");
const release = fs.readFileSync(".github/workflows/release-please.yml", "utf8");
const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));

function sources(overrides = {}) {
  const nextPullRequest = overrides.pullRequest ?? pullRequest;
  const nextRelease = overrides.release ?? release;
  return {
    pullRequest: nextPullRequest,
    release: nextRelease,
    packageJson: overrides.packageJson ?? packageJson,
    allWorkflows: overrides.allWorkflows ?? [
      ["pull-request.yml", nextPullRequest],
      ["release-please.yml", nextRelease],
    ],
  };
}

function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length - 1, 1, `fixture must contain one occurrence of ${before}`);
  return source.replace(before, after);
}

function replaceFirst(source, before, after) {
  assert.ok(source.includes(before), `fixture must contain ${before}`);
  return source.replace(before, after);
}

function rejects(overrides, pattern) {
  assert.throws(() => verifyWorkflowSources(sources(overrides)), pattern);
}

describe("release workflow trust boundaries", () => {
  test("accepts the checked-in workflows", () => {
    assert.doesNotThrow(() => verifyWorkflowSources(sources()));
  });

  test("rejects mutable and unapproved action references", () => {
    rejects({ pullRequest: replaceOnce(pullRequest, "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0", "actions/checkout@v7") }, /not pinned/);
    rejects({ release: replaceOnce(release, "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a", "actions/upload-artifact@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") }, /not approved/);
  });

  test("rejects removal of every fail-closed release gate", () => {
    for (const gate of [
      "vars.RELEASE_AUTOMATION_ENABLED == 'true' && ",
      "vars.NPM_TRUSTED_PUBLISHING_READY == 'true' && ",
      "github.ref == 'refs/heads/main' && ",
    ]) rejects({ release: replaceFirst(release, gate, "") }, /every release job must use gate/);
  });

  test("rejects the deprecated numeric GitHub App ID input", () => {
    rejects({ release: replaceOnce(release, "client-id: ${{ vars.NERV_OPS_CLIENT_ID }}", "app-id: ${{ vars.NERV_OPS_APP_ID }}") }, /Client ID variable|deprecated GitHub App ID/);
  });

  test("rejects undocumented Release Please version outputs", () => {
    rejects({ release: replaceOnce(release, "RELEASE_TAG: ${{ needs.release.outputs.tag_name }}", "RELEASE_TAG: ${{ needs.release.outputs.version }}") }, /documented tag_name output/);
  });

  test("rejects credentials or OIDC in validation and packaging", () => {
    rejects({ release: replaceOnce(release, "    outputs:\n      commit_sha:", "    environment: release-automation\n    outputs:\n      commit_sha:") }, /validate must not enter an environment/);
    rejects({ release: replaceOnce(release, "    permissions:\n      contents: read\n    outputs:\n      artifact_digest:", "    permissions:\n      contents: read\n      id-token: write\n    outputs:\n      artifact_digest:") }, /package must not receive OIDC/);
  });

  test("rejects dependency installation before ancestry verification", () => {
    rejects({ release: replaceOnce(release, "      - name: Verify tag identity and main ancestry before source execution", "      - name: Install early\n        run: npm ci --ignore-scripts\n\n      - name: Verify tag identity and main ancestry before source execution") }, /ancestry must be verified before source execution/);
  });

  test("rejects lifecycle-enabled dependency installation", () => {
    rejects({ pullRequest: replaceOnce(pullRequest, "npm ci --ignore-scripts", "npm ci") }, /must disable lifecycle scripts/);
    rejects({ release: replaceOnce(release, "npm ci --ignore-scripts", "npm ci") }, /validate install must disable lifecycle scripts/);
  });

  test("rejects unreviewed Node versions", () => {
    rejects({ pullRequest: replaceOnce(pullRequest, "node-version: 24.18.0", "node-version: 24") }, /reviewed Node 24 release/);
    rejects({ release: replaceFirst(release, "node-version: 24.18.0", "node-version: 22.19.0") }, /reviewed Node 24 release/);
  });

  test("rejects repository execution in the fresh package boundary", () => {
    rejects({ release: replaceOnce(release, "      - name: Build one lifecycle-script-disabled tarball", "      - name: Install untrusted code\n        run: npm ci\n\n      - name: Build one lifecycle-script-disabled tarball") }, /must not install dependencies/);
    rejects({ release: replaceOnce(release, "      - name: Build one lifecycle-script-disabled tarball", "      - name: Execute repository script\n        run: npm run verify:package\n\n      - name: Build one lifecycle-script-disabled tarball") }, /must not install dependencies or execute repository scripts/);
  });

  test("rejects a second package build or lifecycle-enabled pack", () => {
    rejects({ release: replaceOnce(release, 'npm pack --ignore-scripts --json --pack-destination "$output_dir" > "$pack_json"', 'npm pack --ignore-scripts --json --pack-destination "$output_dir" > "$pack_json"\n          npm pack --ignore-scripts') }, /exactly one lifecycle-script-disabled tarball/);
    rejects({ release: replaceOnce(release, 'npm pack --ignore-scripts --json --pack-destination "$output_dir"', 'npm pack --json --pack-destination "$output_dir"') }, /exactly one lifecycle-script-disabled tarball/);
  });

  test("rejects source checkout or secrets in the OIDC publisher", () => {
    rejects({ release: replaceOnce(release, "      - name: Set up Node.js for trusted publishing", "      - name: Check out source\n        uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0\n\n      - name: Set up Node.js for trusted publishing") }, /must not check out/);
    rejects({ release: replaceOnce(release, "          DOWNLOAD_STEP_PATH: ${{ steps.download.outputs.download_path }}", "          DOWNLOAD_STEP_PATH: ${{ steps.download.outputs.download_path }}\n          NPM_AUTH: ${{ secrets.NPM_AUTH }}") }, /only release may reference one environment secret|publish must not reference secrets/);
  });

  test("rejects deprecated artifact extraction dependencies", () => {
    rejects({ release: replaceOnce(release, "      - name: Download exact current-run artifact", "      - name: Download exact current-run artifact\n        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c") }, /not approved|deprecated artifact extraction dependency/);
  });

  test("rejects unsafe artifact archive handling", () => {
    rejects({ release: replaceOnce(release, '[[ "$(sha256sum "$archive" | awk \'{print $1}\')" == "$ARTIFACT_DIGEST" ]] || exit 1', "true") }, /archive digest/);
    rejects({ release: replaceOnce(release, '[[ "${entries[0]}" == "$TARBALL_FILENAME" ]] || exit 1', "true") }, /expected archive entry/);
    rejects({ release: replaceOnce(release, 'unzip -p "$archive" "$TARBALL_FILENAME" > "$tarball_path"', 'unzip "$archive"') }, /stream exactly one expected tarball/);
  });

  test("rejects weakening the exact publication command", () => {
    const command = 'npm publish "$TARBALL_PATH" --access public --provenance --tag "$DIST_TAG" --ignore-scripts';
    rejects({ release: replaceOnce(release, command, 'npm publish "$TARBALL_PATH" --access public') }, /publish one exact tarball/);
    rejects({ release: replaceOnce(release, command, `${command}\n          npm publish "$TARBALL_PATH"`) }, /one npm publish command/);
  });

  test("rejects persisted checkout credentials", () => {
    rejects({ pullRequest: replaceOnce(pullRequest, "persist-credentials: false", "persist-credentials: true") }, /must not persist/);
    rejects({ release: replaceFirst(release, "persist-credentials: false", "persist-credentials: true") }, /validate checkout must not persist/);
  });

  test("rejects token fallbacks", () => {
    rejects({ pullRequest: `${pullRequest}\n# NPM_TOKEN\n` }, /token fallbacks are forbidden/);
    rejects({ pullRequest: `${pullRequest}\n# secrets.GITHUB_TOKEN\n` }, /token fallbacks are forbidden/);
  });

  test("rejects unreviewed workflow files", () => {
    rejects({ allWorkflows: [["pull-request.yml", pullRequest], ["release-please.yml", release], ["extra.yml", "name: Extra\n"]] }, /exactly the reviewed/);
  });

  test("rejects unsafe package publishing metadata or missing wiring", () => {
    rejects({ packageJson: { ...packageJson, publishConfig: { ...packageJson.publishConfig, provenance: false } } }, /provenance must be enabled/);
    rejects({ packageJson: { ...packageJson, scripts: { ...packageJson.scripts, "verify:workflows": "echo bypass" } } }, /verify:workflows script must be wired/);
    rejects({ packageJson: { ...packageJson, scripts: { ...packageJson.scripts, "test:tooling": "node --test tests/tooling/release-version.test.mjs" } } }, /workflow tests must run/);
  });
});
