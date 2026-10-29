# Task 5 Report: Release and Upstream Acceptance Gates

## Scope and changes

- Added `test/helpers/customReleaseChecklist.test.js`, checking that the release checklist explicitly names GO, NO-GO, clean branch, green tests, each required manual smoke-test domain, and blocker recording.
- Added `docs/custom/release-checklist.md` with candidate identity, evidence, human sign-off, all required gates, and fail-closed NO-GO guidance for missing or incomplete evidence.
- Updated `docs/custom/CONTRIBUTING-FORK.md` to require signed-off human release review, a separate custom application identity and installation, and separate review before replacing an existing app or changing/migrating/reusing a profile.
- Manual smoke tests are explicitly not established by documentation, source inspection, a build, or CI. This work did not run smoke tests or affect a live installation, profile, deployment, or publication.

## RED / GREEN

- **RED:** Before the checklist existed, `/opt/homebrew/opt/node@24/bin/node --test test/helpers/customReleaseChecklist.test.js` failed as expected with `ENOENT` for `docs/custom/release-checklist.md`.
- **GREEN:** After adding the checklist, the same focused command passed: 1 test, 1 pass, 0 failures.

## Verification

- Focused test: `/opt/homebrew/opt/node@24/bin/node --test test/helpers/customReleaseChecklist.test.js` — passed (1/1).
- Checklist assertions: Node assertion pass over 11 explicit required terms/domains — passed (11/11).
- `git diff --check` — passed.
- Full suite, strict DB mode and corrected native/SDK environment:

  ```sh
  SDKROOT="$(xcrun --show-sdk-path --sdk macosx)" PATH="/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin:/opt/homebrew/opt/node@24/bin:$PATH" ELECTRON_OVERRIDE_DIST_PATH=/tmp REQUIRE_DB_TESTS=1 CI=true npm test
  ```

  **Result:** exit code 0; 10,259 tests, 10,244 passed, 0 failed, 14 skipped, 1 todo; 8 suites; duration 128,634.651 ms. Node was v24.22.1.
- The earlier attempt with `PATH=/opt/homebrew/opt/node@24/bin:$PATH CI=true npm test` failed in `audioActivityDetector.test.js` because the environment selected Swift 6.3 without `SDKROOT`. It was rerun with the Xcode toolchain and macOS SDK as above and passed; no Swift source change was made.

## Limits and disposition

- The passing tests and checklist assertions do not prove the manual source transcription, transcript editor, note summary, original/edited export, MCP read access, or sign-in regression smoke tests. Those remain required evidence for a human GO decision.
- Task 4's disposable SQLite work does not certify real user profiles. No profile migration, live smoke testing, deployment, publication, or installation was performed.
- Commit requested by the task brief: `docs(fork): define release and upstream acceptance gates`.
