import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const ACTION_PINS = Object.freeze({
  "actions/checkout": "34e114876b0b11c390a56381ad16ebd13914f8d5",
  "actions/setup-node": "49933ea5288caeca8642d1e84afbd3f7d6820020",
  "actions/create-github-app-token": "fee1f7d63c2ff003460e3d139729b119787bc349",
  "googleapis/release-please-action": "5c625bfb5d1ff62eadeeb3772007f7f66fdcf071",
});

const RELEASE_GATE = "if: ${{ vars.RELEASE_AUTOMATION_ENABLED == 'true' && vars.NPM_TRUSTED_PUBLISHING_READY == 'true' && (github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && inputs.tag == '' && github.ref == 'refs/heads/main')) }}";
const TAG_SEMVER_PATTERN = "SEMVER_PATTERN='^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(\\+[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$'";
const PUBLISH_GATE = "if: ${{ always() && vars.RELEASE_AUTOMATION_ENABLED == 'true' && vars.NPM_TRUSTED_PUBLISHING_READY == 'true' && ((needs.release.result == 'success' && needs.release.outputs.release_created == 'true') || (github.event_name == 'workflow_dispatch' && inputs.tag != '')) }}";

function invariant(condition, message) {
  if (!condition) throw new Error(`Workflow invariant failed: ${message}`);
}

function includes(source, fragment, message) {
  invariant(source.includes(fragment), message);
}

