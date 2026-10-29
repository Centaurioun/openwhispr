# OpenWhispr Integrated Transcript Studio — Approved Design

**Date:** 2026-10-29
**Status:** Approved in conversation; staged on an isolated feature branch for implementation, not merged.
**Repository:** Centaurioun/openwhispr
**Baseline reviewed:** main at b9e9ebefac4b961456c269164a93ddfdd53438b9

## Intent

Extend OpenWhispr's existing Electron/React/TypeScript desktop application with a native transcript editor. The user transcribes audio/video using OpenWhispr's existing local models. The resulting raw transcript is saved immediately; AI editing **never starts automatically**. The user clicks **Transkripti Düzenle**, then receives incremental, reviewable, non-destructive text proposals. They edit the transcript in the existing Transcript tab. They also want Codex to access OpenWhispr notes/transcripts through a local MCP server; a separately eligible ChatGPT-plan text inference provider; and protection against upstream updates overwriting fork customizations.

## Agreed behavior

- Default visible transcript is the current **approved edited version**, or raw if none is approved.
- **Speaker-oriented editing**, with labels and timestamps when available; no fabricated timestamps or speaker identities.
- Human edits, AI edit proposals, speaker renaming/reassignment/merge/split; no voice reanalysis or new diarization inference from audio in this phase.
- AI may flag **text-based** speaker uncertainty, but identity changes require explicit user approval; existing speaker locks win.
- Edit proposals are available progressively by completed chunk, even while later chunks process. Both per-change and bulk accept/reject.
- Word-like **session Undo/Redo** across manual and accepted AI/speaker operations, including keyboard shortcuts. A durable **Version History** persists across restarts, separate from in-session Undo.
- Original transcript is immutable and recoverable; applying/reverting a version must never destroy a later version.
- Transcript processing preserves speech and meaning; no summarizing, filler removal, or automatic wording rewrites in strict mode. Suspicious differences are flagged, not silently accepted.
- Existing note summaries, transcriptions and native diarization remain functional.
- No mandatory external API key: local model path remains useful. ChatGPT plan integration is an optional *separate provider*, subject to published eligibility and authorization; it is not audio transcription.
- MCP local-first, initially **read-only**. Do not unlock the hosted OpenWhispr paid MCP or bypass its subscription controls.
- Fork uses a protected integration branch, clear feature boundaries, independent tests, and safe upstream merge strategy. No GitHub projects/issues/milestones or code writes until later explicit instruction.

## Considered approaches

1. Extend existing summary actions: least initial code, but doesn't naturally support segment editing/history.
2. **Chosen:** In-app modular Transcript Studio alongside existing UI and persistence, with separate provider and MCP integrations.
3. External editor: independent app, but requires two-app experience and sync semantics.

## Architecture and constraints

Transcript Studio is a locally persisted, **derived overlay** associated with source note IDs, not a destructive rewrite of notes.transcript. Its core includes source-preserving normalization, stable segment identifiers, revisioned edit operations, AI proposal validation, progressive queue, rich text/speaker UI and export resolution. Define a single resolver so consumers explicitly request original or approved text; avoid silently making unmodified upstream/cloud paths consume edits. A note whose original changes must trigger stale-source handling and explicit review rather than automatic rebase. Local-only storage is the initial conservative choice; cross-device sync of edited versions requires separate design approval.

MCP is a separate localhost/stdio adapter over the existing authenticated local CLI bridge (src/helpers/cliBridge.js), preferably using @openwhispr/cli, and exposes bounded read-only tools to Codex. The ChatGPT provider uses official Sign in with ChatGPT plan-use registration and eligible Responses requests **only if authorized for this fork**; never read or reuse Codex CLI tokens or undocumented ChatGPT endpoints.

## Non-goals

- Audio reanalysis, external transcription API usage, video understanding, audio-based speaker identification.
- Silent edits to raw notes, automatically applying AI changes, new hosted backend, bypassing Pro/paywalls.
- Unreviewed cross-device sync, broad remote access to the local MCP, unaudited automatic Git merges.
- Replacing existing transcriptions/diarization, rewriting the whole UI or summary system.

## Acceptance gates

1. Source and original/approved render equivalence (no edited overlay → behavior unchanged).
2. Incomplete AI output or failures never overwrite approved text.
3. Speaker locks, timestamps, segment IDs stable through split/merge and undo.
4. Undo/Redo and history restore behave predictably; persistence survives restart.
5. Multi-hour and multilingual texts pass omission/duplication/ordering tests; uncertainty warnings shown.
6. MCP cannot write, traverse arbitrary paths or access unintended accounts.
7. Subscription sign-in/token refresh/abort/limit/expiry and no-key fallback tested; network access requires consent.
8. Upstream merges test CI, data migrations, build and representative UI; failure blocks release.

## Implementation sequencing

Four independently reviewable plans: 01-fork-integration-safety, 02-transcript-studio, 03-local-mcp, 04-chatgpt-plan-provider. Start with fork baseline, then Transcript Studio; MCP can be developed in parallel with Transcript Studio; the ChatGPT provider is optional and must pass eligibility gate first. Each plan must be approved before code execution. GitHub Projects/milestones/issues remain deferred.
