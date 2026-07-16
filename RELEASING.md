# Releasing

This is the operator runbook for enabling, operating, pausing, and recovering the release pipeline. Treat GitHub tags, GitHub releases, GitHub Actions artifacts, and npm versions as immutable. Never put an npm credential or GitHub App private key in the repository, a pull request, an issue, a shell transcript, or a package tarball.

## Published bootstrap record

The bootstrap is complete. `pi-footer-display@0.1.0` is already published from this exact source commit:

```text
147470b11439248d54b011a011663254709c36c3
```

The audited tarball produced from that commit and the tarball served by npm were compared byte-for-byte and verified byte-identical. The registry tarball has these recorded values:

- SHA-512 (hex): `5e0bd3d26883578ef02d6ca47be4842bb355f9e049b073b8041c7ee1d22374fdf2deb96d806e2470d2ceb37ab84ba8848b686e86671db7239bcf4f71f35cf6e8`
- npm-reported `dist.shasum`: `dc4db8031d3562c61a6e129fa21fd37bde7d544c`
- npm-reported `dist.integrity`: `sha512-XgvT0miDV47wLWyke+SEK7NV+eBJsHO4BBx+4dIjdP3y3rltgG4kcNLOs3q4S6iEi2huhmcdtyObz09x81z26A==`

The npm values can be re-read without authenticating:

```bash
npm view pi-footer-display@0.1.0 version dist.shasum dist.integrity --json
```

The integrity value decodes to the recorded SHA-512. npm versions are immutable: **do not rebuild, republish, deprecate as a substitute for replacement, or otherwise repeat a bootstrap publish for `0.1.0`**. A checksum mismatch is a security incident to investigate, not a reason to publish another `0.1.0` tarball.

The Release Please baseline remains synchronized at `0.1.0` in `package.json`, both lockfile version locations, and `.release-please-manifest.json`. `release-please-config.json` intentionally retains the exact bootstrap commit above as `bootstrap-sha`.

## Fail-closed gates and policy

`.github/workflows/release-please.yml` contains exactly three jobs: `release`, `prepare`, and `publish`. The workflow denies permissions by default with `permissions: {}` and grants each job only its documented permissions.

All three jobs require both repository Actions variables to equal the exact lowercase string `true`:

- `NPM_TRUSTED_PUBLISHING_READY`
- `RELEASE_AUTOMATION_ENABLED`

An absent variable, an empty value, or any value other than `true` closes its gate. The jobs also require the workflow run ref to be `refs/heads/main`. During initial activation, **both gate variables must remain absent until every prerequisite and every item in the administrator evidence checklist is complete**. Set npm readiness first and release automation last.

The pull-request workflow is independent of these gates. `Validate PR title` and `Test` continue to run while releases are disabled.

Release policy:

- Use Conventional Commit pull-request and squash-merge titles. Release Please derives versions and changelogs from commits on `main`.
- Use squash merging for Release Please PRs. Do not bypass required checks to force a release.
- Never move or reuse an existing release tag, replace an npm artifact, or repack a prepared artifact.
- Stable versions publish explicitly to `latest`; prereleases publish explicitly to `next`. The workflow rejects a dist-tag regression.
- A normal release finding its exact npm version already published fails closed. Recovery handles an already-published exact version as a successful no-op.

## Three-job security architecture

| Job | Environment | Job permissions | Credential boundary |
| --- | --- | --- | --- |
| `release` | protected `release-automation` | `contents: read` | The only job allowed to read the environment-scoped `NERV_OPS_PRIVATE_KEY` and create a GitHub App installation token. |
| `prepare` | none | `contents: read` | No environment, secrets, App key/token, or OIDC. Recovery uses the read-only `github.token`. |
| `publish` | protected `npm-publish` | `actions: read`, `id-token: write` only | No checkout, repository scripts, dependency install, repository contents permission, or secrets. npm authentication is OIDC trusted publishing only. |

### 1. `release`: create or update the release

The normal `release` job runs only for a push to `main` or an empty-tag manual dispatch from `main`, with both gates open. It enters the protected `release-automation` environment.

- `NERV_OPS_APP_ID` is a non-secret Actions variable.
- `NERV_OPS_PRIVATE_KEY` is an environment secret belonging **only** to `release-automation`. There must be no repository-level App private-key secret.
- The job exchanges those values for a short-lived repository installation token narrowed to Contents write, Issues write, and Pull requests write.
- Release Please uses that App token, `release-please-config.json`, and `.release-please-manifest.json` to create/update its release PR or to create the immutable tag and GitHub release.
- Created release PRs are configured for squash auto-merge. Repository rules continue to enforce the PR checks.
- The job exports only Release Please's documented `release_created` and `tag_name` outputs. No undocumented version output is trusted.

