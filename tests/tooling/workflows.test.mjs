import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, test } from "node:test";
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

function transformJob(source, jobName, transform) {
  const marker = `  ${jobName}:\n`;
  assert.equal(source.split(marker).length, 2, `test fixture job must occur exactly once: ${jobName}`);
  const start = source.indexOf(marker);
  const remainder = source.slice(start + marker.length);
  const nextJob = remainder.search(/^  [A-Za-z0-9_-]+:\n/m);
  const end = nextJob === -1 ? source.length : start + marker.length + nextJob;
  return source.slice(0, start) + transform(source.slice(start, end)) + source.slice(end);
}

function replaceInJob(source, jobName, oldText, newText) {
  return transformJob(source, jobName, (job) => replace(job, oldText, newText));
}

function transformStep(source, jobName, stepName, transform) {
  return transformJob(source, jobName, (job) => {
    const marker = `      - name: ${stepName}\n`;
    assert.equal(job.split(marker).length, 2, `test fixture step must occur exactly once: ${stepName}`);
    const start = job.indexOf(marker);
    const remainder = job.slice(start + marker.length);
    const nextStep = remainder.search(/^      - /m);
    const end = nextStep === -1 ? job.length : start + marker.length + nextStep;
    return job.slice(0, start) + transform(job.slice(start, end)) + job.slice(end);
  });
}

function replaceInStep(source, jobName, stepName, oldText, newText) {
  return transformStep(source, jobName, stepName, (step) => replace(step, oldText, newText));
}

function rejects(change, message) {
  const candidate = {
    pullRequest: valid.pullRequest,
    release: valid.release,
    packageJson: structuredClone(valid.packageJson),
    ...change,
  };
  assert.throws(
    () => verifyWorkflowSources(candidate),
    (error) => {
      assert.equal(error instanceof Error, true);
      assert.equal(error.message, `Workflow invariant failed: ${message}`);
      return true;
    },
  );
}

function releaseMutationTest(name, mutate, message) {
  test(name, () => rejects({ release: mutate(valid.release) }, message));
}

function pullRequestMutationTest(name, mutate, message) {
  test(name, () => rejects({ pullRequest: mutate(valid.pullRequest) }, message));
}

function prependPublishCommand(source, command) {
  return replaceInStep(
    source,
    "publish",
    "Verify bundled npm supports trusted publishing",
    '          npm_version="$(npm --version)"',
    `          ${command}\n          npm_version="$(npm --version)"`,
  );
}