function occurrences(source, pattern) {
  return [...source.matchAll(pattern)].length;
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

export function verifyWorkflowSources({ pullRequest, release, packageJson }) {
  invariant(typeof pullRequest === "string", "pull-request.yml must be readable");
  invariant(typeof release === "string", "release-please.yml must be readable");

  const eventBlock = pullRequest.match(/pull_request:\n\s+types:\n((?:\s+- [^\n]+\n?)+)/)?.[1] ?? "";
  const events = [...eventBlock.matchAll(/- ([^\s]+)/g)].map((match) => match[1]);
  invariant(
    JSON.stringify(events) === JSON.stringify(["opened", "edited", "synchronize", "reopened", "ready_for_review"]),
    "pull requests must run on exactly the approved activity types",
  );
  includes(pullRequest, "permissions:\n  contents: read", "pull-request workflow must have contents:read only");
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
  includes(release, "permissions: {}", "release workflow must deny permissions by default");
  includes(release, RELEASE_GATE, "release job must fail closed behind both gates in normal mode");
  includes(release, PUBLISH_GATE, "publish job must use always(), both gates, successful release, or explicit recovery");
  invariant(occurrences(release, /^\s*permissions:/gm) === 3, "only workflow, release, and publish permissions blocks are allowed");
  invariant(occurrences(release, /^\s+contents: read$/gm) === 2, "release and publish jobs must each grant contents:read");
  invariant(occurrences(release, /^\s+id-token: write$/gm) === 1, "only publish may grant id-token:write");
  invariant(!/^\s+(contents|actions|checks|deployments|issues|packages|pull-requests|statuses): write$/m.test(release), "workflow token must not grant other write permissions");

  includes(release, "app-id: ${{ vars.NERV_OPS_APP_ID }}", "nerv-ops app id is required");
  includes(release, "private-key: ${{ secrets.NERV_OPS_PRIVATE_KEY }}", "nerv-ops private key is required");
  const releaseTokenStep = release.match(/      - name: Create nerv-ops installation token\n[\s\S]*?(?=\n      - name:)/)?.[0] ?? "";
  const recoveryTokenStep = release.match(/      - name: Create nerv-ops installation token for recovery verification\n[\s\S]*?(?=\n      - name:)/)?.[0] ?? "";
  const tokenPermissions = (step) => [...step.matchAll(/^\s+permission-([^:]+): ([^\s]+)$/gm)].map((match) => `${match[1]}:${match[2]}`);
  invariant(
    JSON.stringify(tokenPermissions(releaseTokenStep)) === JSON.stringify(["contents:write", "issues:write", "pull-requests:write"]),
    "release App token must grant exactly contents:write, issues:write, and pull-requests:write",
  );
  invariant(
    JSON.stringify(tokenPermissions(recoveryTokenStep)) === JSON.stringify(["contents:read"]),
    "recovery App token must grant exactly contents:read",
  );
  includes(release, "token: ${{ steps.app-token.outputs.token }}", "Release Please must use only the app installation token");
  invariant(!/(secrets\.GITHUB_TOKEN|github\.token|\bNPM_TOKEN\b)/.test(`${pullRequest}\n${release}`), "GITHUB_TOKEN fallback and NPM_TOKEN are forbidden");
  includes(release, "config-file: release-please-config.json", "Release Please config is required");
  includes(release, "manifest-file: .release-please-manifest.json", "Release Please manifest is required");
  const releaseOutputs = release.match(/    outputs:\n((?:      [^\n]+\n?)+)/)?.[1] ?? "";
  invariant(
    releaseOutputs === "      release_created: ${{ steps.release.outputs.release_created }}\n      tag_name: ${{ steps.release.outputs.tag_name }}\n",
    "release job must expose only documented release_created and tag_name outputs",
  );
  invariant(!/(?:steps\.release|needs\.release)\.outputs\.version/.test(release), "release version must never depend on the undocumented Release Please version output");
  includes(release, 'gh pr merge "$number" --repo "$GITHUB_REPOSITORY" --auto --squash', "release PRs must enable squash auto-merge");

  includes(release, "RELEASE_TAG: ${{ needs.release.outputs.tag_name }}", "normal publish must use the documented Release Please tag_name output");
  includes(release, 'if [[ -z "$TARGET_TAG" ]]; then\n              echo "Release Please did not emit a tag" >&2\n              exit 1\n            fi', "normal publish must fail when Release Please emits no tag");
  includes(release, TAG_SEMVER_PATTERN, "all release tags must be exact v-prefixed semantic versions");
  includes(release, 'if [[ ! "$TARGET_TAG" =~ $SEMVER_PATTERN ]]; then\n            echo "Release tag must be an exact v-prefixed semantic version: $TARGET_TAG" >&2\n            exit 1\n          fi', "malformed normal and recovery tags must fail before version derivation");
  const tagValidation = release.indexOf('if [[ ! "$TARGET_TAG" =~ $SEMVER_PATTERN ]]');
  const versionDerivation = release.indexOf('VERSION="${TARGET_TAG#v}"');
  invariant(tagValidation !== -1 && versionDerivation > tagValidation, "version must be derived only after strict validation by stripping v from the release tag");
  includes(release, "ref: ${{ steps.target.outputs.tag }}", "publish must check out the exact emitted or recovery tag");
  includes(release, "fetch-depth: 0", "release checkout must fetch main history for ancestry verification");
  includes(release, "persist-credentials: false", "release checkout must not persist credentials");
  includes(release, "node-version: 22.19.0", "publish must use Node 22.19.0");
  includes(release, "registry-url: https://registry.npmjs.org", "publish must target the npm registry");
  includes(release, "npm install --global npm@11.5.1", "trusted publishing requires npm 11.5.1");
  for (const command of ["npm ci", "npm test", "npm run verify:release-version -- --expected", "npm run verify:package"]) {
    includes(release, command, `publish must run ${command}`);
  }
  includes(release, 'gh release view "$TARGET_TAG" --repo "$GITHUB_REPOSITORY" --json isDraft,tagName', "recovery must verify an existing GitHub release");
  includes(release, '[[ "$(jq -r \'.isDraft\' <<< "$release")" == "false" ]]', "recovery must reject draft releases");
  includes(release, 'EXPECTED_TAG="v${VERSION}"', "publish must derive the exact v-prefixed version tag");
  includes(release, 'git rev-parse "refs/tags/$TARGET_TAG^{commit}"', "publish must verify the checked-out tag commit");
  includes(release, "git merge-base --is-ancestor HEAD refs/remotes/origin/main", "publish must reject release tags outside main history");
  includes(release, "if [[ \"$VERSION\" == *-* ]]", "prerelease versions must be detected from exact SemVer metadata");
  includes(release, "DIST_TAG=next", "prerelease versions must use the safe next dist-tag");
  includes(release, "DIST_TAG=latest", "stable versions must explicitly use the latest dist-tag");
  includes(release, 'npm view "$PACKAGE_NAME@$VERSION" version --json', "publish must query npm before publishing");
  includes(release, 'if [[ "$RECOVERY" == "true" ]]; then', "an existing package must make recovery a no-op");
  includes(release, "refusing duplicate normal publish", "normal mode must fail on an existing package version");
  invariant(occurrences(release, /payload\?\.error\?\.code !== "E404"/g) === 2, "only structured npm E404 responses may be treated as absent");
  includes(release, 'npm view "$PACKAGE_NAME" "dist-tags.$DIST_TAG" --json', "latest and next must each query their current npm dist-tag");
  includes(release, 'node scripts/compare-semver.mjs "$VERSION" "$CURRENT_VERSION"', "dist-tag versions must use the deterministic SemVer comparator");
  includes(release, '-1)\n                echo "$VERSION is lower than current $DIST_TAG version $CURRENT_VERSION; refusing dist-tag regression." >&2\n                exit 1', "lower versions must not regress latest or next");
  includes(release, '0)\n                echo "$VERSION equals current $DIST_TAG version $CURRENT_VERSION after the exact-version absence check; refusing inconsistent npm state." >&2\n                exit 1', "equal dist-tag versions must fail closed");
  includes(release, "latest|next", "publish must reject unexpected npm dist-tags");
  invariant(occurrences(release, /^\s*npm publish --access public --provenance --tag "\$DIST_TAG"$/gm) === 1, "publish command must include provenance and the validated dist-tag exactly once");

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
