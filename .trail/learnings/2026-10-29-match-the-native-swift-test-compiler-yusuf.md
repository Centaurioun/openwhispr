---
title: Match the native Swift test compiler to its SDK
author: Yusuf
date: 2026-10-29
branch: codex/transcript-studio-2026-10-29
id: l-6ab93149
scope: repo
status: active
src: agent
touches:
  - docs/custom/transcript-studio-qa.md
  - package.json
  - test/helpers/audioActivityDetector.test.js
---

## Decided
The macOS native snapshot test invokes `swiftc` from PATH, so its result depends on which compiler Swiftly or Xcode puts there. In this checkout, Swiftly 6.3.3 targeted macOS 28 against the selected macOS 27 SDK and failed while importing SDK modules. The selected Xcode 27.1 Swift 6.4.0 could not load its standard library for that target. Swiftly 6.4.1 targeted macOS 27 and compiled the same test successfully. Keep the default test path unchanged for CI and expose a per-command Swiftly 6.4.1 runner.

## Tried and ruled out
The native source was not the root cause: the identical native test passed under Swiftly 6.4.1 with the same SDK, and the full Node 24 suite then passed. Changing the source APIs or changing the machine-wide Xcode/Swift selection would have hidden the toolchain mismatch rather than solving it safely.

## Watch out
`swiftc` and `xcrun swiftc` can select different compiler releases even when they use the same SDK. Check both versions and targets before treating SDK import cascades as source errors. Use the repo's `test:swift641` command when the PATH compiler does not match the active SDK; this is a temporary selection, not a global default change.

## In the code
`test/helpers/audioActivityDetector.test.js` calls `swiftc` directly. `package.json` exposes `npm run test:swift641` as `swiftly run npm test +6.4.1`; it was verified with Node 24 and the full suite.
