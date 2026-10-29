# Fork Integration Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the fork's custom features safe to develop, test, merge with upstream and distribute without silently losing user data or changes.

**Architecture:** Keep the fork's normal `main` as a clean upstream-tracking baseline where possible, and maintain `custom/main` for reviewed integration. Use separate feature branches/worktrees, explicit merge gates and local backup/recovery procedures before data migrations.

**Tech Stack:** Git, GitHub Actions, npm, Node.js >=24, Electron, React, TypeScript, `node --test` with `tsx`.

**Spec:** `docs/superpowers/specs/2026-10-29-openwhispr-integrated-studio-design.md`

## Global Constraints

- Do not change or force-reset the existing fork branches without first reading and preserving their state.
- Do not create GitHub Projects, issues or milestones in this stage.
- Never deploy or publish a release automatically; human approval required.
- No secrets, user audio, transcripts or local database contents in commits, CI logs or releases.
- All feature changes must remain reviewable independently of upstream merges.

## Review Focus

1. Dirty working tree or local-only commits: refuse any destructive Git operation. [Task 1]
2. Unrelated upstream breaking change: detect conflict/regression and block merge. [Task 3]
3. Database schema migration failure: do not erase the existing user profile. [Task 4]
4. Packaged app replaces production application/data directory: refuse by default. [Task 5]
5. Electron/OS-specific build unavailable: mark as unverified; do not mark the release green. [Task 5]

---

## File Structure

- Create `docs/custom/CONTRIBUTING-FORK.md`: branch, review, backup policy.
- Create `scripts/custom/check-upstream-merge.mjs`: non-mutating validation of Git state and branch relationships.
- Create `test/helpers/customUpstreamGate.test.js`: gate tests.
- Create `.github/workflows/custom-integration.yml`: targeted CI with non-destructive checks.
- Create `scripts/custom/backup-user-profile.md`: platform-specific backup/restore runbook (documentation, no automated live-data copying).
- Create `docs/custom/release-checklist.md`: signed-off integration and smoke-test gate.

### Task 1: Verify Baseline and Define Non-Destructive Branch Policy

**Files:** Create `docs/custom/CONTRIBUTING-FORK.md`; create `scripts/custom/check-upstream-merge.mjs`; test `test/helpers/customUpstreamGate.test.js`.

**Interfaces:** `validateIntegrationState(input: {currentBranch: string; dirty: boolean; ahead: number; behind: number; upstreamRemote: string|null}): {ok: boolean; reasons: string[]}`; input is gathered by a separate read-only Git adapter.

- [ ] **Step 1:** Add failing tests: dirty state fails, missing upstream remote fails, clean state succeeds, non-fast-forward baseline produces a warning and blocks auto-update.
- [ ] **Step 2:** Run `node --import tsx --test test/helpers/customUpstreamGate.test.js`; confirm failure before implementation.
- [ ] **Step 3:** Implement `validateIntegrationState` and a read-only CLI reporting mode; document `origin`, `upstream`, baseline branch, `custom/main`, feature branches and worktree convention.
- [ ] **Step 4:** Rerun test, `npm run typecheck`, and `git diff --check`; verify successes.
- [ ] **Step 5:** Commit only the policy, checker and tests: `docs(fork): document non-destructive integration baseline`.

### Task 2: Create Isolation/Conflict Procedure

**Files:** Modify `docs/custom/CONTRIBUTING-FORK.md`; test `test/helpers/customUpstreamGate.test.js`.

**Interfaces:** Procedure `upstream/main → clean baseline main → PR to custom/main`; never automatic conflict resolution or force push.

- [ ] **Step 1:** Add failing checker test for `currentBranch === 'custom/main' && dirty === true` and a missing merge-base; both must fail closed.
- [ ] **Step 2:** Run targeted test and observe failure.
- [ ] **Step 3:** Implement merge-base/gate checks; document `git fetch --prune`, `git merge --no-ff` in an isolated worktree, and explicit human approval before merge.
- [ ] **Step 4:** Verify targeted tests and `git diff --check`.
- [ ] **Step 5:** Commit `chore(fork): add isolation and conflict gates`.

### Task 3: CI Regression Gate for Custom Branch

**Files:** Create `.github/workflows/custom-integration.yml`; test `test/helpers/customUpstreamGate.test.js`.

**Interfaces:** PR checks on `custom/main` and feature branches; `npm test`, `npm run typecheck`, `npm run lint`, `npm run i18n:check` and `npm run build:renderer` when runner dependencies permit.

- [ ] **Step 1:** Add checker test that required check names and failure policies are present in a local checked-in workflow parser.
- [ ] **Step 2:** Verify red test.
- [ ] **Step 3:** Implement CI job using Node >=24 and pinned install (`npm ci`), no release/deployment steps; document platform-specific native build limitations.
- [ ] **Step 4:** Run local quality commands; then verify actual GitHub checks before claiming CI passed.
- [ ] **Step 5:** Commit `ci(fork): gate custom integration against regressions`.

### Task 4: Local Data Safety and Migration Recovery

**Files:** Create `scripts/custom/backup-user-profile.md`; create `test/helpers/customMigrationGuard.test.js`.

**Interfaces:** Pre-migration checklist: close app, locate app-user-data path at runtime, make versioned backup, verify restore in disposable profile, preserve SQLite journal/WAL consistency.

- [ ] **Step 1:** Add failure fixture: simulated schema migration error leaves original disposable SQLite database readable and its raw transcript hash unchanged.
- [ ] **Step 2:** Run tests and verify expected failure.
- [ ] **Step 3:** Document safe backup/restore and test harness for migrations against temporary profiles; forbid production profile operations in automated tests.
- [ ] **Step 4:** Verify migration safety test and cross-platform documentation.
- [ ] **Step 5:** Commit `test(fork): protect user profile during schema upgrades`.

### Task 5: Release/Upstream Acceptance Checklist

**Files:** Create `docs/custom/release-checklist.md`; modify `docs/custom/CONTRIBUTING-FORK.md`.

**Interfaces:** `GO` only with clean branch, green tests, manual smoke checks for source transcription, transcript editor, note summary, original/edited export, MCP read access and sign-in regression; otherwise `NO-GO` with blocker.

- [ ] **Step 1:** Write checklist acceptance test verifying all required domains are explicitly named.
- [ ] **Step 2:** Confirm red test.
- [ ] **Step 3:** Document signed-off release gate, separate custom-app build identity/installation and no replacement of an existing application/profile until reviewed.
- [ ] **Step 4:** Run test suite and validate checklist completeness.
- [ ] **Step 5:** Commit `docs(fork): define release and upstream acceptance gates`.

## Deliverable / Gate

Isolated fork workflow documented, gate tests implemented and CI producing real results; no new feature or database migration is required for this plan to be complete. Only proceed to feature changes after a human validates the baseline branch and user-profile backup procedure.