import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const ACTION_PINS = Object.freeze({
  "actions/checkout": "34e114876b0b11c390a56381ad16ebd13914f8d5",
  "actions/create-github-app-token": "fee1f7d63c2ff003460e3d139729b119787bc349",
  "actions/download-artifact": "d3f86a106a0bac45b974a628896c90dbdf5c8093",
  "actions/setup-node": "49933ea5288caeca8642d1e84afbd3f7d6820020",
  "actions/upload-artifact": "ea165f8d65b6e75b540449e92b4886f43607fa02",
  "googleapis/release-please-action": "5c625bfb5d1ff62eadeeb3772007f7f66fdcf071",
});

const RELEASE_GATE = "${{ vars.RELEASE_AUTOMATION_ENABLED == 'true' && vars.NPM_TRUSTED_PUBLISHING_READY == 'true' && github.ref == 'refs/heads/main' && (github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && inputs.tag == '')) }}";
const PREPARE_GATE = "${{ always() && vars.RELEASE_AUTOMATION_ENABLED == 'true' && vars.NPM_TRUSTED_PUBLISHING_READY == 'true' && github.ref == 'refs/heads/main' && ((needs.release.result == 'success' && needs.release.outputs.release_created == 'true') || (github.event_name == 'workflow_dispatch' && inputs.tag != '')) }}";
const PUBLISH_GATE = "${{ needs.prepare.result == 'success' && needs.prepare.outputs.should_publish == 'true' && vars.RELEASE_AUTOMATION_ENABLED == 'true' && vars.NPM_TRUSTED_PUBLISHING_READY == 'true' && github.ref == 'refs/heads/main' }}";
const TAG_SEMVER_PATTERN = "SEMVER_PATTERN='^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(\\+[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$'";

function invariant(condition, message) {
  if (!condition) throw new Error(`Workflow invariant failed: ${message}`);
}

function includes(source, fragment, message) {
  invariant(source.includes(fragment), message);
}

function occurrences(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function jobBlock(source, jobName) {
  const marker = new RegExp(`^  ${escapeRegExp(jobName)}:\\n`, "gm");
  const matches = [...source.matchAll(marker)];
  invariant(matches.length === 1, `release workflow must define the ${jobName} job exactly once`);
  const start = matches[0].index;
  const remainder = source.slice(start + matches[0][0].length);
  const nextJob = remainder.search(/^  [A-Za-z0-9_-]+:\n/m);
  return source.slice(start, nextJob === -1 ? source.length : start + matches[0][0].length + nextJob);
}

function stepBlock(job, stepName) {
  const marker = new RegExp(`^      - name: ${escapeRegExp(stepName)}\\n`, "gm");
  const matches = [...job.matchAll(marker)];
  invariant(matches.length === 1, `the ${stepName} step must appear exactly once`);
  const start = matches[0].index;
  const remainder = job.slice(start + matches[0][0].length);
  const nextStep = remainder.search(/^      - /m);
  return job.slice(start, nextStep === -1 ? job.length : start + matches[0][0].length + nextStep);
}

function stepNames(job) {
  return [...job.matchAll(/^      - name: ([^\n]+)$/gm)].map((match) => match[1]);
}

function directValues(job, key) {
  const prefix = `    ${key}:`;
  return job
    .split("\n")
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length).trim());
}

function assertDirectValue(job, key, expected, message) {
  const values = directValues(job, key);
  invariant(values.length === 1 && values[0] === expected, message);
}

function assertNoDirectValue(job, key, message) {
  invariant(directValues(job, key).length === 0, message);
}

function mappingEntries(source, key, parentIndent, childIndent, message) {
  const lines = source.split("\n");
  const parent = `${" ".repeat(parentIndent)}${key}:`;
  const indexes = lines.flatMap((line, index) => line === parent ? [index] : []);
  invariant(indexes.length === 1, message);

  const entries = [];
  const childPattern = new RegExp(`^ {${childIndent}}([^ :][^:]*):(?: (.*))?$`);
  for (let index = indexes[0] + 1; index < lines.length; index += 1) {
    const match = childPattern.exec(lines[index]);
    if (!match) break;
    entries.push([match[1], match[2] ?? ""]);
  }
  invariant(entries.length > 0, message);
  return entries;
}

