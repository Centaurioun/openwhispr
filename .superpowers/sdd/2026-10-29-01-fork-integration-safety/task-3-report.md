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

`b755b303` — `ci(fork): gate custom integration against regressions`.