The job-level `contents: read` permission applies to `github.token`; the separate App installation token carries the narrowly requested write permissions.

### 2. `prepare`: verify source and create one artifact

`prepare` depends on `release`, but its `always()` condition permits recovery after the `release` job is intentionally skipped. It still requires both gates and `--ref main`.

The job has no environment, no secret reference, and no `id-token: write`. In recovery, it uses only the read-only `github.token` to confirm that the exact named GitHub release exists and is not a draft; it never reads the App private key or creates an App token.

For a version that needs publication, `prepare`:

1. Strictly validates an exact `v`-prefixed SemVer tag before deriving the version by removing `v`. Stable versions select `latest`; prereleases select `next`.
2. Checks out that exact tag with full history and `persist-credentials: false`.
3. Uses Node `24.7.0`, verifies bundled npm is at least `11.5.1`, runs `npm ci` and `npm test`, verifies synchronized release metadata, and runs the package-content audit.
4. Verifies that the tag resolves to the checked-out commit and that the commit is an ancestor of `origin/main`.
5. Queries the exact npm version and selected dist-tag. Only a structured npm `E404` is accepted as absence; malformed, authentication, registry, and network responses fail closed. Normal duplicates fail; recovery duplicates become no-ops. A candidate lower than or unexpectedly equal to the selected dist-tag fails.
6. Runs `npm pack --ignore-scripts --json --pack-destination "$output_dir"` **exactly once**, only after the checks pass. There is no dry-run pack or repack. The npm JSON, package name/version, audited file allowlist and metadata, filename, output directory, and regular-file status must all identify exactly one tarball.
7. Computes the tarball SHA-256 and uploads that exact file with immutable `upload-artifact` v4 semantics under a run/attempt/version-bound name, one-day retention, and no additional compression.
8. Exports and validates the numeric artifact ID, upload-artifact server digest, artifact name, exact tarball filename, and tarball SHA-256 for `publish`.

Repository code and dependencies are therefore available only in the unprivileged preparation boundary. No npm publication credential exists there.

### 3. `publish`: approve, re-verify, and publish the exact tarball

`publish` runs only after a successful `prepare` says publication is needed, both gates remain open, and the run ref remains `main`. It enters the protected `npm-publish` environment, where independent reviewer approval is required.

Its only permissions are `actions: read` and `id-token: write`. It has no Contents permission, checkout, repository dependency cache, dependency installation, repository npm scripts, App key, `NPM_TOKEN`, or other secret. The OIDC token becomes useful only to the exact npm trusted-publisher identity.

Before requesting publication, the job:

1. Validates every prepared identity field: exact SemVer and tag, `latest`/`next` relationship, package filename, artifact name, numeric artifact ID, tarball SHA-256, and upload artifact digest.
2. Requests GitHub's server metadata for that exact artifact ID and requires the same ID and name, `expired == false`, the exact `sha256:<upload digest>`, and a present numeric `workflow_run.id` equal to the current `GITHUB_RUN_ID`.
3. Downloads by exact artifact ID while binding the current repository and current run ID.
4. Requires exactly one top-level regular, non-symlink file with the exact tarball filename and prepared SHA-256.
5. Opens the tarball without running repository code and rejects empty archives, absolute or non-normalized paths, traversal components, duplicate paths, links, unsupported member types, members outside `package/`, a missing or duplicate `package/package.json`, and a package name/version mismatch.
6. Rechecks the regular file and SHA-256 immediately before publishing.

The only publication command publishes the already-verified file, with lifecycle scripts disabled:

```bash
npm publish "$TARBALL_PATH" --access public --provenance --tag "$DIST_TAG" --ignore-scripts
```

No source checkout or newly generated tarball can enter the protected publication boundary.

## One-time activation

Perform these steps in order. GitHub and npm settings require authorized administrators.

> **Confirm feature availability first.** GitHub environment deployment restrictions, required reviewers, prevent-self-review, and administrator-bypass controls vary by repository visibility, organization policy, and GitHub plan. Confirm that the target repository can enforce the controls below before activation. If independent approval or required protection cannot be enforced, stop and keep both gates absent; do not silently weaken the design.

### 1. Land the workflow while both gates are absent

If the release-automation rollout is not yet on `main`, merge it with squash and a non-releasing title such as:

```text
chore(ci): add gated release automation
```

