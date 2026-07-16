# Releasing

This document is the operator runbook for bootstrapping, enabling, operating, disabling, and recovering the release pipeline. Do not put npm credentials, GitHub App private keys, or other credentials in this repository.

## Current fail-closed status

As of this release-automation rollout, the target repository has no release variables, no `NERV_OPS_PRIVATE_KEY` Actions secret, no configured npm trusted publisher, and no published `pi-footer-display` npm package. The npm registry returns `E404` for the package.

Both jobs in `.github/workflows/release-please.yml` require these repository variables to equal the exact lowercase string `true`:

- `NPM_TRUSTED_PUBLISHING_READY`
- `RELEASE_AUTOMATION_ENABLED`

While either gate is absent or has any other value, both `Create release PR or GitHub release` and `Verify and publish to npm` skip. The pull-request workflow is independent of those gates: PR title validation and the `Test` job work while release automation is disabled.

**Do not set either gate to `true` before its prerequisite is complete. Set `RELEASE_AUTOMATION_ENABLED=true` only in the final activation step.**

## Release baseline

Release Please uses bootstrap commit:

```text
147470b11439248d54b011a011663254709c36c3
```

The current release baseline is synchronized at `0.1.0` in all four locations checked by `npm run verify:release-version`:

- `package.json` → `version`
- `package-lock.json` → top-level `version`
- `package-lock.json` → `packages[""].version`
- `.release-please-manifest.json` → `"."`

The bootstrap commit itself also has `0.1.0` in `package.json` and both lockfile locations. The one-time bootstrap publish must use an audited tarball built from that exact commit. npm versions are immutable; never repack a changed tree and try to reuse `0.1.0`.

## One-time activation order

Perform these steps in exactly this order. Steps involving GitHub or npm settings require an authorized repository/package administrator.

### 1. Merge the release-automation PR while gates are absent

Confirm that the release variables and App secret are still absent. Merge this PR with **squash** and a non-releasing `chore(ci)` title, for example:

```text
chore(ci): add gated release automation
```

Do not use a `feat`, `fix`, or other release-triggering squash title for this bootstrap merge. Do not enable a release gate before the merge.

### 2. Configure repository merge policy

In the GitHub repository settings:

1. Enable repository auto-merge.
2. Allow squash merging and use squash for this repository's release PRs.
3. Configure the applicable `main` rules to require a pull request and the exact PR checks `Validate PR title` and `Test` before merge.
4. Verify that a passing PR can become mergeable under those rules.

The workflow calls `gh pr merge --auto --squash`; repository auto-merge, squash support, and compatible branch rules must therefore exist before automation is enabled.

### 3. Install and configure the `nerv-ops` GitHub App

Install `nerv-ops` on `10ego/pi-footer-display`, limiting repository access to this repository if possible. Its repository permissions must permit the operations used by the workflow:

- **Contents: read and write** — create/update the release branch, commit release metadata, and create tags and GitHub releases.
- **Pull requests: read and write** — create/update the Release Please PR and enable squash auto-merge.
- **Metadata: read-only** — GitHub's required baseline App permission.

Do not grant unrelated permissions. Confirm that the installation is active for this repository and that App-authored pull requests run the required PR checks.

### 4. Add the App variable and secret

Add these repository-level Actions values:

- Variable `NERV_OPS_APP_ID`: the numeric App ID.
- Secret `NERV_OPS_PRIVATE_KEY`: the App private key in PEM form.

The workflow exchanges them for short-lived installation tokens. Keep the private key only in the authorized secret store: do not save it in a tracked file, shell transcript, package tarball, issue, or pull request.

Leave `NPM_TRUSTED_PUBLISHING_READY` and `RELEASE_AUTOMATION_ENABLED` absent or not `true`.

### 5. Audit and manually publish the bootstrap `0.1.0` tarball once

Trusted publishing is configured on an existing npm package, so an authorized npm owner must establish `pi-footer-display@0.1.0` first. Use a clean detached worktree at the exact bootstrap SHA, audit it, build one tarball, and publish that same immutable file.

The following local preparation commands do not authenticate or publish:

