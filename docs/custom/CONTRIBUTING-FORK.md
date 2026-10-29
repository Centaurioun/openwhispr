# OpenWhispr Custom Fork: Non-Destructive Integration Policy

This fork tracks upstream [OpenWhispr/openwhispr](https://github.com/OpenWhispr/openwhispr) while independently developing a local Transcript Studio, a read-only Local MCP adapter, and an optional eligible ChatGPT-plan text provider.

## Branches and review policy

- `origin` points to `Centaurioun/openwhispr` (the personal fork). Never assume local `origin` is configured until inspecting `git remote -v`.
- `upstream` must point to `https://github.com/OpenWhispr/openwhispr.git` (equivalent official SSH URL permitted).
- `main` is the clean upstream baseline **where practical**. It must not be force-reset, rebased, or changed merely to make it match upstream; preserve existing commits and investigate differences first.
- `custom/main` is the **proposed** reviewed integration branch, created only after its starting point and compatibility with other work are verified. It is not a synonym for `main`.
- Each subsystem uses isolated `feature/*` branches and disposable Git worktrees. Merge only via a reviewed PR with green required checks and manual approval.

## Read-only preflight

Run from a local checkout **after** a human has inspected its state:

```sh
node scripts/custom/check-upstream-merge.mjs
```

The command runs only read-only Git subcommands; it does not fetch or change branches. It refuses a dirty tree, a missing/unexpected upstream remote, invalid/unavailable upstream comparison, or a diverged/behind `main`. A passing result is **not permission to merge** and does not prove the build is healthy.

For initial inspection:

```sh
git status --porcelain=v1
git branch -vv
git remote -v
git log --oneline --decorate -n 12
```

If the `upstream` remote is absent, obtain approval for any needed local configuration. If `upstream/main` has not been fetched, the checker intentionally blocks; a reviewer should first inspect that fetch is safe and that it targets the verified repository.

## Integrations and release guardrails

### Custom release acceptance

Use [the release checklist](release-checklist.md) for every custom-fork release candidate. Release is **NO-GO** while any required evidence is incomplete or missing; record the specific blocker. A human release reviewer must record explicit sign-off for the exact candidate after reviewing the clean branch, green tests, and all manual smoke-test evidence. Documentation, source inspection, or CI cannot establish that manual smoke tests passed.

Build and install the custom fork with a separate custom application identity and installation so it can be distinguished from the upstream application. Do not replace an existing application or alter, migrate, or reuse an existing user profile without separate human review of the identity, installation, and profile safety. This checklist does not authorize deployment, publishing, installation, or profile migration.

### Upstream integration procedure

Use the reviewed path `upstream/main → clean baseline main → PR to custom/main`:

1. Inspect `git status --porcelain=v1`, `git branch -vv`, and `git remote -v`; confirm the checkout and remotes before changing refs. Preserve existing local commits and back up any valuable work.
2. Fetch explicitly with `git fetch --prune upstream`. Review what the fetch will update and confirm `upstream/main` resolves to the verified official repository.
3. Confirm baseline `main` is clean and establish `git merge-base main upstream/main`. A missing merge base or dirty tree blocks integration; stop and investigate rather than guessing.
4. Create or use a disposable isolated worktree from the clean baseline `main`. In that worktree, integrate with `git merge --no-ff upstream/main` so the integration remains reviewable. Resolve conflicts manually, inspect every resolution, and run required checks. Do not use automatic conflict resolution.
5. Push the reviewed integration to a feature branch and open a PR targeting `custom/main`. Require green checks and explicit human approval before the PR is merged. The checker and a passing test suite do not grant merge approval.

No automatic upstream merges, force pushes, or destructive resets are allowed. Never force-push; stop for human review if history or conflicts require special handling.

1. No automatic upstream merges, force pushes, or destructive resets. Establish a merge base and review the full diff in an isolated worktree before integrating upstream changes.
2. Preserve the user's production data: **never** test migrations against the installed application profile. Copy user-data and SQLite WAL/shm consistently to an isolated temporary profile and verify restoration before migration.
3. Do not modify application identifiers, signing credentials, distribution channels, or installed applications without an explicit release review.
4. No personal audio, transcripts, access tokens, local databases, or other secrets in Git commits, CI logs, or artifacts.
5. The local MCP adapter starts read-only; do not expose a public transport or circumvent the hosted Pro MCP service.
6. AI editing must never rewrite the immutable source transcript. A failed or cancelled edit cannot overwrite the last approved version.
7. Review and run tests for each feature branch, then review integration as a separate gate. Browser/renderer checks alone do not prove native Electron, microphone, local transcription, or user-data migration compatibility.
8. Deployment, signing, releases, user profile migrations, GitHub Projects/issues/milestones, and merges into `main` or `custom/main` require a separate deliberate action.

## Baseline verified during planning

On 2026-10-29, the fork's `main` and upstream's `main` GitHub refs both pointed to `b9e9ebefac4b961456c269164a93ddfdd53438b9`. This comparison does **not** establish the safety of any user's local checkout, which must be checked independently.