Do not use `feat`, `fix`, or another release-triggering title for the rollout. Confirm both gate variables are still absent before and after merge.

### 2. Configure repository merge policy

In repository settings:

1. Enable repository auto-merge.
2. Allow squash merging and use it for Release Please PRs.
3. Protect `main` with pull-request review/rules and the exact required checks `Validate PR title` and `Test`.
4. Confirm App-authored pull requests run those checks and can become mergeable only after the rules pass.

The workflow invokes `gh pr merge --auto --squash`; auto-merge, squash support, and compatible `main` rules must already work.

### 3. Install least-privilege `nerv-ops`

Install the `nerv-ops` GitHub App on `10ego/pi-footer-display`, limited to this repository where possible. Its installation permissions must support the Release Please and auto-merge operations:

- Contents: read and write
- Issues: read and write
- Pull requests: read and write
- Metadata: read-only, as GitHub's required baseline

Do not grant unrelated permissions. Confirm the installation is active for this repository.

### 4. Create and protect both environments

Create both environments **before either release gate exists**. In each environment, configure “selected deployment branches and tags” (or the equivalent control) to allow only branch `main`; do not allow tags, arbitrary branches, or an unrestricted policy.

For `release-automation`:

- Restrict deployments to `main` only.
- Add `NERV_OPS_PRIVATE_KEY` as an environment-scoped Actions secret containing the complete matching PEM key.
- Add the numeric `NERV_OPS_APP_ID` as a repository Actions variable. It is an identifier, not a secret.
- Confirm `NERV_OPS_PRIVATE_KEY` is absent from repository-level Actions secrets and from every other environment.

For `npm-publish`:

- Restrict deployments to `main` only.
- Configure required independent reviewer approval. Include the primary independent reviewer(s) or team and at least one independent backup so publication does not depend on one unavailable person.
- Enable prevent-self-review, so the actor who initiated the run cannot approve their own deployment.
- Disable administrator bypass wherever GitHub exposes that control. If the plan cannot enforce this, leave the gates absent and resolve the policy gap.
- Add **no environment secrets**. Trusted publishing uses OIDC, not an npm token.

The environment names are security identities and must match the workflow exactly.

### 5. Configure the npm trusted publisher

The package already exists; no bootstrap publication is needed. In npm settings for `pi-footer-display`, configure one GitHub Actions trusted publisher with these exact coordinates:

- GitHub organization or user: `10ego`
- Repository: `pi-footer-display`
- Workflow filename: `release-please.yml`
- Environment: `npm-publish`

Use the workflow filename, not `.github/workflows/release-please.yml`. The environment is mandatory here and must exactly match the protected job environment. Do not add `NPM_TOKEN` as a fallback.

### 6. Complete the administrator evidence checklist

Capture non-secret evidence in the approved administrative record, outside the source repository. Do not capture the PEM value.

- [ ] `npm view pi-footer-display@0.1.0 version dist.shasum dist.integrity --json` matches the published bootstrap record above.
- [ ] `main` requires `Validate PR title` and `Test`; squash merge and auto-merge are enabled and tested.
- [ ] The `nerv-ops` installation is scoped to the intended repository and has only the required permissions.
- [ ] `NERV_OPS_APP_ID` is the correct numeric Actions variable.
- [ ] `release-automation` exists, permits only `main`, and is the only scope containing `NERV_OPS_PRIVATE_KEY`.
- [ ] Repository-level Actions secrets do not contain `NERV_OPS_PRIVATE_KEY`; no npm token is configured for the workflow.
- [ ] `npm-publish` exists, permits only `main`, has independent primary and backup reviewer coverage, prevents self-review, disallows administrator bypass where supported, and contains no secrets.
- [ ] The repository's GitHub plan and visibility were confirmed to enforce all required environment controls.
- [ ] npm's trusted publisher exactly names owner `10ego`, repository `pi-footer-display`, workflow filename `release-please.yml`, and environment `npm-publish`.
- [ ] Both gate variables are still absent.
- [ ] The checked-in workflow and package tests pass on `main`.

Useful name-only checks include:

```bash
gh variable list --repo 10ego/pi-footer-display
gh secret list --repo 10ego/pi-footer-display
gh secret list --repo 10ego/pi-footer-display --env release-automation
gh secret list --repo 10ego/pi-footer-display --env npm-publish
gh api repos/10ego/pi-footer-display/environments/release-automation
gh api repos/10ego/pi-footer-display/environments/npm-publish
```

Review environment settings in the GitHub UI as well; API fields and available protection controls vary by plan.

