# Transcript Studio QA

This checklist covers the local derived transcript overlay. Never use a personal profile, real meeting transcript, production service, or installed release for QA. Use synthetic fixtures and a disposable profile/database only. Do not upload transcript text to a remote provider unless a test explicitly exercises the consent dialog; denial must result in zero provider calls.

## Automated acceptance

Run from the repository root with Node 24 and the disposable SQLite harness enabled:

Ensure Node 24 is first on `PATH`, then run:

```sh
# macOS / Linux
REQUIRE_DB_TESTS=1 node --import tsx --test test/helpers/transcriptStudioAcceptance.test.js
```

```powershell
# Windows PowerShell
$env:REQUIRE_DB_TESTS = "1"
node --import tsx --test test/helpers/transcriptStudioAcceptance.test.js
```

The acceptance file covers these boundaries:

- A one-hour plain-text fixture and a two-hour timed, multi-speaker fixture survive a temporary SQLite close/reopen with the approved revision intact and `notes.transcript` byte-for-byte unchanged.
- Fixtures include Turkish diacritics, names/entities, decimal values, source labels and a locked speaker assignment.
- Two independent database handles simulate two editor windows writing from the same expected revision. The first write wins and the stale second write conflicts without overwriting it.
- Switching accounts removes access to the private note; changing a team note's mirrored `edit_notes` capability changes edit authority on the next check.
- A corrupt approved operation displays the original transcript and an error rather than corrupting or hiding the source.
- Unsorted or missing source timestamps remain unchanged; SRT returns no cues instead of fabricating positions.
- A denied remote-consent decision invokes no provider; cancellation while a provider call is pending discards its late proposal.

Task 9 local run (Node v24.22.1): this acceptance command passed **9/9** on 2026-10-30.

The tests use private temporary SQLite files. One test writes a committed revision in a child Node process, exits it with a nonzero status without closing its database handle, then opens the same file in the parent to verify recovery. This checks committed-state durability across abrupt process exit, but does not kill a process mid-transaction or test a packaged desktop process. The multiple-window test uses two database handles and optimistic revision checks; it does not test OS window lifecycle or cross-device synchronization.

Run the repository quality checks after changing the implementation:

```sh
npm run typecheck
npm run lint
npm run format:check
npm run i18n:check
npm run build:renderer
PATH=/opt/homebrew/opt/node@24/bin:$PATH REQUIRE_DB_TESTS=1 npm test
```

On macOS, `npm run test:swift641` runs that suite with Swift 6.4.1 selected only
for the command through Swiftly. It does not change Swiftly's global default or
Xcode selection. Use this when the `swiftc` at the front of `PATH` is not
compatible with the selected Xcode SDK.

Record each command's exit status, test totals, skipped/todo tests, and any native toolchain error. The native macOS audio snapshot test may require a compatible Swift/Xcode SDK; classify a reproducible local SDK mismatch separately from product failures. Hosted GitHub CI is `PENDING_QUOTA_RESET` while the documented Actions quota remains exhausted.

## Manual accessibility and behavior checks

Perform only with a disposable profile containing the synthetic fixtures listed above. Record OS/version, app commit, assistive technology and outcome for every item.

1. Open a completed synthetic meeting and switch between Notes and Transcript. Confirm the original/approved display matches the selected revision and the raw source remains unchanged after editing.
2. Use only the keyboard. Tab and Shift+Tab through the transcript toolbar, segment controls, editor, proposal review, history, compare and restore controls. Confirm focus remains visible, follows visual order, and does not become trapped. Use Enter/Space on buttons and Escape to close any open dialog where supported. Perform an edit, Undo, Redo, and restore; verify the editor and history status update.
3. With VoiceOver on macOS or Narrator on Windows, traverse the same path. Confirm tabs, buttons, text fields, proposal sections, speaker controls, timestamps, errors and confirmation dialogs expose meaningful names/roles/states. Confirm focus moves into and returns from dialogs, and that read-only controls announce their disabled state.
4. Review pending AI proposals without accepting them. Confirm the approved text does not change. Deny remote processing and verify the UI reports cancellation; do not use a real account or provider key during this check.
5. Reopen the disposable app profile after making an approved edit. Confirm the edit remains available, restore adds a revision instead of deleting history, and the original transcript remains unchanged.
6. Open a shared synthetic note first with edit permission and then as a viewer. Confirm viewers cannot edit or restore, and changing the server-mirrored permission is enforced after access is refreshed.
7. Run the same smoke path on macOS and Windows. These OS/assistive-technology checks are manual release evidence and are not established by the automated DOM tests.

If any platform check fails, capture the exact control, keyboard/AT action, expected and observed result, OS/app versions and a synthetic-only screenshot. Do not include real transcript text or profile data.

## Migration check on a disposable database

1. Create a temporary database using the repository test harness; seed only synthetic notes and a copy of the prior overlay schema.
2. Start the current database initialization/migration path and verify the owning account keeps its previous version history, unowned legacy team history remains inaccessible to team members, and current raw transcript bytes remain unchanged.
3. Repeat initialization to verify idempotence, then close/reopen the temporary database and check the same facts again.
4. Delete the temporary database and its fixture directory when the test harness exits. Never point this procedure at the default Electron user-data directory.

The automated legacy-schema migration regression lives in `test/helpers/transcriptStudioRepository.test.js`; this manual procedure supplements that fixture and does not certify migration against real user databases.
