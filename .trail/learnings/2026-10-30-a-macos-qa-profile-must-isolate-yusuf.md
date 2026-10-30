---
title: A macOS QA profile must isolate app data and package dependencies
author: Yusuf
date: 2026-10-30
branch: codex/transcript-studio-2026-10-29
id: l-13fbfc52
scope: repo
status: active
src: agent
touches:
  - docs/custom/transcript-studio-qa.md
  - electron-builder.json
  - main.js
---

## Decided
For macOS Electron QA, use the explicit absolute `OPENWHISPR_QA_USER_DATA_DIR` override; changing `HOME` alone does not redirect Electron's app data path. Treat the macOS bundle identity as a separate isolation boundary because TCC permissions are keyed by bundle identity rather than Electron user data. Build from the lockfile-installed dependency graph before trusting a local packaged artifact.

## Tried and ruled out
A package assembled while this worktree's `node_modules` pointed at another worktree omitted `duplexer2`, even though `unzipper` requires it. A fresh `npm ci` followed by electron-builder included the dependency and the app started. This was an installation-tree artifact, not a missing direct runtime dependency in the project manifest. `HOME` alone also proved insufficient as the profile isolation mechanism.

## Watch out
A failed isolated launch may read the normal profile `.env` before any UI appears if the explicit user-data override is absent. Never inspect that file as a fallback. The outer macOS network sandbox also prevented Electron's nested renderer sandbox from initializing. Launching with `--no-sandbox` is a security downgrade and is not valid security QA; use a distinct test bundle identity and a compatible sandboxed UI host before exercising app features or OS permissions.

In the code:
- `src/helpers/userDataPath.js` applies the QA path before user-data dotenv loading.
- `electron-builder.json` explicitly includes the Transcript Studio runtime module.
- Verify `duplexer2` and `unzipper` in the packaged ASAR after a clean lockfile install.
