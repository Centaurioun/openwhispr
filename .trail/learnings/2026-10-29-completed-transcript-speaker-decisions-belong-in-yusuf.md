---
title: Completed transcript speaker decisions belong in the overlay
author: Yusuf
date: 2026-10-29
branch: codex/transcript-studio-2026-10-29
id: l-f7eeee46
scope: repo
status: active
src: agent
touches:
  - src/components/notes/NoteEditor.tsx
  - src/custom-features/transcript-studio/domain/editOperations.ts
  - src/custom-features/transcript-studio/domain/normalizeSource.ts
  - src/custom-features/transcript-studio/domain/types.ts
  - test/components/noteEditorSummaryDeletion.test.js
  - test/helpers/transcriptStudioOperations.test.js
---

## Decided
When completed transcripts move from the legacy chat to Transcript Studio, keep speaker mapping and self-suggestion workflows but route transcript decisions into the approved overlay. Call profile/mapping logic in non-source-persisting mode so the immutable note transcript stays unchanged.

## Tried and ruled out
Passing the legacy MeetingTranscriptChat callbacks through unchanged is unsafe because their persistence path can write speaker decisions back into notes.transcript. Reusing note-ID export from Studio is also unsafe because it may export raw content while approved edits are displayed.

## Watch out
Cross-speaker merges can discard assignment identity or lock state, so reject incompatible merges. Queue Undo/Redo restoration behind pending revision saves. Keep the live recording route separate from the completed transcript editor.

In the code: src/components/notes/NoteEditor.tsx preserves the live route and uses TranscriptStudioView for completed transcripts; src/custom-features/transcript-studio/components/TranscriptStudioView.tsx accepts existing mapping/suggestion callbacks with source persistence disabled and records transcript operations in the overlay; Task 8 transcriptResolver.ts is the planned approved-content path for export.
