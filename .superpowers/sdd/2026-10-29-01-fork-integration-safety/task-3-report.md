# Task 3 Report: Custom Integration Regression Gate

## Scope and changes

Implemented Task 3 from `task-3-brief.md`.

- Added `.github/workflows/custom-integration.yml`, a pull request workflow covering `custom/main`, `custom/**`, and other feature branches. It uses Node 24, `npm ci`, and required sequential steps for `npm test`, typecheck, lint, i18n consistency, and renderer build. No step allows failure, and the workflow contains no release or deployment operation.
- Added a workflow-parser test to `test/helpers/customUpstreamGate.test.js` while preserving all Task 1/2 checker tests. It verifies the required script names, branch coverage, Node setup, lockfile install, and fail-closed/no-release policy.
- The workflow comment states that the Ubuntu job does not build or certify platform-specific native helpers or packaged application targets.

## RED/GREEN

The first focused Task 3 test run occurred before the workflow was added. Both parser tests failed because `.github/workflows/custom-integration.yml` did not exist. After adding the workflow, the focused tests passed.

## Local verification

The focused test used the required Node 24 executable (`/opt/homebrew/opt/node@24/bin/node`, version `v24.22.1`):

- `/opt/homebrew/opt/node@24/bin/node --test test/helpers/customUpstreamGate.test.js` — exit 0; 11 tests passed, 0 failed.

Requested quality commands were run via the available `npm` command (the shell resolved `node` to v26.12.1):

- `npm test` — exit 1. The output reports that `better-sqlite3`'s native binding is unavailable for this Node runtime; affected native-dependent tests fail/skip. Full suite does not pass in this local dependency/runtime state.
- `npm run typecheck` — exit 0.
- `npm run lint` — exit 0; existing lint warnings were reported (unused variables in `settingsStoreMeetingFollowFlags.test.js`, React refresh warnings in `src/components/icons/primitives.tsx`, and Node's module-type warning).
- `npm run i18n:check` — exit 0; locale keys and placeholders are consistent.
- `npm run build:renderer` — exit 0; Vite emitted the existing large-chunk warning.

## Hosted checks and limits

No hosted GitHub check result was obtained during this task. The local full test suite failure prevents claiming CI passed. The workflow's Linux renderer checks do not represent native helper or packaged-app builds on macOS or Windows.

## Commit

`299a7c0c` — `ci(fork): gate custom integration against regressions`.


## Fix round (2026-10-29)

Addressed the workflow review findings on top of `299a7c0c`:

- PR events now target only `custom/main`; push events cover only `feature/**`. The parser test asserts both trigger arrays exactly, so an unbounded wildcard cannot silently broaden CI scope.
- Dependency installation uses `npm ci --ignore-scripts`, followed by `npm rebuild better-sqlite3` for the Node 24 ABI. The `npm test` step sets `ELECTRON_OVERRIDE_DIST_PATH: /tmp` and `REQUIRE_DB_TESTS: '1'`, preventing an Electron-built addon or silently skipped database tests from producing a false green.
- All Task 1/2 checker tests remain present.

Fix-round verification:

- `/opt/homebrew/opt/node@24/bin/node --test test/helpers/customUpstreamGate.test.js` — exit 0; 11 passed, 0 failed, 0 skipped, 0 todo.
- `git diff --check` — exit 0; no whitespace errors.
- The coordinating agent reported a separate completed strict Node 24 full-suite run after rebuilding `better-sqlite3` and correcting the SDKROOT/Xcode environment: 10,242 passed, 0 failed, 14 skipped, 1 todo. I did not rerun the full suite in this fix round to avoid overlapping that run.

The earlier `npm test` result above was from the Node 26 local shell with an Electron ABI binding and was not representative of the workflow's Node 24 strict test setup. No hosted check result is claimed.

