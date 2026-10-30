---
title: "Keep the capture guard's ESM caller out of its CommonJS module"
author: Yusuf
date: 2026-10-30
branch: codex/local-mcp-2026-10-30
id: l-e46b6889
scope: repo
status: active
src: agent
touches:
  - src/helpers/audioManager.js
  - test/helpers/macosPasteRead.test.js
  - test/helpers/meetingAudioTimeline.test.js
  - test/helpers/meetingStartupMicAudio.test.js
  - test/helpers/meetingSystemAudioDegrade.test.js
  - test/helpers/qaCapturePolicy.test.js
  - src/helpers/qaCapturePolicy.js
  - main.js
---

## Decided
Keep the shared Electron main and IPC capture policy in CommonJS, and expose the one audioManager assertion through a tiny ESM module. Vite's SSR evaluator loads audioManager as ESM and does not provide `require` inside the CommonJS helper's inlined source.

## Tried and ruled out
Importing the CommonJS capture policy directly from audioManager failed every Vite-backed AudioManager test with `ReferenceError: require is not defined`. The capture guard itself was inert by default; this was a module-boundary failure rather than a microphone-policy failure.

## Watch out
Tests that evaluate IPC handler slices in a `vm` do not inherit module-scope imports. Supply the capture-policy predicate explicitly in those harnesses, while dedicated IPC tests exercise the real guard. The macOS paste-read regression also benefits from polling the private test pasteboard after its late-read threshold instead of assuming one read at 600 ms always returns data.

## In the code
- `src/helpers/qaCapturePolicy.js` remains the CommonJS source used by `main.js` and IPC modules.
- `src/helpers/qaCapturePolicy.mjs` exports the ESM-compatible `assertCaptureAllowed` used by `src/helpers/audioManager.js`.
- VM-based harnesses are in `test/helpers/meetingAudioTimeline.test.js`, `meetingStartupMicAudio.test.js`, and `meetingSystemAudioDegrade.test.js`.
- The private pasteboard timing test is `test/helpers/macosPasteRead.test.js`.