```bash
BOOTSTRAP=147470b11439248d54b011a011663254709c36c3
git cat-file -e "$BOOTSTRAP^{commit}"
git worktree add --detach ../pi-footer-display-bootstrap-0.1.0 "$BOOTSTRAP"
cd ../pi-footer-display-bootstrap-0.1.0
test "$(git rev-parse HEAD)" = "$BOOTSTRAP"
npm ci
npm test
node -e 'const p=require("./package.json"); const l=require("./package-lock.json"); if (p.version!=="0.1.0" || l.version!=="0.1.0" || l.packages[""].version!=="0.1.0") process.exit(1)'
npm pack --dry-run
npm pack --json | tee npm-pack.json
shasum -a 512 pi-footer-display-0.1.0.tgz
tar -tzf pi-footer-display-0.1.0.tgz
```

Review the source, dry-run output, tar member list, generated metadata, and checksum before proceeding. Authenticate with npm only through the authorized operator's normal out-of-repository credential mechanism. No npm token, `.npmrc`, or other credential belongs in this repository.

After confirming `npm whoami` identifies the authorized owner and the package is still absent, the authorized operator performs the one-time publish of the already-audited file:

```bash
npm view pi-footer-display@0.1.0 version --json  # must return E404 before first publish
npm publish ./pi-footer-display-0.1.0.tgz --access public
npm view pi-footer-display@0.1.0 version --json  # must return "0.1.0"
```

Do not run the publish command if `0.1.0` already exists. Preserve the audit record outside the repository, then remove the temporary worktree and local tarball when retention requirements allow.

### 6. Configure npm trusted publishing

For the npm package `pi-footer-display`, add a GitHub Actions trusted publisher with these exact coordinates:

- GitHub organization or user: `10ego`
- Repository: `pi-footer-display`
- Workflow: `.github/workflows/release-please.yml`

Do not configure an environment unless the workflow is changed to use that exact environment. The workflow requests `id-token: write`, installs npm `11.5.1`, and publishes with `npm publish --access public --provenance`; it does not read `NPM_TOKEN`.

### 7. Mark trusted publishing ready

Only after the publisher coordinates have been saved and verified, set the repository variable:

```text
NPM_TRUSTED_PUBLISHING_READY=true
```

Keep `RELEASE_AUTOMATION_ENABLED` absent or not `true` while checking all earlier prerequisites.

### 8. Enable release automation last

After repository rules, App installation, App values, bootstrap publication, and npm trusted publishing are all verified, set this repository variable last:

```text
RELEASE_AUTOMATION_ENABLED=true
```

Both values are case-sensitive; only the exact string `true` opens the gates.

### 9. Start or await the normal workflow

Either wait for the next push to `main`, or dispatch the workflow with an empty `tag` input:

```bash
gh workflow run .github/workflows/release-please.yml \
  --repo 10ego/pi-footer-display \
  --ref main \
  -f tag=''
```

An empty tag runs normal Release Please behavior. A non-empty tag selects recovery mode instead; do not use one merely to prompt a normal release scan.

## Normal release lifecycle

Once enabled, the normal lifecycle is:

1. Conventional Commit squash titles land on `main`.
2. A push to `main` runs `.github/workflows/release-please.yml`.
3. Release Please uses the `nerv-ops` installation token, `release-please-config.json`, and `.release-please-manifest.json` to create or update its release PR.
4. The workflow enables squash auto-merge on each created release PR. Repository rules hold the PR until `Validate PR title` and `Test` pass.
5. Squash-merging the release PR pushes synchronized version/changelog metadata to `main` and triggers the workflow again.
6. Release Please creates the exact `v<version>` tag and a GitHub release.
7. The publish job checks out that exact tag without persisted credentials, installs dependencies, runs tests, verifies synchronized release metadata and package contents, and verifies that the tag resolves to the checked-out commit.
8. If npm reports the version absent with `E404`, npm trusted publishing supplies short-lived OIDC credentials and the workflow publishes publicly with provenance.

A normal run with no release created does not publish. A normal run finding its version already on npm fails rather than silently accepting a duplicate; investigate before retrying.

## Disable or pause automation

Set `RELEASE_AUTOMATION_ENABLED` to `false` (or remove it) to stop both release jobs. Because both jobs require both gates, setting `NPM_TRUSTED_PUBLISHING_READY` to `false` also stops them when trusted publishing is unavailable.