### 7. Open the gates in the required order

Only after every prerequisite and checklist item is complete, set npm readiness first:

```bash
gh variable set NPM_TRUSTED_PUBLISHING_READY \
  --repo 10ego/pi-footer-display \
  --body true
```

Reconfirm the npm publisher and `npm-publish` protections, then enable automation last:

```bash
gh variable set RELEASE_AUTOMATION_ENABLED \
  --repo 10ego/pi-footer-display \
  --body true
```

Only exact lowercase `true` opens a gate.

### 8. Start or await normal operation

Wait for the next push to `main`, or dispatch an empty-tag normal run from `main`:

```bash
gh workflow run .github/workflows/release-please.yml \
  --repo 10ego/pi-footer-display \
  --ref main \
  -f tag=''
```

Do not use a recovery tag merely to prompt a normal Release Please scan.

## Normal release lifecycle

1. A Conventional Commit squash title lands on `main`.
2. `release` enters `release-automation`, creates a short-lived App token, and creates or updates the Release Please PR.
3. The workflow requests squash auto-merge; repository rules hold the PR until required checks and reviews pass.
4. Merging the release PR synchronizes package, lockfile, changelog, and manifest metadata on `main`.
5. A subsequent `release` run creates the exact `v<version>` tag and non-draft GitHub release and emits its documented tag.
6. `prepare` verifies the exact tagged source, tests and audits it, checks npm state, builds one lifecycle-script-disabled tarball, and uploads the immutable artifact plus its identity and digests.
7. `publish` waits at the protected `npm-publish` environment. An independent reviewer should inspect the run target and successful preparation before approving. Approve promptly because artifact retention is one day.
8. `publish` re-verifies the current-run artifact and exact tarball, obtains short-lived npm credentials through OIDC, and publishes with provenance.

A normal run where Release Please creates no release ends without preparing or publishing. If approval is not safe, reject or leave the deployment unapproved and pause the automation gate; never bypass the environment.

## Recovery publish

Recovery is only for an exact, existing, non-draft GitHub release tag whose npm publication did not complete. Both gates and all environment protections must remain valid.

First inspect the exact tag, then dispatch the workflow from `main`:

```bash
gh release view v1.2.3 \
  --repo 10ego/pi-footer-display \
  --json tagName,isDraft,targetCommitish

gh workflow run .github/workflows/release-please.yml \
  --repo 10ego/pi-footer-display \
  --ref main \
  -f tag='v1.2.3'
```

The input must be the complete exact `v`-prefixed SemVer tag, not a branch, SHA, range, draft, or unprefixed version. `--ref main` is mandatory even though `prepare` later checks out the explicit tag.

In recovery:

- `release` intentionally skips, so `release-automation` is not entered and the App private key is not exposed.
- `prepare` runs via its `always()` recovery condition and uses read-only `github.token`, not the App key, to require an existing release with the exact tag and `isDraft == false`.
- The tag must resolve to the checked-out commit and that commit must be in `main` history.
- If the exact npm version already exists, recovery succeeds as a no-op and creates no artifact. If it is absent, `prepare` performs all normal checks and creates a fresh current-run artifact.
- `publish` still requires independent approval in `npm-publish` and performs every normal artifact and tarball verification.

Never move a tag, convert an unrelated tag into a release, manually upload a replacement artifact, or bypass review to recover.

## Pause or disable automation

Remove `RELEASE_AUTOMATION_ENABLED` or set it to a value other than `true` to stop new release work. Closing `NPM_TRUSTED_PUBLISHING_READY` also stops all three jobs when npm OIDC is unavailable.

A gate change does not cancel a running or waiting job. Cancel the workflow run or reject its pending environment deployment separately. PR CI remains active.

Before restoring service, revalidate all prerequisites. Restore `NPM_TRUSTED_PUBLISHING_READY=true` first and `RELEASE_AUTOMATION_ENABLED=true` last.

## Troubleshooting

### All release jobs are skipped

Check both exact gate values and the run ref:

```bash
gh variable list --repo 10ego/pi-footer-display
gh run list --repo 10ego/pi-footer-display --workflow release-please.yml --limit 10
```

Normal mode requires a push to `main` or an empty-tag dispatch with `--ref main`. Recovery requires a non-empty exact tag and `--ref main`. In recovery, `release` being skipped is expected; `prepare` should run through its recovery condition. In a normal run that creates no release, `prepare` and `publish` being skipped is expected.

Do not open a gate merely to diagnose an unmet prerequisite.

### A job is waiting for an environment

