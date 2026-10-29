# Task 2 Report: Isolation and Conflict Procedure

## Scope

Implemented Task 2 from `task-2-brief.md` in the fork integration safety plan. The checker remains read-only: it inspects cached Git state and never fetches, merges, or changes refs.

## Changes

- `scripts/custom/check-upstream-merge.mjs` now inspects `git merge-base main refs/remotes/upstream/main` against already-present refs. Missing refs and unrelated histories produce `mergeBase: null`; the validator fails closed when the merge base is absent. Dirty `custom/main` receives an explicit rejection reason, in addition to the general dirty-tree rejection.
- `test/helpers/customUpstreamGate.test.js` covers dirty `custom/main` and missing merge-base rejection. The clean fixture now carries a valid merge-base value.
- `docs/custom/CONTRIBUTING-FORK.md` documents `upstream/main → clean baseline main → PR to custom/main`, the explicit `git fetch --prune upstream` step, isolated worktree integration via `git merge --no-ff upstream/main`, manual conflict resolution, and green checks plus explicit human approval before PR merge. It disallows automatic conflict resolution, force pushes, and destructive resets.

## TDD and verification

Node 24 was used from `/opt/homebrew/opt/node@24/bin` (version `v24.22.1`). The initial targeted run had 8 passing tests and 1 failure: the new missing-merge-base case incorrectly passed before the checker change. The dirty `custom/main` case already failed closed under the existing general dirty-tree rule; after the change it also has an explicit branch-specific reason.

After implementation, `node --test test/helpers/customUpstreamGate.test.js` passed all 9 tests. `git diff --check` passed.

## Limits and concern

The checker compares local `main` with the cached `refs/remotes/upstream/main`; it deliberately does not fetch, so the result can be stale. Follow the documented fetch and human review procedure. A passing checker does not authorize a merge or prove integration compatibility.

## Commit

`chore(fork): add isolation and conflict gates`

## Focused review follow-up

Updated the dirty `custom/main` checker test to assert both the general uncommitted-change rejection and the explicit `custom/main must be clean` reason. To verify that this branch-specific assertion detects a regression, temporarily removed that reason from the validator and ran `node --test --test-name-pattern='dirty custom/main blocks integration' test/helpers/customUpstreamGate.test.js` with Node 24. It failed as expected because the actual reasons contained only the generic uncommitted-change message. Restored the validator without retaining any temporary edits. The full targeted file then passed all 11 tests, and `git diff --check` passed.