Use the automation gate for a general pause and the trusted-publishing gate to record npm readiness accurately. A gate change does not cancel a job that has already started; cancel or inspect an in-progress run separately if necessary. Restore prerequisites first, then set `NPM_TRUSTED_PUBLISHING_READY=true` and `RELEASE_AUTOMATION_ENABLED=true` last.

PR CI remains active while release gates are disabled.

## Recovery publish

Recovery is only for an existing, non-draft GitHub release whose npm publish did not complete. Both release gates must still be exactly `true`.

Dispatch with an explicit, exact, `v`-prefixed semantic-version tag, for example:

```bash
gh release view v1.2.3 \
  --repo 10ego/pi-footer-display \
  --json tagName,isDraft,targetCommitish

gh workflow run .github/workflows/release-please.yml \
  --repo 10ego/pi-footer-display \
  --ref main \
  -f tag='v1.2.3'
```

The input must be the complete tag, not a branch, SHA, version range, or unprefixed version. In recovery mode the release job skips. The publish job uses the App token to verify that the named GitHub release exists and is not a draft, checks out the exact tag, derives the package version from it, and runs all normal verification before considering publication.

npm duplicate handling is intentionally mode-specific:

- **Recovery:** if the exact package version is already on npm, the run succeeds as a no-op (`should_publish=false`).
- **Normal release:** if the exact package version is already on npm, the run fails to expose an unexpected duplicate.
- **Either mode:** only npm `E404` means absent. Authentication, registry, network, and other lookup errors fail closed and do not publish.

## Troubleshooting

### Both release jobs are skipped

Check repository variables. Both must equal exact lowercase `true`. For normal mode, the event must also be a push to `main` or a dispatch with an empty tag. For recovery, dispatch with a non-empty tag.

```bash
gh variable list --repo 10ego/pi-footer-display
gh run list --repo 10ego/pi-footer-display --workflow release-please.yml --limit 10
```

Do not open the gates simply to diagnose missing prerequisites.

### App token creation fails

Verify that `NERV_OPS_APP_ID` is the numeric ID, `NERV_OPS_PRIVATE_KEY` contains the complete matching PEM key, and the `nerv-ops` App is installed on this repository. Then verify Contents and Pull requests read/write permissions. Rotate a suspected private key in GitHub and the secret store; never commit it.

### The release PR is not created or updated

Inspect the Release Please step and confirm the App can write contents and pull requests. Verify the bootstrap SHA and manifest:

```bash
git cat-file -e 147470b11439248d54b011a011663254709c36c3^{commit}
npm run verify:release-version
```

A history rewrite that removes the bootstrap commit or inconsistent version metadata must be resolved before retrying.

### The release PR does not auto-merge

Confirm repository auto-merge is enabled, squash merges are allowed, and the `main` rules require the exact checks `Validate PR title` and `Test`. Inspect the PR checks and auto-merge method:

```bash
gh pr checks PR_NUMBER --repo 10ego/pi-footer-display
gh pr view PR_NUMBER --repo 10ego/pi-footer-display \
  --json autoMergeRequest,mergeStateStatus,statusCheckRollup
```

Do not bypass a failing required check to force a release.

### The publish job cannot obtain npm credentials

Confirm the npm trusted publisher exactly names owner `10ego`, repository `pi-footer-display`, and workflow `.github/workflows/release-please.yml`, with no unmatched environment restriction. The workflow deliberately has no npm token fallback. Keep the gate closed until OIDC configuration is corrected.

### npm availability check fails

Check the exact version manually:

```bash
npm view pi-footer-display@VERSION version --json
```

`E404` means the version is absent. Any other error is not proof of absence and the workflow correctly refuses to publish. If a normal run reports a duplicate, verify the npm artifact and GitHub release before choosing recovery; do not change or reuse the tag.

### Recovery rejects the tag or release

Use an exact tag such as `v1.2.3` and verify that a non-draft GitHub release already exists for exactly that tag. Recovery does not create releases, accept draft releases, or accept arbitrary commits. The checked-out tag must resolve to the commit being verified.

### Tests or package inspection fail at the tag

Reproduce from a clean checkout of the exact tag:

```bash
npm ci
npm test
npm run verify:release-version -- --expected VERSION
npm run verify:package
```

Do not publish from a different checkout. Correct the release through a new immutable version rather than moving an existing tag or replacing an npm artifact.
