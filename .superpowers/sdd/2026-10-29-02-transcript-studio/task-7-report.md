# Task 7 implementation report

## Implemented

- Added a version history panel with selectable read-only comparisons and an explicit restore confirmation in Transcript Studio.
- Added a note- and account-scoped snapshot read through the database, IPC, preload, and renderer repository. Restore uses the existing append-only database operation and adds a new revision; previous version rows remain available.
- A selected-version restore resets the in-memory session to the restored baseline, clearing session Undo/Redo. Existing Undo/Redo revision behavior remains unchanged.
- Snapshot storage remains a full cumulative operation snapshot per revision. New payloads use versioned raw DEFLATE plus base64 when this saves at least 16 bytes. Reads continue to accept legacy JSON rows. No history rows are capped or deleted.
- Text is persisted only on existing explicit editor commit/action boundaries; typing in the editor does not write a revision per keystroke.

## Verification

- Node v24.22.1: targeted Transcript Studio repository, view, and history suites, 25 passed, 0 failed, 0 skipped.
- Temporary SQLite tests cover close/reopen durability, read/compare snapshot access, retained restore targets, note isolation, and source transcript immutability.
- Synthetic compression fixture: a 32,000-character repeated transcript snapshot compresses from over 64,000 serialized JSON bytes to below 2,000 stored bytes (over 32x reduction) and remains readable/restorable after closing and reopening SQLite.
- `npm run typecheck`: passed.
- Scoped ESLint: passed. Database and IPC implementation files are excluded by existing lint ignore rules.
- Scoped Prettier check: passed.
- `git diff --check`: passed.
- `trail check`: completed with existing learning matches marked advisory; no build-graph mismatch was reported for the Task 7 changes.

## Limits

- Compression benefit depends on transcript repetition; incompressible payloads remain JSON. Because each snapshot is cumulative, retained database size still grows with the number of revisions. This change preserves old restore targets and does not impose a destructive history cap.
- `trail check` reports unrelated/advisory conflicts from existing branch learning matches; it does not fail on these entries.

## Review fix round 1

- Both transcript write IPC handlers now authorize writes in the main process. Local notes use the validated active account scope, team notes use the server-mirrored `edit_notes` capability (with the existing role fallback), and non-owner personal cloud notes must pass the existing authenticated `/api/notes/:id/access` permission check. Only `owner` and `editor` can write; unknown or failed ACL checks reject the request. No renderer-supplied edit flag is used.
- Version comparison now checks the snapshot source hash before replaying operations. Mismatched history clears the comparison pane and reports that comparison is unavailable; restore remains disabled while the error is present.
- Regression tests invoke the same registered IPC callbacks used by `setupHandlers`. Viewer restore and apply are rejected; editor and owner restore append new versions; team `edit_notes` false denies restoration. Reverting the registration to direct database calls made the authorization tests fail.
- A stale-source comparison test fails without the hash guard and passes with it.
- The selected-restore UI test now waits for the queued async restore to finish before asserting the unchanged expected baseline; the restore assertion remains `Original line`.
- Node v24.22.1: access, repository, view, and history suites, 28 passed, 0 failed, 0 skipped. Typecheck, scoped ESLint, Prettier check, Trail check, and `git diff --check` passed.
- The live cloud ACL request was not exercised against a service; tests supply permission results to the registered IPC callbacks. The handler uses the existing authenticated cloud request path and fails closed if that check is unavailable.