A disallowed ref should be rejected by the environment's main-only deployment rule. A `publish` run from `main` waits for an independent `npm-publish` reviewer; the initiating actor must not self-approve. Confirm a primary or backup reviewer is available and that administrator bypass remains disabled.

If required controls are missing from the UI, confirm repository visibility and GitHub plan support. Keep the gates closed until the controls are enforceable. If the one-day artifact expires while waiting, do not substitute another file; cancel and use the documented recovery dispatch to create a new current-run artifact.

### App token creation fails in `release`

Verify all of the following:

- `NERV_OPS_APP_ID` is the matching numeric variable.
- The complete PEM is named `NERV_OPS_PRIVATE_KEY` in `release-automation`, not at repository level.
- The job was admitted by the `release-automation` main-only policy.
- The `nerv-ops` App installation is active for this repository with Contents, Issues, and Pull requests read/write permissions.

Rotate a suspected key in the App and environment secret store. Never print or commit it. `prepare` and `publish` must not be changed to consume the key as a workaround.

### The release PR is missing or does not auto-merge

Inspect the Release Please and auto-merge steps, then verify the baseline and PR rules:

```bash
git cat-file -e 147470b11439248d54b011a011663254709c36c3^{commit}
npm run verify:release-version
gh pr checks PR_NUMBER --repo 10ego/pi-footer-display
gh pr view PR_NUMBER --repo 10ego/pi-footer-display \
  --json autoMergeRequest,mergeStateStatus,statusCheckRollup
```

Confirm App-authored PRs trigger `Validate PR title` and `Test`, repository auto-merge is enabled, and squash is allowed. Do not bypass a failed check or rewrite history around the bootstrap commit.

### Recovery release verification fails

Confirm the dispatch used `--ref main` and an exact tag such as `v1.2.3`. The GitHub release must already exist for exactly that tag and must not be a draft. `prepare` verifies it with read-only `github.token`; an App-key error in this path indicates workflow drift, not a missing recovery prerequisite.

The checked-out tag must resolve exactly and be an ancestor of `origin/main`. Create a new legitimate release through Release Please rather than moving an invalid tag.

### Preparation tests, audit, or packaging fail

Reproduce only from a clean checkout of the exact immutable tag:

```bash
npm ci
npm test
npm run verify:release-version -- --expected VERSION
npm run verify:package
```

Check the tag-to-version mapping, `main` ancestry, package allowlist, and bundled npm minimum. The workflow deliberately packs only once and disables lifecycle scripts. Fix forward with a new version; do not repack or replace an existing release.

### Artifact verification fails in `publish`

Inspect the `prepare` outputs and GitHub artifact server metadata. The artifact must have the exact numeric ID/name, be unexpired, carry the upload digest, belong to the current `GITHUB_RUN_ID`, download as one exact regular tarball, match the prepared SHA-256, and contain only safe `package/` members with the expected manifest identity.

Do not manually download, unzip, repack, rename, or re-upload the tarball. Cancel the run and use recovery to produce a fresh artifact after identifying the cause. Missing `actions: read` is a workflow-permission defect; do not add Contents permission or a secret.

### npm trusted publishing cannot authenticate

Confirm npm's trusted publisher exactly names:

```text
10ego / pi-footer-display / release-please.yml / npm-publish
```

The workflow filename is not a path, and the environment must not be blank or different. Confirm `publish` entered `npm-publish`, received `id-token: write`, and uses bundled npm `>=11.5.1`. There is intentionally no `NPM_TOKEN` fallback. Close the npm readiness gate until OIDC is corrected.

### npm availability or dist-tag checks fail

Inspect the exact candidate and selected channel:

```bash
npm view pi-footer-display@VERSION version --json
npm view pi-footer-display dist-tags.latest --json
npm view pi-footer-display dist-tags.next --json
```

Only structured npm JSON `E404` output proves an exact candidate is absent. Malformed JSON, a missing property on an existing package, authentication errors, registry errors, and network failures stop preparation. A stable candidate must exceed the current `latest`; a prerelease candidate must exceed the current `next`. Equality after an absence result indicates inconsistent or racing registry state and fails closed.

If a normal run reports a duplicate, verify npm and the GitHub release before using the exact recovery flow. Never reuse or move the tag.

### The published `0.1.0` checksum differs

Re-run the unauthenticated npm metadata query and independently hash the registry tarball. Compare against all three recorded values in the bootstrap section. Stop release activation, preserve evidence, and investigate registry, network, cache, and local-tooling causes. Do not attempt another bootstrap publish or change the recorded baseline without a documented security review.
