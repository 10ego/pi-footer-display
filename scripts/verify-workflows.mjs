import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const ACTION_PINS = Object.freeze({
  "actions/checkout": "34e114876b0b11c390a56381ad16ebd13914f8d5",
  "actions/setup-node": "49933ea5288caeca8642d1e84afbd3f7d6820020",
  "actions/create-github-app-token": "fee1f7d63c2ff003460e3d139729b119787bc349",
  "googleapis/release-please-action": "8b8fd2cc23b2e18957157a9d923d75aa0c6f6ad5",
});

const RELEASE_GATE = "if: ${{ vars.RELEASE_AUTOMATION_ENABLED == 'true' && vars.NPM_TRUSTED_PUBLISHING_READY == 'true' && (github.event_name == 'push' || inputs.tag == '') }}";
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
  includes(release, "token: ${{ steps.app-token.outputs.token }}", "Release Please must use only the app installation token");
  invariant(!/(secrets\.GITHUB_TOKEN|github\.token|\bNPM_TOKEN\b)/.test(`${pullRequest}\n${release}`), "GITHUB_TOKEN fallback and NPM_TOKEN are forbidden");
  includes(release, "config-file: release-please-config.json", "Release Please config is required");
  includes(release, "manifest-file: .release-please-manifest.json", "Release Please manifest is required");
  for (const output of ["release_created", "version", "tag_name"]) {
    includes(release, "      " + output + ": ${{ steps.release.outputs." + output + " }}", `release job must expose ${output}`);
  }
  includes(release, 'gh pr merge "$number" --repo "$GITHUB_REPOSITORY" --auto --squash', "release PRs must enable squash auto-merge");

  includes(release, "ref: ${{ steps.target.outputs.tag }}", "publish must check out the exact emitted or recovery tag");
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
  includes(release, 'npm view "$PACKAGE_NAME@$VERSION" version --json', "publish must query npm before publishing");
  includes(release, 'if [[ "$RECOVERY" == "true" ]]; then', "an existing package must make recovery a no-op");
  includes(release, "refusing duplicate normal publish", "normal mode must fail on an existing package version");
  includes(release, "if ! grep -q 'E404'", "only an npm not-found response may be treated as absent");
  invariant(occurrences(release, /^\s*run: npm publish --access public --provenance$/gm) === 1, "publish command must be exactly npm publish --access public --provenance");

  assertImmutableActionPins(`${pullRequest}\n${release}`);

  invariant(packageJson && typeof packageJson === "object", "package.json must be readable");
  invariant(!Object.hasOwn(packageJson, "private"), "package.json must not be private");
  invariant(packageJson.publishConfig?.provenance === true, "package.json must enable publishConfig.provenance");
  invariant(packageJson.scripts?.["verify:workflows"] === "node scripts/verify-workflows.mjs", "verify:workflows script must run the static verifier");
  invariant(packageJson.scripts?.["test:tooling"]?.includes("tests/tooling/workflows.test.mjs"), "workflow tests must be wired into test:tooling");
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