describe("GitHub workflow invariants", () => {
  test("accepts the checked-in workflows and package publishing metadata", () => {
    verifyWorkflows(rootDir);
  });

  pullRequestMutationTest(
    "rejects a missing pull-request activity type",
    (source) => replace(source, "      - edited\n", ""),
    "pull requests must run on exactly the approved activity types",
  );

  pullRequestMutationTest(
    "rejects extra pull-request workflow permissions",
    (source) => replace(source, "permissions:\n  contents: read", "permissions:\n  contents: read\n  pull-requests: read"),
    "pull-request workflow must have contents:read only",
  );

  releaseMutationTest(
    "rejects a release pull-request trigger",
    (source) => replace(source, "on:\n  push:", "on:\n  pull_request:\n  push:"),
    "release workflow must run only on pushes and manual dispatches, never pull requests",
  );

  releaseMutationTest(
    "rejects non-empty workflow-level permissions",
    (source) => replace(source, "permissions: {}", "permissions:\n  contents: read"),
    "release workflow must deny permissions by default",
  );

  releaseMutationTest(
    "rejects an extra release workflow job",
    (source) => replace(
      source,
      "\n  prepare:\n",
      "\n  audit:\n    runs-on: ubuntu-latest\n    steps: []\n\n  prepare:\n",
    ),
    "release workflow must contain exactly release, prepare, and publish jobs",
  );

  releaseMutationTest(
    "rejects a missing required release workflow job",
    (source) => replace(source, "  publish:\n", "  deploy:\n"),
    "release workflow must contain exactly release, prepare, and publish jobs",
  );

  for (const [name, jobName, oldText, newText, message] of [
    [
      "rejects a release job missing a readiness gate",
      "release",
      "vars.NPM_TRUSTED_PUBLISHING_READY == 'true' && ",
      "",
      "release job must use the exact dual gate and main-ref event gate",
    ],
    [
      "rejects a release job not bound to main",
      "release",
      " && github.ref == 'refs/heads/main'",
      "",
      "release job must use the exact dual gate and main-ref event gate",
    ],
    [
      "rejects a prepare job without always",
      "prepare",
      "always() && ",
      "",
      "prepare must use the exact main-ref dual gate",
    ],
    [
      "rejects a prepare job missing an automation gate",
      "prepare",
      "vars.RELEASE_AUTOMATION_ENABLED == 'true' && ",
      "",
      "prepare must use the exact main-ref dual gate",
    ],
    [
      "rejects a prepare job not bound to main",
      "prepare",
      " && github.ref == 'refs/heads/main'",
      "",
      "prepare must use the exact main-ref dual gate",
    ],
    [
      "rejects a publish job missing a readiness gate",
      "publish",
      "vars.NPM_TRUSTED_PUBLISHING_READY == 'true' && ",
      "",
      "publish must use the exact main-ref dual gate and successful prepare outputs",
    ],
    [
      "rejects a publish job not bound to main",
      "publish",
      " && github.ref == 'refs/heads/main'",
      "",
      "publish must use the exact main-ref dual gate and successful prepare outputs",
    ],
    [
      "rejects a publish job that ignores prepare success",
      "publish",
      "needs.prepare.result == 'success' && ",
      "",
      "publish must use the exact main-ref dual gate and successful prepare outputs",
    ],
  ]) {
    releaseMutationTest(
      name,
      (source) => replaceInJob(source, jobName, oldText, newText),
      message,
    );
  }

  releaseMutationTest(
    "rejects a release job outside the release-automation environment",
    (source) => replaceInJob(source, "release", "environment: release-automation", "environment: production"),
    "release environment must be exactly release-automation",
  );

  releaseMutationTest(
    "rejects excessive release job permissions",
    (source) => replaceInJob(source, "release", "      contents: read", "      contents: write"),
    "release job must have contents:read only",
  );

  releaseMutationTest(
    "rejects an undocumented Release Please output",
    (source) => replaceInJob(
      source,
      "release",
      "      tag_name: ${{ steps.release.outputs.tag_name }}\n",
      "      tag_name: ${{ steps.release.outputs.tag_name }}\n      version: ${{ steps.release.outputs.version }}\n",
    ),
    "release job must expose only documented release_created and tag_name outputs",
  );

  releaseMutationTest(
    "rejects a release App token with weakened permissions",
    (source) => replaceInStep(
      source,
      "release",
      "Create nerv-ops installation token",
      "          permission-issues: write",
      "          permission-issues: read",
    ),
    "release App token must use the environment-scoped key and exact least privileges",
  );

  releaseMutationTest(
    "rejects a second App secret reference",
    (source) => replaceInStep(
      source,
      "release",
      "Enable squash auto-merge for release PRs",
      "          RELEASE_PRS: ${{ steps.release.outputs.prs }}",
      "          RELEASE_PRS: ${{ steps.release.outputs.prs }}\n          EXTRA_SECRET: ${{ secrets.EXTRA_SECRET }}",
    ),
    "only the release job may reference the environment-scoped App secret",
  );

  releaseMutationTest(
    "rejects a second App-token action",
    (source) => replaceInJob(
      source,
      "release",
      "      - name: Run Release Please\n",
      "      - name: Create duplicate installation token\n        uses: actions/create-github-app-token@fee1f7d63c2ff003460e3d139729b119787bc349\n\n      - name: Run Release Please\n",
    ),
    "only release may create an App token",
  );

  releaseMutationTest(
    "rejects prepare dependencies other than release",
    (source) => replaceInJob(source, "prepare", "    needs: release", "    needs: [release, audit]"),
    "prepare must depend only on release",
  );

  releaseMutationTest(
    "rejects an environment on prepare",
    (source) => replaceInJob(
      source,
      "prepare",
      "    runs-on: ubuntu-latest",
      "    environment: release-automation\n    runs-on: ubuntu-latest",
    ),
    "prepare must not use a credential-bearing environment",
  );

  releaseMutationTest(
    "rejects id-token permission on prepare",
    (source) => replaceInJob(
      source,
      "prepare",
      "    permissions:\n      contents: read",
      "    permissions:\n      contents: read\n      id-token: write",
    ),
    "prepare must have contents:read only",
  );

  releaseMutationTest(
    "rejects any other id-token reference on prepare",
    (source) => replaceInStep(
      source,
      "prepare",
      "Resolve release target",
      "          DISPATCH_TAG: ${{ inputs.tag }}",
      "          DISPATCH_TAG: ${{ inputs.tag }}\n          TOKEN_KIND: id-token",
    ),
    "prepare must not receive an OIDC token",
  );

  releaseMutationTest(
    "rejects a secret reference on prepare",
    (source) => replaceInStep(
      source,
      "prepare",
      "Resolve release target",
      "          DISPATCH_TAG: ${{ inputs.tag }}",
      "          DISPATCH_TAG: ${{ inputs.tag }}\n          UNTRUSTED_SECRET: ${{ secrets.UNTRUSTED_SECRET }}",
    ),
    "prepare must not reference secrets",
  );

  releaseMutationTest(
    "rejects App credential use on prepare",
    (source) => replaceInStep(
      source,
      "prepare",
      "Resolve release target",
      "          DISPATCH_TAG: ${{ inputs.tag }}",
      "          DISPATCH_TAG: ${{ inputs.tag }}\n          APP_ID: ${{ vars.NERV_OPS_APP_ID }}",
    ),
    "prepare must not create or consume an App token",
  );

  for (const [name, outputLine] of [
    ["rejects a missing uploaded artifact ID output", "      artifact_id: ${{ steps.upload.outputs.artifact-id }}\n"],
    ["rejects a missing uploaded artifact digest output", "      artifact_digest: ${{ steps.upload.outputs.artifact-digest }}\n"],
  ]) {
    releaseMutationTest(
      name,
      (source) => replaceInJob(source, "prepare", outputLine, ""),
      "prepare outputs must preserve the exact release and artifact identity",
    );
  }

  releaseMutationTest(
    "rejects recovery authentication other than github.token",
    (source) => replaceInStep(
      source,
      "prepare",
      "Verify recovery GitHub release",
      "          GH_TOKEN: ${{ github.token }}",
      "          GH_TOKEN: ${{ github.actor }}",
    ),
    "recovery must use only github.token and the validated target tag",
  );

  releaseMutationTest(
    "rejects recovery without exact release metadata",
    (source) => replaceInStep(
      source,
      "prepare",
      "Verify recovery GitHub release",
      "--json isDraft,tagName",
      "--json tagName",
    ),
    "recovery must verify an existing GitHub release",
  );

  releaseMutationTest(
    "rejects a recovery release tag that is not checked exactly",
    (source) => replaceInStep(
      source,
      "prepare",
      "Verify recovery GitHub release",
      `[[ "$(jq -r '.tagName' <<< "$release")" == "$TARGET_TAG" ]] || {`,
      `[[ -n "$(jq -r '.tagName' <<< "$release")" ]] || {`,
    ),
    "recovery release tag must match exactly",
  );

  releaseMutationTest(
    "rejects recovery that accepts draft releases",
    (source) => replaceInStep(
      source,
      "prepare",
      "Verify recovery GitHub release",
      `[[ "$(jq -r '.isDraft' <<< "$release")" == "false" ]] || {`,
      `[[ "$(jq -r '.isDraft' <<< "$release")" != "false" ]] || {`,
    ),
    "recovery must reject draft releases",
  );

  for (const [name, oldText, newText] of [
    ["rejects checkout of anything except the resolved tag", "          ref: ${{ steps.target.outputs.tag }}", "          ref: main"],
    ["rejects a shallow release checkout", "          fetch-depth: 0", "          fetch-depth: 1"],
    ["rejects persisted checkout credentials", "          persist-credentials: false", "          persist-credentials: true"],
  ]) {
    releaseMutationTest(
      name,
      (source) => replaceInStep(source, "prepare", "Check out exact release tag", oldText, newText),
      "prepare checkout must use the exact tag, full history, and no persisted credentials",
    );
  }

  releaseMutationTest(
    "rejects a second npm pack command",
    (source) => replaceInStep(
      source,
      "prepare",
      "Build and validate release tarball",
      '          npm pack --ignore-scripts --json --pack-destination "$output_dir" > "$pack_json"',
      '          npm pack --ignore-scripts --json --pack-destination "$output_dir" > "$pack_json"\n          npm pack --ignore-scripts',
    ),
    "prepare must run npm pack exactly once",
  );

  releaseMutationTest(
    "rejects npm pack with lifecycle scripts enabled",
    (source) => replaceInStep(
      source,
      "prepare",
      "Build and validate release tarball",
      'npm pack --ignore-scripts --json --pack-destination "$output_dir"',
      'npm pack --json --pack-destination "$output_dir"',
    ),
    "prepare must pack once with lifecycle scripts disabled into an isolated directory",
  );

  releaseMutationTest(
    "rejects any package audit implementation other than the checked-in verifier",
    (source) => replaceInStep(
      source,
      "prepare",
      "Build and validate release tarball",
      'import { assertPackageContents, assertPackageMetadata } from "./scripts/verify-package-contents.mjs";',
      'import { assertPackageContents, assertPackageMetadata } from "./scripts/untrusted.mjs";',
    ),
    "prepare must import the exact package audit implementation",
  );

  for (const [name, oldText, newText, message] of [
    [
      "rejects multiple npm pack results",
      "if (!Array.isArray(payload) || payload.length !== 1)",
      "if (!Array.isArray(payload))",
      "prepare must require exactly one npm pack result",
    ],
    [
      "rejects packed version validation that omits npm metadata",
      "if (packageJson.version !== expectedVersion || packageData.version !== expectedVersion)",
      "if (packageJson.version !== expectedVersion)",
      "prepare must audit the exact package version",
    ],
    [
      "rejects omission of the package file allowlist audit",
      "const paths = assertPackageContents(packageData.files);",
      "const paths = packageData.files;",
      "prepare must audit the exact package file allowlist",
    ],
    [
      "rejects omission of exact package metadata auditing",
      "assertPackageMetadata(packageData, packageJson, paths.length);",
      "assertPackageMetadata(packageData, packageJson);",
      "prepare must audit exact package metadata",
    ],
    [
      "rejects package output directories with extra entries",
      "entries.length !== 1 || !entries[0].isFile() || entries[0].name !== packageData.filename",
      "entries.length < 1 || !entries[0].isFile() || entries[0].name !== packageData.filename",
      "prepare output must contain exactly the npm-reported tarball",
    ],
    [
      "rejects weakened prepared tarball file checks",
      "!stat.isFile() || stat.isSymbolicLink() || stat.size < 1",
      "!stat.isFile() || stat.size < 1",
      "prepared tarball must be one non-empty regular file",
    ],
    [
      "rejects omission of prepared tarball path containment",
      "path.dirname(fs.realpathSync(tarballPath)) !== fs.realpathSync(outputDir)",
      "path.dirname(tarballPath) !== outputDir",
      "prepared tarball must remain in the isolated output directory",
    ],
    [
      "rejects a non-exact prepared package name",
      '[[ "$package_name" == "pi-footer-display" ]]',
      '[[ -n "$package_name" ]]',
      "prepared package name must be exact",
    ],
    [
      "rejects a tarball filename not bound to name and version",
      '[[ "$tarball_filename" == "$package_name-$EXPECTED_VERSION.tgz" ]]',
      '[[ "$tarball_filename" == *.tgz ]]',
      "prepared tarball filename must match name and version",
    ],
    [
      "rejects a prepared tarball path that may be a symlink",
      '[[ -f "$tarball_path" && ! -L "$tarball_path" ]]',
      '[[ -f "$tarball_path" ]]',
      "prepared tarball path must remain a regular file",
    ],
    [
      "rejects hashing anything except the exact prepared tarball",
      'tarball_sha256="$(sha256sum "$tarball_path" | awk \'{print $1}\')"',
      'tarball_sha256="$(sha256sum package.tgz | awk \'{print $1}\')"',
      "prepare must hash the exact tarball",
    ],
    [
      "rejects artifact names not bound to run, attempt, and version",
      'artifact_name="npm-package-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${EXPECTED_VERSION}"',
      'artifact_name="npm-package-${EXPECTED_VERSION}"',
      "artifact name must bind run, attempt, and version",
    ],
  ]) {
    releaseMutationTest(
      name,
      (source) => replaceInStep(source, "prepare", "Build and validate release tarball", oldText, newText),
      message,
    );
  }

  releaseMutationTest(
    "rejects an unapproved artifact upload action",
    (source) => replaceInStep(
      source,
      "prepare",
      "Upload release tarball",
      "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
      "actions/upload-artifact@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ),
    "prepare must use the approved upload-artifact action",
  );

  releaseMutationTest(
    "rejects artifact upload settings that do not use the exact tarball",
    (source) => replaceInStep(
      source,
      "prepare",
      "Upload release tarball",
      "          path: ${{ steps.package.outputs.tarball_path }}",
      "          path: .",
    ),
    "upload must use the exact prepared tarball and fail-closed artifact settings",
  );

  releaseMutationTest(
    "rejects missing validation of the upload artifact ID output",
    (source) => replaceInStep(
      source,
      "prepare",
      "Validate uploaded artifact outputs",
      '[[ "$ARTIFACT_ID" =~ ^[1-9][0-9]*$ ]]',
      '[[ -n "$ARTIFACT_ID" ]]',
    ),
    "upload must return a valid artifact ID",
  );

  releaseMutationTest(
    "rejects missing validation of the upload artifact digest output",
    (source) => replaceInStep(
      source,
      "prepare",
      "Validate uploaded artifact outputs",
      '[[ "$ARTIFACT_DIGEST" =~ ^[0-9a-f]{64}$ ]]',
      '[[ -n "$ARTIFACT_DIGEST" ]]',
    ),
    "upload must return a valid artifact digest",
  );

  releaseMutationTest(
    "rejects publish dependencies other than prepare",
    (source) => replaceInJob(source, "publish", "    needs: prepare", "    needs: [prepare, release]"),
    "publish must depend only on prepare",
  );

  releaseMutationTest(
    "rejects a publish job outside the npm-publish environment",
    (source) => replaceInJob(source, "publish", "environment: npm-publish", "environment: release-automation"),
    "publish environment must be exactly npm-publish",
  );

  for (const [name, oldText, newText] of [
    ["rejects publish without actions read permission", "      actions: read\n", ""],
    ["rejects publish without id-token write permission", "      id-token: write\n", ""],
    ["rejects repository contents permission on publish", "      actions: read", "      actions: read\n      contents: read"],
  ]) {
    releaseMutationTest(
      name,
      (source) => replaceInJob(source, "publish", oldText, newText),
      "publish must have exactly actions:read and id-token:write",
    );
  }

  releaseMutationTest(
    "rejects a secret reference on publish",
    (source) => replaceInStep(
      source,
      "publish",
      "Validate prepared package metadata",
      "          ARTIFACT_ID: ${{ needs.prepare.outputs.artifact_id }}",
      "          ARTIFACT_ID: ${{ needs.prepare.outputs.artifact_id }}\n          NPM_AUTH: ${{ secrets.NPM_AUTH }}",
    ),
    "publish must not reference any secret",
  );

  releaseMutationTest(
    "rejects repository checkout in publish",
    (source) => replaceInStep(
      source,
      "publish",
      "Set up Node.js",
      "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
      "actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5",
    ),
    "publish must not check out repository contents",
  );

  for (const [name, command] of [
    ["rejects npm ci in publish", "npm ci"],
    ["rejects npm install in publish", "npm install left-pad"],
    ["rejects npm test in publish", "npm test"],
    ["rejects npm run in publish", "npm run verify:package"],
  ]) {
    releaseMutationTest(
      name,
      (source) => prependPublishCommand(source, command),
      "publish must not install dependencies or run repository npm scripts",
    );
  }

  releaseMutationTest(
    "rejects direct repository script execution in publish",
    (source) => prependPublishCommand(source, "node scripts/verify-package-contents.mjs"),
    "publish must not import repository scripts",
  );

  for (const [name, command, message] of [
    ["rejects git source checkout in publish", "git clone https://example.invalid/repository.git", "publish must not perform a source checkout"],
    ["rejects gh source checkout in publish", "gh repo clone example/repository", "publish must not perform a source checkout"],
    ["rejects curl source download in publish", "curl https://example.invalid/source.tar.gz", "publish must not download repository source"],
    ["rejects repository workspace access in publish", 'printf "%s\\n" "$GITHUB_WORKSPACE"', "publish must not read the repository workspace"],
  ]) {
    releaseMutationTest(name, (source) => prependPublishCommand(source, command), message);
  }

  releaseMutationTest(
    "rejects unaudited extra publish steps",
    (source) => replaceInJob(
      source,
      "publish",
      "      - name: Publish exact tarball to npm\n",
      "      - name: Unreviewed operation\n        run: echo safe\n\n      - name: Publish exact tarball to npm\n",
    ),
    "publish must contain only the audited artifact-verification and publication steps",
  );

  releaseMutationTest(
    "rejects a repository dependency cache in publish",
    (source) => replaceInStep(
      source,
      "publish",
      "Set up Node.js",
      "          registry-url: https://registry.npmjs.org",
      "          registry-url: https://registry.npmjs.org\n          cache: npm",
    ),
    "publish must not use a repository dependency cache",
  );

  for (const [name, oldText, newText] of [
    ["rejects missing prepared SemVer validation", '[[ "$EXPECTED_VERSION" =~ $SEMVER_PATTERN ]]', '[[ -n "$EXPECTED_VERSION" ]]'],
    ["rejects a prepared tag not bound to version", '[[ "$EXPECTED_TAG" == "v$EXPECTED_VERSION" ]]', '[[ -n "$EXPECTED_TAG" ]]'],
    ["rejects a prepared filename not bound to version", '[[ "$EXPECTED_TARBALL_FILENAME" == "pi-footer-display-$EXPECTED_VERSION.tgz" ]]', '[[ "$EXPECTED_TARBALL_FILENAME" == *.tgz ]]'],
    ["rejects weak prepared artifact ID validation", '[[ "$ARTIFACT_ID" =~ ^[1-9][0-9]*$ ]]', '[[ -n "$ARTIFACT_ID" ]]'],
    ["rejects weak prepared artifact name validation", '[[ "$ARTIFACT_NAME" =~ ^npm-package-[0-9]+-[0-9]+-[0-9A-Za-z.+-]+$ ]]', '[[ -n "$ARTIFACT_NAME" ]]'],
    ["rejects weak prepared tarball SHA validation", '[[ "$EXPECTED_SHA256" =~ ^[0-9a-f]{64}$ ]]', '[[ -n "$EXPECTED_SHA256" ]]'],
    ["rejects weak prepared artifact digest validation", '[[ "$EXPECTED_ARTIFACT_DIGEST" =~ ^[0-9a-f]{64}$ ]]', '[[ -n "$EXPECTED_ARTIFACT_DIGEST" ]]'],
  ]) {
    releaseMutationTest(
      name,
      (source) => replaceInStep(source, "publish", "Validate prepared package metadata", oldText, newText),
      "publish must validate every prepared identity output before artifact access",
    );
  }

  for (const [name, oldText, newText, message] of [
    ["rejects omission of stable dist-tag validation", "          latest)", "          stable)", "publish must validate the stable dist-tag"],
    ["rejects omission of prerelease dist-tag validation", "          next)", "          prerelease)", "publish must validate the prerelease dist-tag"],
  ]) {
    releaseMutationTest(
      name,
      (source) => replaceInStep(source, "publish", "Validate prepared package metadata", oldText, newText),
      message,
    );
  }

  releaseMutationTest(
    "rejects artifact API metadata not keyed by exact prepare outputs",
    (source) => replaceInStep(
      source,
      "publish",
      "Verify GitHub Actions artifact metadata",
      "          ARTIFACT_ID: ${{ needs.prepare.outputs.artifact_id }}",
      "          ARTIFACT_ID: 1",
    ),
    "artifact API verification must use exact prepare outputs and github.token",
  );

  releaseMutationTest(
    "rejects multiple artifact metadata API requests",
    (source) => transformStep(source, "publish", "Verify GitHub Actions artifact metadata", (step) => {
      const request = `          gh api \\\n            --method GET \\\n            --header "Accept: application/vnd.github+json" \\\n            --header "X-GitHub-Api-Version: 2022-11-28" \\\n            "repos/$GITHUB_REPOSITORY/actions/artifacts/$ARTIFACT_ID" > "$metadata_file"`;
      return replace(step, request, `${request}\n\n${request}`);
    }),
    "publish must make exactly one artifact metadata API request",
  );

  releaseMutationTest(
    "rejects artifact API lookup by anything except exact artifact ID",
    (source) => replaceInStep(
      source,
      "publish",
      "Verify GitHub Actions artifact metadata",
      '"repos/$GITHUB_REPOSITORY/actions/artifacts/$ARTIFACT_ID" > "$metadata_file"',
      '"repos/$GITHUB_REPOSITORY/actions/artifacts?name=$ARTIFACT_NAME" > "$metadata_file"',
    ),
    "artifact API request must address the exact repository artifact ID",
  );

  for (const [name, oldText, newText, message] of [
    [
      "rejects non-numeric server artifact IDs",
      `metadata_id="$(jq -er 'if (.id | type) == "number" then (.id | tostring) else error("invalid artifact id") end' "$metadata_file")"`,
      `metadata_id="$(jq -er 'if (.id | type) == "string" then .id else error("invalid artifact id") end' "$metadata_file")"`,
      "artifact API ID must be a number",
    ],
    [
      "rejects non-string server artifact names",
      `metadata_name="$(jq -er 'if (.name | type) == "string" then .name else error("invalid artifact name") end' "$metadata_file")"`,
      `metadata_name="$(jq -er '.name' "$metadata_file")"`,
      "artifact API name must be a string",
    ],
    [
      "rejects non-boolean server artifact expiration metadata",
      `metadata_expired="$(jq -er 'if (.expired | type) == "boolean" then (.expired | tostring) else error("invalid artifact expiration status") end' "$metadata_file")"`,
      `metadata_expired="$(jq -er '.expired' "$metadata_file")"`,
      "artifact expiration must be a boolean",
    ],
    [
      "rejects non-string server artifact digests",
      `metadata_digest="$(jq -er 'if (.digest | type) == "string" then .digest else error("invalid artifact digest") end' "$metadata_file")"`,
      `metadata_digest="$(jq -er '.digest' "$metadata_file")"`,
      "artifact digest must be a string",
    ],
  ]) {
    releaseMutationTest(
      name,
      (source) => replaceInStep(source, "publish", "Verify GitHub Actions artifact metadata", oldText, newText),
      message,
    );
  }

  releaseMutationTest(
    "rejects absent numeric validation for artifact workflow_run metadata",
    (source) => replaceInStep(
      source,
      "publish",
      "Verify GitHub Actions artifact metadata",
      `            if (.workflow_run.id | type) == "number" then\n              (.workflow_run.id | tostring)`,
      `            if (.workflow_run.id | type) == "string" then\n              .workflow_run.id`,
    ),
    "artifact workflow_run.id must be present and numeric",
  );

  releaseMutationTest(
    "rejects optional artifact workflow_run access even with a mandatory parser",
    (source) => replaceInStep(
      source,
      "publish",
      "Verify GitHub Actions artifact metadata",
      "          ' \"$metadata_file\")\"\n\n          [[ \"$metadata_id\"",
      "          ' \"$metadata_file\")\"\n          # .workflow_run? must never be optional\n\n          [[ \"$metadata_id\"",
    ),
    "artifact workflow_run.id must not be optional",
  );

  for (const [name, oldText, newText, message] of [
    ["rejects a server artifact ID mismatch", '[[ "$metadata_id" == "$ARTIFACT_ID" ]] || {', '[[ -n "$metadata_id" ]] || {', "artifact metadata ID must exactly match the prepared ID"],
    ["rejects a server artifact name mismatch", '[[ "$metadata_name" == "$ARTIFACT_NAME" ]] || {', '[[ -n "$metadata_name" ]] || {', "artifact metadata name must exactly match the prepared name"],
    ["rejects an expired server artifact", '[[ "$metadata_expired" == "false" ]] || {', '[[ -n "$metadata_expired" ]] || {', "expired artifacts must be rejected"],
    ["rejects a server artifact digest mismatch", '[[ "$metadata_digest" == "sha256:$EXPECTED_ARTIFACT_DIGEST" ]] || {', '[[ -n "$metadata_digest" ]] || {', "artifact metadata digest must exactly match the upload digest"],
    ["rejects an artifact not bound to the current workflow run", '[[ "$workflow_run_id" == "$GITHUB_RUN_ID" ]] || {', 'if [[ -n "$workflow_run_id" && "$workflow_run_id" != "$GITHUB_RUN_ID" ]]; then', "artifact workflow_run.id must exactly match GITHUB_RUN_ID"],
  ]) {
    releaseMutationTest(
      name,
      (source) => replaceInStep(source, "publish", "Verify GitHub Actions artifact metadata", oldText, newText),
      message,
    );
  }

  releaseMutationTest(
    "rejects an unapproved artifact download action",
    (source) => replaceInStep(
      source,
      "publish",
      "Download exact release tarball artifact",
      "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
      "actions/download-artifact@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ),
    "publish must use the approved download-artifact action",
  );

  releaseMutationTest(
    "rejects artifact download by name instead of exact ID",
    (source) => replaceInStep(
      source,
      "publish",
      "Download exact release tarball artifact",
      "          artifact-ids: ${{ needs.prepare.outputs.artifact_id }}",
      "          name: ${{ needs.prepare.outputs.artifact_name }}",
    ),
    "download must bind the exact artifact ID, workflow run, repository, and destination",
  );

  releaseMutationTest(
    "rejects downloaded tarball verification with substituted identity inputs",
    (source) => replaceInStep(
      source,
      "publish",
      "Verify downloaded release tarball",
      "          EXPECTED_PACKAGE_NAME: pi-footer-display",
      "          EXPECTED_PACKAGE_NAME: other-package",
    ),
    "download verification must consume the exact path, SHA, filename, name, and version",
  );

  for (const [name, oldText, newText, message] of [
    [
      "rejects a download action path outside the isolated destination",
      '[[ "$(realpath "$ACTION_DOWNLOAD_PATH")" == "$(realpath "$DOWNLOAD_DIR")" ]]',
      '[[ "$(realpath "$ACTION_DOWNLOAD_PATH")" != "$(realpath "$DOWNLOAD_DIR")" ]]',
      "download action path must match the isolated destination",
    ],
    [
      "rejects recursive downloaded artifact enumeration",
      'find "$DOWNLOAD_DIR" -mindepth 1 -maxdepth 1 -print0',
      'find "$DOWNLOAD_DIR" -mindepth 1 -maxdepth 2 -print0',
      "download must enumerate exactly one top-level entry",
    ],
    [
      "rejects multiple downloaded artifact entries",
      '(( ${#entries[@]} == 1 ))',
      '(( ${#entries[@]} >= 1 ))',
      "download must contain exactly one entry",
    ],
    [
      "rejects a downloaded tarball symlink",
      '[[ -f "$tarball_path" && ! -L "$tarball_path" ]]',
      '[[ -f "$tarball_path" ]]',
      "downloaded entry must be one regular non-symlink file",
    ],
    [
      "rejects a downloaded tarball filename mismatch",
      '[[ "$(basename "$tarball_path")" == "$EXPECTED_TARBALL_FILENAME" ]]',
      '[[ "$(basename "$tarball_path")" == *.tgz ]]',
      "downloaded tarball filename must match exactly",
    ],
    [
      "rejects a downloaded tarball SHA mismatch",
      '[[ "$actual_sha256" == "$EXPECTED_SHA256" ]]',
      '[[ -n "$actual_sha256" ]]',
      "downloaded tarball SHA-256 must match exactly",
    ],
    [
      "rejects tar path validation without POSIX normalization",
      "normalized = PurePosixPath(name)",
      "normalized = name",
      "tar paths must be normalized as POSIX paths",
    ],
    [
      "rejects tar path validation that permits absolute paths",
      "normalized.is_absolute()",
      "False",
      "absolute tar paths must be rejected",
    ],
    [
      "rejects tar members outside the package root",
      'parts[0] != "package"',
      '"package" not in parts',
      "tar members must remain under package",
    ],
    [
      "rejects unsafe tar path segments",
      'any(part in ("", ".", "..") for part in parts)',
      "False",
      "unsafe tar path segments must be rejected",
    ],
    [
      "rejects duplicate tar member paths",
      "if name in seen:",
      "if False:",
      "duplicate tar paths must be rejected",
    ],
    [
      "rejects unsafe tar member types",
      "if member.issym() or member.islnk() or not (member.isfile() or member.isdir()):",
      "if not (member.isfile() or member.isdir()):",
      "unsafe tar member types must be rejected",
    ],
    [
      "rejects an inexact package manifest tar path",
      'if name == "package/package.json":',
      'if name.endswith("package.json"):',
      "tarball must contain the exact package manifest path",
    ],
    [
      "rejects a tarball package name mismatch",
      'if package_json.get("name") != expected_name:',
      'if not package_json.get("name"):',
      "tarball package name must match exactly",
    ],
    [
      "rejects a tarball package version mismatch",
      'if package_json.get("version") != expected_version:',
      'if not package_json.get("version"):',
      "tarball package version must match exactly",
    ],
    [
      "rejects exporting any path other than the verified tarball",
      'echo "tarball_path=$tarball_path" >> "$GITHUB_OUTPUT"',
      'echo "tarball_path=$DOWNLOAD_DIR" >> "$GITHUB_OUTPUT"',
      "only the verified tarball path may reach publish",
    ],
  ]) {
    releaseMutationTest(
      name,
      (source) => replaceInStep(source, "publish", "Verify downloaded release tarball", oldText, newText),
      message,
    );
  }

  releaseMutationTest(
    "rejects publish metadata not bound to the verified tarball path",
    (source) => replaceInStep(
      source,
      "publish",
      "Publish exact tarball to npm",
      "          TARBALL_PATH: ${{ steps.verify.outputs.tarball_path }}",
      "          TARBALL_PATH: package.tgz",
    ),
    "publish must consume only the verified tarball path, SHA, and dist-tag",
  );

  releaseMutationTest(
    "rejects unexpected npm dist-tags at final publication",
    (source) => replaceInStep(source, "publish", "Publish exact tarball to npm", "latest|next", "latest|beta|next"),
    "publish must reject unexpected npm dist-tags",
  );

  releaseMutationTest(
    "rejects final publication without a regular-file recheck",
    (source) => replaceInStep(
      source,
      "publish",
      "Publish exact tarball to npm",
      '[[ -f "$TARBALL_PATH" && ! -L "$TARBALL_PATH" ]]',
      '[[ -f "$TARBALL_PATH" ]]',
    ),
    "publish must recheck that the tarball is a regular file",
  );

  releaseMutationTest(
    "rejects final publication without an exact SHA recheck",
    (source) => replaceInStep(
      source,
      "publish",
      "Publish exact tarball to npm",
      '[[ "$(sha256sum "$TARBALL_PATH" | awk \'{print $1}\')" == "$EXPECTED_SHA256" ]]',
      '[[ -n "$EXPECTED_SHA256" ]]',
    ),
    "publish must recheck the exact tarball SHA-256",
  );

  releaseMutationTest(
    "rejects final npm publish without --ignore-scripts",
    (source) => replaceInStep(
      source,
      "publish",
      "Publish exact tarball to npm",
      'npm publish "$TARBALL_PATH" --access public --provenance --tag "$DIST_TAG" --ignore-scripts',
      'npm publish "$TARBALL_PATH" --access public --provenance --tag "$DIST_TAG"',
    ),
    "publish must publish the exact verified tarball once with provenance, validated dist-tag, and lifecycle scripts disabled",
  );

  releaseMutationTest(
    "rejects any second npm publish command",
    (source) => replaceInStep(
      source,
      "publish",
      "Publish exact tarball to npm",
      '          npm publish "$TARBALL_PATH" --access public --provenance --tag "$DIST_TAG" --ignore-scripts',
      '          npm publish "$TARBALL_PATH" --access public --provenance --tag "$DIST_TAG" --ignore-scripts\n          npm publish "$TARBALL_PATH"',
    ),
    "release workflow must contain exactly one npm publish command",
  );

  releaseMutationTest(
    "rejects any additional github.token use",
    (source) => `${source}\n# \${{ github.token }}\n`,
    "github.token may be used only for recovery and exact artifact verification/download",
  );

  for (const [name, marker] of [
    ["rejects a GITHUB_TOKEN secret fallback", "secrets.GITHUB_TOKEN"],
    ["rejects an NPM_TOKEN fallback", "NPM_TOKEN"],
  ]) {
    pullRequestMutationTest(
      name,
      (source) => `${source}\n# ${marker}\n`,
      "GITHUB_TOKEN secret fallback and NPM_TOKEN are forbidden",
    );
  }

  pullRequestMutationTest(
    "rejects a mutable action reference",
    (source) => replace(source, "actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5", "actions/checkout@v4"),
    "action must be pinned to a full commit SHA: actions/checkout@v4",
  );

  pullRequestMutationTest(
    "rejects an unapproved action commit",
    (source) => replace(
      source,
      "actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5",
      "actions/checkout@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ),
    "action pin is not approved: actions/checkout@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );

  pullRequestMutationTest(
    "rejects an unpinned actionlint archive version",
    (source) => replace(source, "ACTIONLINT_VERSION: 1.7.7", "ACTIONLINT_VERSION: latest"),
    "actionlint must use the approved pinned version",
  );

  pullRequestMutationTest(
    "rejects an unverified actionlint archive",
    (source) => replace(
      source,
      "ACTIONLINT_SHA256: 023070a287cd8cccd71515fedc843f1985bf96c436b7effaecce67290e7e0757",
      "ACTIONLINT_SHA256: unverified",
    ),
    "actionlint archive must have a pinned checksum",
  );

  releaseMutationTest(
    "rejects an undocumented Release Please version dependency",
    (source) => replaceInJob(
      source,
      "prepare",
      "RELEASE_TAG: ${{ needs.release.outputs.tag_name }}",
      "RELEASE_TAG: ${{ needs.release.outputs.version }}",
    ),
    "release version must never depend on the undocumented Release Please version output",
  );

  releaseMutationTest(
    "rejects tags without an exact v-prefixed SemVer pattern",
    (source) => replaceInStep(source, "prepare", "Resolve release target", "SEMVER_PATTERN='^v", "SEMVER_PATTERN='^"),
    "all release tags must be exact v-prefixed semantic versions",
  );

  releaseMutationTest(
    "rejects version derivation before stripping a validated v prefix",
    (source) => replaceInStep(
      source,
      "prepare",
      "Resolve release target",
      'VERSION="${TARGET_TAG#v}"',
      'VERSION="$TARGET_TAG"',
    ),
    "version must be derived only after strict validation by stripping v from the release tag",
  );

  releaseMutationTest(
    "rejects normal release handling that accepts a missing tag",
    (source) => replaceInStep(
      source,
      "prepare",
      "Resolve release target",
      `if [[ -z "$TARGET_TAG" ]]; then\n              echo "Release Please did not emit a tag" >&2\n              exit 1\n            fi`,
      `if [[ -z "$TARGET_TAG" ]]; then\n              echo "Release Please did not emit a tag" >&2\n            fi`,
    ),
    "normal prepare must fail when Release Please emits no tag",
  );

  releaseMutationTest(
    "rejects malformed tag handling that does not fail",
    (source) => replaceInStep(
      source,
      "prepare",
      "Resolve release target",
      `if [[ ! "$TARGET_TAG" =~ $SEMVER_PATTERN ]]; then\n            echo "Release tag must be an exact v-prefixed semantic version: $TARGET_TAG" >&2\n            exit 1\n          fi`,
      `if [[ ! "$TARGET_TAG" =~ $SEMVER_PATTERN ]]; then\n            echo "Ignoring malformed tag: $TARGET_TAG"\n          fi`,
    ),
    "malformed normal and recovery tags must fail before version derivation",
  );

  releaseMutationTest(
    "rejects tag verification that does not use the checked-out tag commit",
    (source) => replaceInStep(
      source,
      "prepare",
      "Verify exact release tag and main ancestry",
      'git rev-parse "refs/tags/$TARGET_TAG^{commit}"',
      "git rev-parse HEAD",
    ),
    "prepare must verify the checked-out tag commit",
  );

  releaseMutationTest(
    "rejects release tags outside main ancestry",
    (source) => replaceInStep(
      source,
      "prepare",
      "Verify exact release tag and main ancestry",
      "git merge-base --is-ancestor HEAD refs/remotes/origin/main",
      "git merge-base --is-ancestor HEAD HEAD",
    ),
    "prepare must reject release tags outside main history",
  );

  releaseMutationTest(
    "rejects npm absence handling without structured E404",
    (source) => replaceInStep(
      source,
      "prepare",
      "Check npm package availability",
      `          if ! node --input-type=module - "$output_file" <<'NODE'\n          import fs from "node:fs";\n          const payload = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));\n          if (payload?.error?.code !== "E404") process.exit(1);`,
      `          if ! node --input-type=module - "$output_file" <<'NODE'\n          import fs from "node:fs";\n          const payload = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));\n          process.exit(0);`,
    ),
    "only structured npm E404 responses may be treated as absent",
  );

  releaseMutationTest(
    "rejects duplicate normal publish handling that does not fail",
    (source) => replaceInStep(
      source,
      "prepare",
      "Check npm package availability",
      "refusing duplicate normal publish",
      "duplicate ignored",
    ),
    "normal mode must fail on an existing package version",
  );

  releaseMutationTest(
    "rejects prereleases routed to latest",
    (source) => replaceInStep(source, "prepare", "Resolve release target", "DIST_TAG=next", "DIST_TAG=latest"),
    "prerelease versions must use the safe next dist-tag",
  );

  for (const [name, oldText, newText, message] of [
    ["rejects a fixed latest lookup for all candidates", '"dist-tags.$DIST_TAG"', '"dist-tags.latest"', "latest and next must query their current npm dist-tag"],
    ["rejects a fixed next lookup for all candidates", '"dist-tags.$DIST_TAG"', '"dist-tags.next"', "latest and next must query their current npm dist-tag"],
    ["rejects replacement of the SemVer comparator", 'node scripts/compare-semver.mjs "$VERSION" "$CURRENT_VERSION"', "printf 1", "dist-tag versions must use the deterministic SemVer comparator"],
    ["rejects lower-version dist-tag regression", 'exit 1\n                ;;\n              0)', ';;\n              0)', "lower versions must not regress latest or next"],
    ["rejects equal-version inconsistent npm state", 'exit 1\n                ;;\n              *)', ';;\n              *)', "equal dist-tag versions must fail closed"],
  ]) {
    releaseMutationTest(
      name,
      (source) => replaceInStep(source, "prepare", "Check npm package availability", oldText, newText),
      message,
    );
  }

  test("rejects unsafe package publishing metadata or missing script wiring", () => {
    const privatePackage = structuredClone(valid.packageJson);
    privatePackage.private = true;
    rejects({ packageJson: privatePackage }, "package.json must not be private");

    const noProvenance = structuredClone(valid.packageJson);
    noProvenance.publishConfig.provenance = false;
    rejects({ packageJson: noProvenance }, "package.json must enable publishConfig.provenance");

    const noWorkflowTests = structuredClone(valid.packageJson);
    noWorkflowTests.scripts["test:tooling"] = "node --test tests/tooling/release-version.test.mjs";
    rejects({ packageJson: noWorkflowTests }, "workflow tests must be wired into test:tooling");
  });
});
