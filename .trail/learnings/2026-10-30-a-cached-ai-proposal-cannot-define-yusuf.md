---
title: A cached AI proposal cannot define its own source scope
author: Yusuf
date: 2026-10-30
branch: codex/transcript-studio-2026-10-29
id: l-4bf7d1ec
scope: repo
status: active
src: agent
touches:
  - docs/custom/transcript-studio-qa.md
  - src/custom-features/transcript-studio/components/ProposalReview.tsx
  - src/custom-features/transcript-studio/components/TranscriptStudioView.tsx
  - src/custom-features/transcript-studio/domain/validateProposal.ts
  - src/custom-features/transcript-studio/process/chunkPlanner.ts
  - src/custom-features/transcript-studio/process/transcriptEditJob.ts
  - test/components/transcriptStudioReview.test.js
  - test/components/transcriptStudioView.test.js
  - test/helpers/transcriptStudioJob.test.js
  - test/helpers/transcriptStudioRepository.test.js
---

## Decided
Treat renderer-persisted AI proposal scope and cached chunk contents as untrusted. Recompute the expected full-source chunk plan and require exact chunk identity, order, membership, and metadata before restoring or reviewing a cached proposal. Drop structurally invalid cache entries and show a retry warning.

When a workflow intentionally processes only a selected subset, do not restore its cached results unless an independent trusted store records the requested scope. The current implementation has no such main-process or SQLite intent record, so fail closed and rerun the selected work.

## Tried and ruled out
Trusting the saved envelope scope, per-proposal draftScope, or the cached proposal chunk itself to define the expected source universe is circular: a modified cache can omit source segments and still appear complete relative to its own claims. Adding trusted scope persistence would require widening the fix into database, IPC, preload, and access-control layers; that is not needed to close this acceptance vulnerability.

## Watch out
Full-source and synthetic oversized-parent proposals can still be recovered after remount. Selected-subset cached proposals are intentionally discarded with a warning until a separately authorized scope is persisted. Tests must verify that discarded AI output does not mutate the original or approved transcript.

In the code:
- `src/custom-features/transcript-studio/components/TranscriptStudioView.tsx` reconstructs canonical full-source chunks before proposal cache rehydration.
- `src/custom-features/transcript-studio/process/chunkPlanner.ts` exports the default planning token budget used by both the job and recovery path.
- `test/components/transcriptStudioView.test.js` covers omitted/reordered chunks, forged scope metadata, retry warnings, immutable source, and synthetic oversized-parent recovery.
