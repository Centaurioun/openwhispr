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
