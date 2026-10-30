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

Record each command's exit status, test totals, skipped/todo tests, and any native toolchain error. The native macOS audio snapshot test may require a compatible Swift/Xcode SDK; classify a reproducible local SDK mismatch separately from product failures.

GitHub Actions are enabled. The prior `PENDING_QUOTA_RESET` status is obsolete. On 2026-10-30, commit `2285ed3294ac12eed65d2397ff68d64a67c214fe` passed the [Build and Notarize quality workflow](https://github.com/Centaurioun/openwhispr/actions/runs/40978703714) (10,372 tests: 10,317 passed, 0 failed, 54 skipped, 1 todo), [Lockfile Lint](https://github.com/Centaurioun/openwhispr/actions/runs/40978703729), and [Mobile CI](https://github.com/Centaurioun/openwhispr/actions/runs/40978703686). Windows, Linux, and macOS build jobs and the Mobile platform-specific matrix jobs were skipped by change routing; those platforms are not verified by these runs. These results apply to the listed commit only. Check the PR's new workflow runs after publishing later changes; do not describe skipped platform checks as passes.

## Latest hardening and desktop QA status (2026-10-30)

AI proposals are now separated into structural validity and semantic uncertainty. A proposal must cover the complete canonical source chunk in order before it can be accepted or manually reviewed. Unsafe but structurally complete edits may be reviewed individually; structural failures contain no applicable edits. Cached drafts are revalidated against a fresh full-source chunk plan. Renderer `localStorage` scope metadata is not trusted as an authority: when a persisted proposal covers only a selected subset and there is no independently stored main/SQLite scope intent, it is discarded with a recovery warning and must be regenerated. Full-source and oversized synthetic parent proposals retain recovery coverage.

Current candidate local verification (Node v24.22.1, Swiftly Swift 6.4.1): `REQUIRE_DB_TESTS=1 npm run test:swift641` passed with **10,402 tests: 10,387 passed, 0 failed, 14 skipped, 1 todo**. The targeted cached-proposal UI regressions passed **8/8**. Typecheck, lint, format, i18n, renderer build, changed-diff secret scan, and `git diff --check` exited 0. Lint reported 11 warnings; the build reported existing ineffective dynamic-import and large-chunk warnings. These are local results and do not certify desktop behavior.

For commit `304c77c02ccf4c9177ee831f31c5a7bee1f28360`, GitHub Actions [Build and Notarize](https://github.com/Centaurioun/openwhispr/actions/runs/41015630649) completed **PASS**. The hosted test step reported **10,385 tests: 10,330 passed, 0 failed, 54 skipped, 1 todo**; quality checks, translation checks, dependency audit, and the runner's `better-sqlite3` build passed. [Lockfile Lint](https://github.com/Centaurioun/openwhispr/actions/runs/41015630838) and [Mobile CI](https://github.com/Centaurioun/openwhispr/actions/runs/41015630691) completed **PASS**. Windows, Linux, and macOS build jobs and mobile-specific matrix checks were **SKIPPED** by change routing, so these runs do not verify those platform builds or runtimes. These results apply to the exact commit above.

For docs-only commit `ae292e6a61c545f4ec4b17aff38faa12ab854bb6`, [Build and Notarize](https://github.com/Centaurioun/openwhispr/actions/runs/41017506078), [Lockfile Lint](https://github.com/Centaurioun/openwhispr/actions/runs/41017505834), and [Mobile CI](https://github.com/Centaurioun/openwhispr/actions/runs/41017506021) completed **PASS**. The hosted test step reported **10,385 tests: 10,330 passed, 0 failed, 54 skipped, 1 todo**. The `build-macos`, `build-linux`, and `build-windows` jobs were **SKIPPED** by change routing; this is not macOS package-build evidence. Windows and Linux runtime validation are out of scope for the current macOS-focused QA.

**macOS package smoke: `PASS` with limitations.** A macOS arm64 `.app` was built from a fresh `npm ci` lockfile install using `electron-builder --mac --dir`. Its ASAR contains both `transcriptStudioRuntime.cjs` and `unzipper`'s `duplexer2` runtime dependency. The earlier package produced from the shared `node_modules` symlink omitted `duplexer2`; a clean install reproduced the lockfile's complete dependency tree and corrected the local artifact without a source dependency change. A second local package used the test-only bundle ID `com.gizmolabs.openwhispr.codexqa`. Both packages are unsigned/unnotarized and for local QA only.

The test-bundle main process and windows started with a temporary `HOME` and `OPENWHISPR_QA_USER_DATA_DIR`; the app created its SQLite database in that temporary profile. Playwright/CDP read the main window and onboarding UI, advanced from shortcut setup to the local/cloud setup choices, opened the additional provider setup page, and returned without entering credentials. No model download, account sign-in, AI request, transcript fixture, or Transcript Studio feature flow was used. The auto-updater's startup check failed with `ERR_NAME_NOT_RESOLVED` under the outbound-network-deny sandbox. The QA profile initially had no dotenv values; a later startup read one value from the app-generated QA `.env`, which was not inspected. No `.env` values were copied or logged. A prior launch attempt without the explicit user-data override loaded the normal profile `.env`; its values were not inspected, and that process failed before opening a database or window.

Electron's renderer sandbox failed to initialize under the outer macOS network sandbox. The smoke launch therefore used `--no-sandbox`, which weakens renderer isolation and is not security validation. The QA package used a distinct bundle ID intended to separate its macOS TCC identity from the installed app, but TCC isolation was not verified. During a later approved relaunch, the packaged app unexpectedly started capture from the built-in MacBook Pro microphone even though no microphone permission was intentionally accepted in this QA session. The app then failed to start transcription because `OpenWhispr API URL not configured`; shutdown stopped the meeting/audio detectors and microphone listener. The isolated profile's `audio/` directory contained no files, and its database contained only one empty `Untitled Note` with no transcript. This is a **QA safety failure**: do not repeat the UI run until startup capture is understood and prevented or explicit QA permission behavior is verified. The app process and microphone listener were confirmed stopped. Outbound network remained blocked; no provider request occurred.

**Transcript Studio feature UI status: `NOT_TESTED`**. The approved relaunch reached the Insights and Home views, but did not open a transcript fixture or exercise transcript editing. CUA accessibility capture timed out. No synthetic transcript was seeded, and no transcript edit, speaker, history, AI proposal, export, keyboard, or VoiceOver flow was exercised. A synthetic empty personal note was present in the isolated database. Do not continue setup through model download or provider configuration for this QA run.

For macOS QA, setting `HOME` alone does not redirect Electron's `app.getPath("appData")`. Set `OPENWHISPR_QA_USER_DATA_DIR` to a fresh absolute temporary path and verify Electron uses it before opening the application. Also give QA builds a distinct macOS bundle identifier; a separate data directory alone does not isolate TCC permissions. Never inspect or use the normal profile as a fallback. Do not disable Electron's sandbox to work around an outer sandbox; this run's approved `--no-sandbox` launch is only a constrained functional smoke, not security evidence. Prefer a sandbox-compatible UI test host for feature-level QA.

## Manual accessibility and behavior checks

Perform only with a disposable profile containing the synthetic fixtures listed above. Record OS/version, app commit, assistive technology and outcome for every item.

1. Open a completed synthetic meeting and switch between Notes and Transcript. Confirm the original/approved display matches the selected revision and the raw source remains unchanged after editing.
2. Use only the keyboard. Tab and Shift+Tab through the transcript toolbar, segment controls, editor, proposal review, history, compare and restore controls. Confirm focus remains visible, follows visual order, and does not become trapped. Use Enter/Space on buttons and Escape to close any open dialog where supported. Perform an edit, Undo, Redo, and restore; verify the editor and history status update.
3. With VoiceOver on macOS, traverse the same path. Confirm tabs, buttons, text fields, proposal sections, speaker controls, timestamps, errors and confirmation dialogs expose meaningful names/roles/states. Confirm focus moves into and returns from dialogs, and that read-only controls announce their disabled state.
4. Review pending AI proposals without accepting them. Confirm the approved text does not change. Deny remote processing and verify the UI reports cancellation; do not use a real account or provider key during this check.
5. Reopen the disposable app profile after making an approved edit. Confirm the edit remains available, restore adds a revision instead of deleting history, and the original transcript remains unchanged.
6. Open a shared synthetic note first with edit permission and then as a viewer. Confirm viewers cannot edit or restore, and changing the server-mirrored permission is enforced after access is refreshed.
7. Run the smoke path on macOS. Windows and Linux runtime checks are out of scope for this project QA pass; they are not merge gates for the requested macOS work.

If any platform check fails, capture the exact control, keyboard/AT action, expected and observed result, OS/app versions and a synthetic-only screenshot. Do not include real transcript text or profile data.

## Migration check on a disposable database

1. Create a temporary database using the repository test harness; seed only synthetic notes and a copy of the prior overlay schema.
2. Start the current database initialization/migration path and verify the owning account keeps its previous version history, unowned legacy team history remains inaccessible to team members, and current raw transcript bytes remain unchanged.
3. Repeat initialization to verify idempotence, then close/reopen the temporary database and check the same facts again.
4. Delete the temporary database and its fixture directory when the test harness exits. Never point this procedure at the default Electron user-data directory.

The automated legacy-schema migration regression lives in `test/helpers/transcriptStudioRepository.test.js`; this manual procedure supplements that fixture and does not certify migration against real user databases.