function assertMapping(source, key, parentIndent, childIndent, expected, message) {
  const actual = mappingEntries(source, key, parentIndent, childIndent, message);
  invariant(JSON.stringify(actual) === JSON.stringify(expected), message);
}

function assertJobPermissions(job, expected, message) {
  assertMapping(job, "permissions", 4, 6, expected, message);
}

function assertImmutableActionPins(source) {
  const uses = [...source.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)].map((match) => match[1]);
  invariant(uses.length > 0, "workflows must use pinned actions");
  for (const use of uses) {
    const match = /^([^@]+)@([0-9a-f]{40})$/.exec(use);
    invariant(match, `action must be pinned to a full commit SHA: ${use}`);
    const [, action, sha] = match;
    invariant(ACTION_PINS[action] === sha, `action pin is not approved: ${use}`);
  }
}

function assertPublishSourceIsolation(publish) {
  const forbidden = [
    [/actions\/checkout@/i, "publish must not check out repository contents"],
    [/\bnpm\s+(?:ci|install|test|run)\b/m, "publish must not install dependencies or run repository npm scripts"],
    [/\b(?:\.\/)?scripts\//, "publish must not import repository scripts"],
    [/(?:^|[\s;&|])git\s+(?:clone|checkout|switch|fetch|pull|reset|restore|archive)\b/m, "publish must not perform a source checkout"],
    [/\bgh\s+repo\s+(?:clone|sync)\b/, "publish must not perform a source checkout"],
    [/\b(?:curl|wget)\b/, "publish must not download repository source"],
    [/(?:GITHUB_WORKSPACE|github\.workspace)/, "publish must not read the repository workspace"],
  ];
  for (const [pattern, message] of forbidden) invariant(!pattern.test(publish), message);
}

export function verifyWorkflowSources({ pullRequest, release, packageJson }) {
  invariant(typeof pullRequest === "string", "pull-request.yml must be readable");
  invariant(typeof release === "string", "release-please.yml must be readable");

  const eventBlock = pullRequest.match(/pull_request:\n\s+types:\n((?:\s+- [^\n]+\n?)+)/)?.[1] ?? "";
  const events = [...eventBlock.matchAll(/- ([^\s]+)/g)].map((match) => match[1]);
  invariant(
    JSON.stringify(events) === JSON.stringify(["opened", "edited", "synchronize", "reopened", "ready_for_review"]),
    "pull requests must run on exactly the approved activity types",
  );
  assertMapping(pullRequest, "permissions", 0, 2, [["contents", "read"]], "pull-request workflow must have contents:read only");
  includes(pullRequest, "name: Validate PR title", "Conventional Commit title job is required");
  includes(pullRequest, "const conventionalTitle = /^(feat|fix|perf|revert|docs|style|refactor|test|chore|release)", "title validation must enforce Conventional Commits");
  includes(pullRequest, "node-version: 22.19.0", "pull-request workflow must use Node 22.19.0");
  includes(pullRequest, "cache: npm", "pull-request workflow must enable the npm cache");
  for (const command of ["npm ci", "npm run verify:release-version", "npm test", "npm run verify:package"]) {
    includes(pullRequest, `run: ${command}`, `pull-request workflow must run ${command}`);
  }
  includes(pullRequest, "ACTIONLINT_VERSION: 1.7.7", "actionlint must use the approved pinned version");
  includes(pullRequest, "ACTIONLINT_SHA256: 023070a287cd8cccd71515fedc843f1985bf96c436b7effaecce67290e7e0757", "actionlint archive must have a pinned checksum");
  includes(pullRequest, '"$RUNNER_TEMP/actionlint"', "pull-request workflow must run actionlint");

  const releaseEventBlock = release.match(/^on:\n([\s\S]*?)(?=^\S)/m)?.[1] ?? "";
  const releaseEvents = [...releaseEventBlock.matchAll(/^  ([a-z_]+):/gm)].map((match) => match[1]);
  invariant(
    JSON.stringify(releaseEvents) === JSON.stringify(["push", "workflow_dispatch"]),
    "release workflow must run only on pushes and manual dispatches, never pull requests",
  );
  includes(release, "push:\n    branches:\n      - main", "release workflow must run on pushes to main");
  includes(release, "workflow_dispatch:\n    inputs:\n      tag:", "release workflow must accept an optional recovery tag");
  includes(release, "required: false\n        default: \"\"", "recovery tag must default to empty");
  invariant(occurrences(release, /^permissions: \{\}$/gm) === 1, "release workflow must deny permissions by default");

  const jobsStart = release.indexOf("\njobs:\n");
  invariant(jobsStart !== -1, "release workflow must define jobs");
  const jobsSource = release.slice(jobsStart + 7);
  const jobIds = [...jobsSource.matchAll(/^  ([A-Za-z0-9_-]+):\n/gm)].map((match) => match[1]);
  invariant(JSON.stringify(jobIds) === JSON.stringify(["release", "prepare", "publish"]), "release workflow must contain exactly release, prepare, and publish jobs");
  const releaseJob = jobBlock(release, "release");
  const prepare = jobBlock(release, "prepare");
  const publish = jobBlock(release, "publish");

  assertDirectValue(releaseJob, "if", RELEASE_GATE, "release job must use the exact dual gate and main-ref event gate");
  assertDirectValue(releaseJob, "environment", "release-automation", "release environment must be exactly release-automation");
  assertJobPermissions(releaseJob, [["contents", "read"]], "release job must have contents:read only");
  assertMapping(releaseJob, "outputs", 4, 6, [
    ["release_created", "${{ steps.release.outputs.release_created }}"],
    ["tag_name", "${{ steps.release.outputs.tag_name }}"],
  ], "release job must expose only documented release_created and tag_name outputs");

  const releaseTokenStep = stepBlock(releaseJob, "Create nerv-ops installation token");
  includes(releaseTokenStep, "uses: actions/create-github-app-token@fee1f7d63c2ff003460e3d139729b119787bc349", "release must use the approved App-token action");
  assertMapping(releaseTokenStep, "with", 8, 10, [
    ["app-id", "${{ vars.NERV_OPS_APP_ID }}"],
    ["private-key", "${{ secrets.NERV_OPS_PRIVATE_KEY }}"],
    ["permission-contents", "write"],
    ["permission-issues", "write"],
    ["permission-pull-requests", "write"],
  ], "release App token must use the environment-scoped key and exact least privileges");
  includes(releaseJob, "token: ${{ steps.app-token.outputs.token }}", "Release Please must use only the App installation token");
  includes(releaseJob, "config-file: release-please-config.json", "Release Please config is required");
  includes(releaseJob, "manifest-file: .release-please-manifest.json", "Release Please manifest is required");
  includes(releaseJob, 'gh pr merge "$number" --repo "$GITHUB_REPOSITORY" --auto --squash', "release PRs must enable squash auto-merge");
  invariant(!/(?:steps\.release|needs\.release)\.outputs\.version/.test(release), "release version must never depend on the undocumented Release Please version output");

  assertDirectValue(prepare, "needs", "release", "prepare must depend only on release");
  assertDirectValue(prepare, "if", PREPARE_GATE, "prepare must use the exact main-ref dual gate");
  assertNoDirectValue(prepare, "environment", "prepare must not use a credential-bearing environment");
  assertJobPermissions(prepare, [["contents", "read"]], "prepare must have contents:read only");
  invariant(!/\bid-token\b/.test(prepare), "prepare must not receive an OIDC token");
  invariant(!/\bsecrets(?:\.|\[)/.test(prepare), "prepare must not reference secrets");
  invariant(!/(?:create-github-app-token|NERV_OPS_(?:APP_ID|PRIVATE_KEY)|private-key:|steps\.app-token)/.test(prepare), "prepare must not create or consume an App token");
  assertMapping(prepare, "outputs", 4, 6, [
    ["should_publish", "${{ steps.availability.outputs.should_publish }}"],
    ["tag", "${{ steps.target.outputs.tag }}"],
    ["version", "${{ steps.target.outputs.version }}"],
    ["dist_tag", "${{ steps.target.outputs.dist_tag }}"],
    ["artifact_id", "${{ steps.upload.outputs.artifact-id }}"],
    ["artifact_digest", "${{ steps.upload.outputs.artifact-digest }}"],
    ["artifact_name", "${{ steps.package.outputs.artifact_name }}"],
    ["tarball_filename", "${{ steps.package.outputs.tarball_filename }}"],
    ["tarball_sha256", "${{ steps.package.outputs.tarball_sha256 }}"],
  ], "prepare outputs must preserve the exact release and artifact identity");

  includes(prepare, "RELEASE_TAG: ${{ needs.release.outputs.tag_name }}", "normal prepare must use the documented Release Please tag_name output");
  includes(prepare, 'if [[ -z "$TARGET_TAG" ]]; then\n              echo "Release Please did not emit a tag" >&2\n              exit 1\n            fi', "normal prepare must fail when Release Please emits no tag");
  includes(prepare, TAG_SEMVER_PATTERN, "all release tags must be exact v-prefixed semantic versions");
  includes(prepare, 'if [[ ! "$TARGET_TAG" =~ $SEMVER_PATTERN ]]; then\n            echo "Release tag must be an exact v-prefixed semantic version: $TARGET_TAG" >&2\n            exit 1\n          fi', "malformed normal and recovery tags must fail before version derivation");
  const tagValidation = prepare.indexOf('if [[ ! "$TARGET_TAG" =~ $SEMVER_PATTERN ]]');
  const versionDerivation = prepare.indexOf('VERSION="${TARGET_TAG#v}"');
  invariant(tagValidation !== -1 && versionDerivation > tagValidation, "version must be derived only after strict validation by stripping v from the release tag");

  const recoveryStep = stepBlock(prepare, "Verify recovery GitHub release");
  assertMapping(recoveryStep, "env", 8, 10, [
    ["GH_TOKEN", "${{ github.token }}"],
    ["TARGET_TAG", "${{ steps.target.outputs.tag }}"],
  ], "recovery must use only github.token and the validated target tag");
  includes(recoveryStep, 'gh release view "$TARGET_TAG" --repo "$GITHUB_REPOSITORY" --json isDraft,tagName', "recovery must verify an existing GitHub release");
  includes(recoveryStep, '[[ "$(jq -r \'.tagName\' <<< "$release")" == "$TARGET_TAG" ]] || {', "recovery release tag must match exactly");
  includes(recoveryStep, '[[ "$(jq -r \'.isDraft\' <<< "$release")" == "false" ]] || {', "recovery must reject draft releases");
  invariant(!/(?:create-github-app-token|private-key|NERV_OPS)/.test(recoveryStep), "recovery must not use an App key or App token");

  const checkoutStep = stepBlock(prepare, "Check out exact release tag");
  includes(checkoutStep, "uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5", "prepare must use the approved checkout action");
  assertMapping(checkoutStep, "with", 8, 10, [
    ["ref", "${{ steps.target.outputs.tag }}"],
    ["fetch-depth", "0"],
    ["persist-credentials", "false"],
  ], "prepare checkout must use the exact tag, full history, and no persisted credentials");
  includes(prepare, "node-version: 24.7.0", "prepare must use the approved Node version with bundled trusted-publishing npm");
  includes(prepare, "registry-url: https://registry.npmjs.org", "prepare must target the npm registry");
  includes(prepare, "cache: npm", "prepare may cache dependencies before source verification");
  includes(prepare, "const minimum = [11, 5, 1];", "prepare must verify npm trusted-publishing support");
  invariant(!/npm install --global/.test(prepare), "prepare must not replace the bundled npm client");
  for (const command of ["run: npm ci", "run: npm test", "npm run verify:release-version -- --expected", "run: npm run verify:package"]) {
    includes(prepare, command, `prepare must run ${command.replace(/^run: /, "")}`);
  }
  includes(prepare, 'EXPECTED_TAG="v${VERSION}"', "prepare must derive the exact v-prefixed version tag");
  includes(prepare, 'git rev-parse "refs/tags/$TARGET_TAG^{commit}"', "prepare must verify the checked-out tag commit");
  includes(prepare, "git merge-base --is-ancestor HEAD refs/remotes/origin/main", "prepare must reject release tags outside main history");
  includes(prepare, 'if [[ "$VERSION" == *-* ]]', "prerelease versions must be detected from exact SemVer metadata");
  includes(prepare, "DIST_TAG=next", "prerelease versions must use the safe next dist-tag");
  includes(prepare, "DIST_TAG=latest", "stable versions must explicitly use the latest dist-tag");
  includes(prepare, 'npm view "$PACKAGE_NAME@$VERSION" version --json', "prepare must query npm before preparing a publish");
  includes(prepare, 'if [[ "$RECOVERY" == "true" ]]; then', "an existing package must make recovery a no-op");
  includes(prepare, "refusing duplicate normal publish", "normal mode must fail on an existing package version");
  invariant(occurrences(prepare, /payload\?\.error\?\.code !== "E404"/g) === 2, "only structured npm E404 responses may be treated as absent");
  includes(prepare, 'npm view "$PACKAGE_NAME" "dist-tags.$DIST_TAG" --json', "latest and next must query their current npm dist-tag");
  includes(prepare, 'node scripts/compare-semver.mjs "$VERSION" "$CURRENT_VERSION"', "dist-tag versions must use the deterministic SemVer comparator");
  includes(prepare, '-1)\n                echo "$VERSION is lower than current $DIST_TAG version $CURRENT_VERSION; refusing dist-tag regression." >&2\n                exit 1', "lower versions must not regress latest or next");
  includes(prepare, '0)\n                echo "$VERSION equals current $DIST_TAG version $CURRENT_VERSION after the exact-version absence check; refusing inconsistent npm state." >&2\n                exit 1', "equal dist-tag versions must fail closed");

  const packageStep = stepBlock(prepare, "Build and validate release tarball");
  invariant(occurrences(prepare, /^\s+npm pack\s/gm) === 1, "prepare must run npm pack exactly once");
  includes(packageStep, 'npm pack --ignore-scripts --json --pack-destination "$output_dir" > "$pack_json"', "prepare must pack once with lifecycle scripts disabled into an isolated directory");
  includes(packageStep, 'import { assertPackageContents, assertPackageMetadata } from "./scripts/verify-package-contents.mjs";', "prepare must import the exact package audit implementation");
  includes(packageStep, "if (!Array.isArray(payload) || payload.length !== 1)", "prepare must require exactly one npm pack result");
  includes(packageStep, "if (packageJson.version !== expectedVersion || packageData.version !== expectedVersion)", "prepare must audit the exact package version");
  includes(packageStep, "const paths = assertPackageContents(packageData.files);", "prepare must audit the exact package file allowlist");
  includes(packageStep, "assertPackageMetadata(packageData, packageJson, paths.length);", "prepare must audit exact package metadata");
  includes(packageStep, "entries.length !== 1 || !entries[0].isFile() || entries[0].name !== packageData.filename", "prepare output must contain exactly the npm-reported tarball");
  includes(packageStep, "!stat.isFile() || stat.isSymbolicLink() || stat.size < 1", "prepared tarball must be one non-empty regular file");
  includes(packageStep, "path.dirname(fs.realpathSync(tarballPath)) !== fs.realpathSync(outputDir)", "prepared tarball must remain in the isolated output directory");
  includes(packageStep, '[[ "$package_name" == "pi-footer-display" ]]', "prepared package name must be exact");
  includes(packageStep, '[[ "$tarball_filename" == "$package_name-$EXPECTED_VERSION.tgz" ]]', "prepared tarball filename must match name and version");
  includes(packageStep, '[[ -f "$tarball_path" && ! -L "$tarball_path" ]]', "prepared tarball path must remain a regular file");
  includes(packageStep, 'tarball_sha256="$(sha256sum "$tarball_path" | awk \'{print $1}\')"', "prepare must hash the exact tarball");
  includes(packageStep, 'artifact_name="npm-package-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${EXPECTED_VERSION}"', "artifact name must bind run, attempt, and version");

  const uploadStep = stepBlock(prepare, "Upload release tarball");
  includes(uploadStep, "uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02", "prepare must use the approved upload-artifact action");
  assertMapping(uploadStep, "with", 8, 10, [
    ["name", "${{ steps.package.outputs.artifact_name }}"],
    ["path", "${{ steps.package.outputs.tarball_path }}"],
    ["if-no-files-found", "error"],
    ["retention-days", "1"],
    ["compression-level", "0"],
  ], "upload must use the exact prepared tarball and fail-closed artifact settings");
  const uploadValidationStep = stepBlock(prepare, "Validate uploaded artifact outputs");
  includes(uploadValidationStep, '[[ "$ARTIFACT_ID" =~ ^[1-9][0-9]*$ ]]', "upload must return a valid artifact ID");
  includes(uploadValidationStep, '[[ "$ARTIFACT_DIGEST" =~ ^[0-9a-f]{64}$ ]]', "upload must return a valid artifact digest");

  assertDirectValue(publish, "needs", "prepare", "publish must depend only on prepare");
  assertDirectValue(publish, "if", PUBLISH_GATE, "publish must use the exact main-ref dual gate and successful prepare outputs");
  assertDirectValue(publish, "environment", "npm-publish", "publish environment must be exactly npm-publish");
  assertJobPermissions(publish, [["actions", "read"], ["id-token", "write"]], "publish must have exactly actions:read and id-token:write");
  invariant(occurrences(release, /^\s+id-token: write$/gm) === 1, "only publish may grant id-token:write");
  invariant(occurrences(release, /^\s+actions: read$/gm) === 1, "only publish may grant actions:read");
  invariant(occurrences(release, /^\s+contents: read$/gm) === 2, "only release and prepare may grant contents:read");
  invariant(!/\bsecrets(?:\.|\[)/.test(publish), "publish must not reference any secret");
  invariant(!/\bcontents:\s*(?:read|write)\b/.test(publish), "publish must not receive repository contents permission");
  assertPublishSourceIsolation(publish);
  invariant(JSON.stringify(stepNames(publish)) === JSON.stringify([
    "Set up Node.js",
    "Verify bundled npm supports trusted publishing",
    "Validate prepared package metadata",
    "Verify GitHub Actions artifact metadata",
    "Download exact release tarball artifact",
    "Verify downloaded release tarball",
    "Publish exact tarball to npm",
  ]), "publish must contain only the audited artifact-verification and publication steps");
  includes(publish, "node-version: 24.7.0", "publish must use the approved Node version with bundled trusted-publishing npm");
  includes(publish, "registry-url: https://registry.npmjs.org", "publish must target the npm registry");
  invariant(!/^\s+cache:/m.test(publish), "publish must not use a repository dependency cache");
  includes(publish, "const minimum = [11, 5, 1];", "publish must verify npm trusted-publishing support");

  const preparedMetadataStep = stepBlock(publish, "Validate prepared package metadata");
  for (const fragment of [
    '[[ "$EXPECTED_VERSION" =~ $SEMVER_PATTERN ]]',
    '[[ "$EXPECTED_TAG" == "v$EXPECTED_VERSION" ]]',
    '[[ "$EXPECTED_TARBALL_FILENAME" == "pi-footer-display-$EXPECTED_VERSION.tgz" ]]',
    '[[ "$ARTIFACT_ID" =~ ^[1-9][0-9]*$ ]]',
    '[[ "$ARTIFACT_NAME" =~ ^npm-package-[0-9]+-[0-9]+-[0-9A-Za-z.+-]+$ ]]',
    '[[ "$EXPECTED_SHA256" =~ ^[0-9a-f]{64}$ ]]',
    '[[ "$EXPECTED_ARTIFACT_DIGEST" =~ ^[0-9a-f]{64}$ ]]',
  ]) includes(preparedMetadataStep, fragment, "publish must validate every prepared identity output before artifact access");
  includes(preparedMetadataStep, "latest)", "publish must validate the stable dist-tag");
  includes(preparedMetadataStep, "next)", "publish must validate the prerelease dist-tag");

  const artifactMetadataStep = stepBlock(publish, "Verify GitHub Actions artifact metadata");
  assertMapping(artifactMetadataStep, "env", 8, 10, [
    ["ARTIFACT_ID", "${{ needs.prepare.outputs.artifact_id }}"],
    ["ARTIFACT_NAME", "${{ needs.prepare.outputs.artifact_name }}"],
    ["EXPECTED_ARTIFACT_DIGEST", "${{ needs.prepare.outputs.artifact_digest }}"],
    ["GH_TOKEN", "${{ github.token }}"],
  ], "artifact API verification must use exact prepare outputs and github.token");
  invariant(occurrences(artifactMetadataStep, /\bgh api \\/g) === 1, "publish must make exactly one artifact metadata API request");
  includes(artifactMetadataStep, '"repos/$GITHUB_REPOSITORY/actions/artifacts/$ARTIFACT_ID" > "$metadata_file"', "artifact API request must address the exact repository artifact ID");
  includes(artifactMetadataStep, 'metadata_id="$(jq -er \'if (.id | type) == "number" then (.id | tostring) else error("invalid artifact id") end\' "$metadata_file")"', "artifact API ID must be a number");
  includes(artifactMetadataStep, 'metadata_name="$(jq -er \'if (.name | type) == "string" then .name else error("invalid artifact name") end\' "$metadata_file")"', "artifact API name must be a string");
  includes(artifactMetadataStep, 'metadata_expired="$(jq -er \'if (.expired | type) == "boolean" then (.expired | tostring) else error("invalid artifact expiration status") end\' "$metadata_file")"', "artifact expiration must be a boolean");
  includes(artifactMetadataStep, 'metadata_digest="$(jq -er \'if (.digest | type) == "string" then .digest else error("invalid artifact digest") end\' "$metadata_file")"', "artifact digest must be a string");
  includes(artifactMetadataStep, 'if (.workflow_run.id | type) == "number" then\n              (.workflow_run.id | tostring)', "artifact workflow_run.id must be present and numeric");
  invariant(!/\.workflow_run(?:\.id)?\?/.test(artifactMetadataStep), "artifact workflow_run.id must not be optional");
  includes(artifactMetadataStep, '[[ "$metadata_id" == "$ARTIFACT_ID" ]] || {', "artifact metadata ID must exactly match the prepared ID");
  includes(artifactMetadataStep, '[[ "$metadata_name" == "$ARTIFACT_NAME" ]] || {', "artifact metadata name must exactly match the prepared name");
  includes(artifactMetadataStep, '[[ "$metadata_expired" == "false" ]] || {', "expired artifacts must be rejected");
  includes(artifactMetadataStep, '[[ "$metadata_digest" == "sha256:$EXPECTED_ARTIFACT_DIGEST" ]] || {', "artifact metadata digest must exactly match the upload digest");
  includes(artifactMetadataStep, '[[ "$workflow_run_id" == "$GITHUB_RUN_ID" ]] || {', "artifact workflow_run.id must exactly match GITHUB_RUN_ID");

  const downloadStep = stepBlock(publish, "Download exact release tarball artifact");
  includes(downloadStep, "uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093", "publish must use the approved download-artifact action");
  assertMapping(downloadStep, "with", 8, 10, [
    ["artifact-ids", "${{ needs.prepare.outputs.artifact_id }}"],
    ["github-token", "${{ github.token }}"],
    ["merge-multiple", "true"],
    ["path", "${{ runner.temp }}/npm-package-download"],
    ["repository", "${{ github.repository }}"],
    ["run-id", "${{ github.run_id }}"],
  ], "download must bind the exact artifact ID, workflow run, repository, and destination");

  const verifyTarballStep = stepBlock(publish, "Verify downloaded release tarball");
  assertMapping(verifyTarballStep, "env", 8, 10, [
    ["ACTION_DOWNLOAD_PATH", "${{ steps.download.outputs.download-path }}"],
    ["DOWNLOAD_DIR", "${{ runner.temp }}/npm-package-download"],
    ["EXPECTED_PACKAGE_NAME", "pi-footer-display"],
    ["EXPECTED_SHA256", "${{ needs.prepare.outputs.tarball_sha256 }}"],
    ["EXPECTED_TARBALL_FILENAME", "${{ needs.prepare.outputs.tarball_filename }}"],
    ["EXPECTED_VERSION", "${{ needs.prepare.outputs.version }}"],
  ], "download verification must consume the exact path, SHA, filename, name, and version");
  for (const [fragment, message] of [
    ['[[ "$(realpath "$ACTION_DOWNLOAD_PATH")" == "$(realpath "$DOWNLOAD_DIR")" ]]', "download action path must match the isolated destination"],
    ['find "$DOWNLOAD_DIR" -mindepth 1 -maxdepth 1 -print0', "download must enumerate exactly one top-level entry"],
    ['(( ${#entries[@]} == 1 ))', "download must contain exactly one entry"],
    ['[[ -f "$tarball_path" && ! -L "$tarball_path" ]]', "downloaded entry must be one regular non-symlink file"],
    ['[[ "$(basename "$tarball_path")" == "$EXPECTED_TARBALL_FILENAME" ]]', "downloaded tarball filename must match exactly"],
    ['[[ "$actual_sha256" == "$EXPECTED_SHA256" ]]', "downloaded tarball SHA-256 must match exactly"],
    ['normalized = PurePosixPath(name)', "tar paths must be normalized as POSIX paths"],
    ['normalized.is_absolute()', "absolute tar paths must be rejected"],
    ['parts[0] != "package"', "tar members must remain under package"],
    ['any(part in ("", ".", "..") for part in parts)', "unsafe tar path segments must be rejected"],
    ['if name in seen:', "duplicate tar paths must be rejected"],
    ['if member.issym() or member.islnk() or not (member.isfile() or member.isdir()):', "unsafe tar member types must be rejected"],
    ['if name == "package/package.json":', "tarball must contain the exact package manifest path"],
    ['if package_json.get("name") != expected_name:', "tarball package name must match exactly"],
    ['if package_json.get("version") != expected_version:', "tarball package version must match exactly"],
    ['echo "tarball_path=$tarball_path" >> "$GITHUB_OUTPUT"', "only the verified tarball path may reach publish"],
  ]) includes(verifyTarballStep, fragment, message);

  const publishStep = stepBlock(publish, "Publish exact tarball to npm");
  assertMapping(publishStep, "env", 8, 10, [
    ["DIST_TAG", "${{ needs.prepare.outputs.dist_tag }}"],
    ["EXPECTED_SHA256", "${{ needs.prepare.outputs.tarball_sha256 }}"],
    ["TARBALL_PATH", "${{ steps.verify.outputs.tarball_path }}"],
  ], "publish must consume only the verified tarball path, SHA, and dist-tag");
  includes(publishStep, "latest|next", "publish must reject unexpected npm dist-tags");
  includes(publishStep, '[[ -f "$TARBALL_PATH" && ! -L "$TARBALL_PATH" ]]', "publish must recheck that the tarball is a regular file");
  includes(publishStep, '[[ "$(sha256sum "$TARBALL_PATH" | awk \'{print $1}\')" == "$EXPECTED_SHA256" ]]', "publish must recheck the exact tarball SHA-256");
  invariant(
    occurrences(release, /^\s+npm publish "\$TARBALL_PATH" --access public --provenance --tag "\$DIST_TAG" --ignore-scripts$/gm) === 1,
    "publish must publish the exact verified tarball once with provenance, validated dist-tag, and lifecycle scripts disabled",
  );
  invariant(occurrences(release, /\bnpm publish\b/g) === 1, "release workflow must contain exactly one npm publish command");

  invariant(occurrences(release, /\bsecrets(?:\.|\[)/g) === 1, "only the release job may reference the environment-scoped App secret");
  invariant(occurrences(release, /actions\/create-github-app-token@/g) === 1, "only release may create an App token");
  invariant(occurrences(release, /\$\{\{\s*github\.token\s*\}\}/g) === 3, "github.token may be used only for recovery and exact artifact verification/download");
  invariant(!/(secrets\.GITHUB_TOKEN|\bNPM_TOKEN\b)/.test(`${pullRequest}\n${release}`), "GITHUB_TOKEN secret fallback and NPM_TOKEN are forbidden");
  assertImmutableActionPins(`${pullRequest}\n${release}`);

  invariant(packageJson && typeof packageJson === "object", "package.json must be readable");
  invariant(!Object.hasOwn(packageJson, "private"), "package.json must not be private");
  invariant(packageJson.publishConfig?.provenance === true, "package.json must enable publishConfig.provenance");
  invariant(packageJson.scripts?.["verify:workflows"] === "node scripts/verify-workflows.mjs", "verify:workflows script must run the static verifier");
  invariant(packageJson.scripts?.["test:tooling"]?.includes("tests/tooling/workflows.test.mjs"), "workflow tests must be wired into test:tooling");
  invariant(packageJson.scripts?.["test:tooling"]?.includes("tests/tooling/compare-semver.test.mjs"), "SemVer comparator tests must be wired into test:tooling");
}

export function verifyWorkflows(rootDir = process.cwd()) {
  const pullRequest = fs.readFileSync(path.join(rootDir, ".github/workflows/pull-request.yml"), "utf8");
  const release = fs.readFileSync(path.join(rootDir, ".github/workflows/release-please.yml"), "utf8");
  const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
  verifyWorkflowSources({ pullRequest, release, packageJson });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    verifyWorkflows();
    console.log("Verified GitHub workflow invariants.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
