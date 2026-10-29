# Integrated Transcript Studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn OpenWhispr's existing Transcript tab into an editable, speaker-oriented, AI-assisted transcript workspace that protects the original and allows progressive review, Undo/Redo and durable version history.

**Architecture:** Keep `notes.transcript` as the immutable source for the editing workflow. Store the approved edited transcript, proposals and historical revisions in account-scoped local extension tables; attach via a narrow repository and renderer service. Reuse existing `NoteEditor`, `MeetingTranscriptChat`, `RichTextEditor`, transcription segment utilities and inference service without grafting document-edit functionality into the summary action store.

**Tech Stack:** Electron, React 19, TypeScript, Zustand, Tiptap/ProseMirror, SQLite (`better-sqlite3`), Node.js >=24, `node --import tsx --test`, current OpenWhispr inference providers.

**Spec:** `docs/superpowers/specs/2026-10-29-openwhispr-integrated-studio-design.md`

## Global Constraints

- Raw transcriptions and source audio remain unchanged; do not overwrite `notes.transcript` with edited data.
- AI editing runs only after explicit `Transkripti Düzenle`; never triggered by upload/transcription completion.
- Approved text is the default Transcript view; pending AI proposals are never directly applied to it.
- Text editing must not invent timestamps, source audio coverage or speaker identity; preserve confirmed/locked speaker assignments.
- Long-form AI editing is a **lossless-transform goal**, not summarization: reject incomplete output, flag suspected omission and changes to names/numbers.
- No new remote service, new audio processing or requirement to supply a paid API key.
- Keep derived edits local in v1; cross-device synchronization of overlays is out of scope pending separate approval.
- Baseline must remain functional without overlay rows (existing notes render identically).

## Review Focus

1. Legacy plain-string transcript, segment JSON and malformed segment JSON: render and edit safely without source destruction. [Task 1]
2. New diarization result arrives after the user started editing: no silent rebase or lost edits; mark overlay source stale. [Task 2]
3. One-hour transcript partial/truncated model response: never auto-approve and never truncate accepted text. [Task 5]
4. Changing speaker, splitting, merging and Undo/Redo across manual edits: stable IDs and locks survive. [Tasks 1, 4]
5. App closed mid-processing or note deleted/account switched: late responses cannot write into wrong or deleted note. [Tasks 2, 5]

---

## File Structure

- Create `src/custom-features/transcript-studio/domain/types.ts`: exact domain types.
- Create `src/custom-features/transcript-studio/domain/normalizeSource.ts`: segment normalization and stable identity derivation.
- Create `src/custom-features/transcript-studio/domain/editOperations.ts`: pure revision commands for text and speaker transforms.
- Create `src/custom-features/transcript-studio/domain/validateProposal.ts`: AI output/coverage checks.
- Create `src/custom-features/transcript-studio/persistence/repository.ts`: IPC-backed storage access.
- Create `src/custom-features/transcript-studio/process/chunkPlanner.ts`: source-aware chunk boundaries.
- Create `src/custom-features/transcript-studio/process/transcriptEditJob.ts`: queue, cancellation, proposal state.
- Create `src/custom-features/transcript-studio/components/TranscriptStudioView.tsx`: speaker-oriented workspace.
- Create `src/custom-features/transcript-studio/components/TranscriptBlockEditor.tsx`: editable segment text.
- Create `src/custom-features/transcript-studio/components/ProposalReview.tsx`: incremental per-change/bulk review.
- Create `src/custom-features/transcript-studio/components/VersionHistory.tsx`: durable revision picker/diff/restore.
- Create `src/custom-features/transcript-studio/stores/transcriptStudioStore.ts`: single active-document session state and undo/redo commands.
- Modify `src/helpers/database.js`: add separate local tables and account-scoped CRUD, no modification of raw note transcript semantics.
- Modify `src/types/electron.ts` and corresponding existing preload/main IPC registration: typed, authorization-checked transcript-studio operations (locate exact existing registration first).
- Modify `src/components/notes/NoteEditor.tsx`: integrate new Transcript view, action button and editor state, minimally.
- Modify `src/components/notes/MeetingTranscriptChat.tsx` only where speaker display/editing compatibility requires it.
- Modify `src/components/ui/RichTextEditor.tsx` only if Tiptap history or controlled editor behavior cannot be reused without changing the general editor; prefer a new transcript-specialized wrapper.
- Modify `src/helpers/transcriptFormatter.js` and export/summarization consumers only via explicit revision resolver after acceptance tests.
- Tests: `test/helpers/transcriptStudioNormalize.test.js`, `test/helpers/transcriptStudioRepository.test.js`, `test/helpers/transcriptStudioOperations.test.js`, `test/helpers/transcriptStudioChunking.test.js`, `test/helpers/transcriptStudioValidation.test.js`, `test/helpers/transcriptStudioJob.test.js`, `test/components/transcriptStudioView.test.js`, `test/components/transcriptStudioHistory.test.js`, `test/services/transcriptStudioResolver.test.js`.

### Task 1: Stable, Source-Preserving Transcript Domain

**Files:** Create `domain/types.ts`, `domain/normalizeSource.ts`; test `test/helpers/transcriptStudioNormalize.test.js`.

**Interfaces:** `SourceSegment = {id:string; text:string; speakerId:string|null; speakerName:string|null; startSeconds:number|null; endSeconds:number|null; speakerLocked:boolean; sourceIndex:number}`. `normalizeTranscriptSource(raw:string): {sourceHash:string; kind:'plain'|'segments'; segments:SourceSegment[]}`. Hash over exact original raw bytes; derive stable IDs once and persist them in overlay, never change original field.

- [ ] **Step 1:** Write failing tests: plain UTF-8 source produces one untimed/unnamed segment; JSON array preserves original speaker/timing; Unicode intact; malformed JSON fails safely with raw text recoverable; identical bytes yield equal sourceHash.
- [ ] **Step 2:** Run `node --import tsx --test test/helpers/transcriptStudioNormalize.test.js`; confirm failure.
- [ ] **Step 3:** Implement types and pure normalizer. Use existing `parseTranscriptSegments.ts`/`transcriptSpeakerState.ts` where safe; explicit fallback for malformed data instead of deleting text.
- [ ] **Step 4:** Rerun targeted tests and `npm run typecheck`; expect success.
- [ ] **Step 5:** Commit `feat(transcript): normalize immutable sources with stable IDs`.

### Task 2: Account-Scoped Overlay and Version Repository

**Files:** Create `persistence/repository.ts`; modify `src/helpers/database.js`, `src/types/electron.ts`, relevant main/preload IPC registration; test `test/helpers/transcriptStudioRepository.test.js`.

**Interfaces:** `getTranscriptWorkspace(noteId:number): Promise<TranscriptWorkspace|null>`; `applyTranscriptRevision(input:{noteId:number; expectedVersion:number; sourceHash:string; operations:EditOperation[]; description:string}): Promise<{version:number; workspace:TranscriptWorkspace}|{conflict:true}>`; `listTranscriptVersions(noteId:number): Promise<VersionMeta[]>`; `restoreTranscriptVersion(noteId:number, versionId:string, expectedVersion:number): Promise<TranscriptWorkspace>`.

- [ ] **Step 1:** Write failing disposable-SQLite tests: no overlay uses raw; approved edit leaves `notes.transcript` byte-identical; version increment atomic; concurrent stale expectedVersion rejected; account switch or deleted note rejected; sourceHash change marks stale; DB restart recovers revisions; migration idempotent.
- [ ] **Step 2:** Run targeted test; confirm failure.
- [ ] **Step 3:** Add small new SQLite tables: workspace metadata (note/account/client ID, sourceHash, currentVersion), approved revision payloads and version snapshots. Use transaction/optimistic version check and note/account authorization. Wire only typed, narrowly scoped IPC methods.
- [ ] **Step 4:** Run targeted tests, `npm run typecheck` and existing `test/helpers/noteRevisionRecovery.test.js`, `test/services/uploadTranscriptPersistence.test.js`.
- [ ] **Step 5:** Commit `feat(transcript): persist approved overlays and version history`.

### Task 3: Deterministic Text/Speaker Operations and History

**Files:** Create `domain/editOperations.ts`, `stores/transcriptStudioStore.ts`; test `test/helpers/transcriptStudioOperations.test.js`.

**Interfaces:** `EditOperation = {kind:'replaceText'; segmentId:string; before:string; after:string}|{kind:'setSpeaker'; segmentId:string; speakerId:string|null; speakerName:string|null}|{kind:'split'; segmentId:string; atOffset:number; newId:string}|{kind:'merge'; leftId:string; rightId:string}`; `applyEditOperations(workspace:TranscriptWorkspace,ops:EditOperation[]):TranscriptWorkspace`; `undo():void`, `redo():void` session commands. Existing speaker-lock policy takes precedence over AI proposals (manual override by user allowed).

- [ ] **Step 1:** Write failing tests: edit/split/merge and inverse; locked speaker rejects AI operation; duplicate/new ID rejected; transcript text order retained; merged timestamps remain honest (no synthetic end); one bulk accepted AI edit is one undo unit.
- [ ] **Step 2:** Verify red test.
- [ ] **Step 3:** Implement pure operation + inverse-command functions and in-session stack; give keyboard shortcuts to focused transcript editor without globally capturing shortcuts in other views.
- [ ] **Step 4:** Run tests and typecheck.
- [ ] **Step 5:** Commit `feat(transcript): implement speaker/text edit operations and undo`.

### Task 4: Native Speaker-Oriented Editable Transcript UI

**Files:** Create `components/TranscriptStudioView.tsx`, `components/TranscriptBlockEditor.tsx`; modify `src/components/notes/NoteEditor.tsx` with narrow integration; test `test/components/transcriptStudioView.test.js`.

**Interfaces:** `<TranscriptStudioView noteId={number} sourceTranscript={string} canEdit={boolean} onExport={...} />`; each block uses controlled text with speaker label, optional timestamp, select/merge/split actions and Undo/Redo. Return a read-only fallback when edit permission is false.

- [x] **Step 1:** Write failing component tests: raw shown when no overlay; approved text shown by default; rename speaker and edit selected text; stable focus during updates; never render invented timestamp; read-only notes cannot be edited.
- [x] **Step 2:** Run component test and verify failures.
- [x] **Step 3:** Integrate transcript-specialized Tiptap/ProseMirror editing in existing note tab; reuse existing speaker mapping/selection UI and `RichTextEditor` patterns. Ensure controlled updates do not inadvertently reset Ctrl+Z history; group programmatic accepted edits atomically.
- [x] **Step 4:** Run UI tests, typecheck, and existing `test/components/meetingTranscriptChat.test.js`.
- [x] **Step 5:** Commit `feat(transcript): provide editable speaker-oriented transcript tab`.

### Task 5: User-Triggered Progressive AI Edit Job

**Files:** Create `process/chunkPlanner.ts`, `process/transcriptEditJob.ts`, `domain/validateProposal.ts`; test `test/helpers/transcriptStudioChunking.test.js`, `test/helpers/transcriptStudioValidation.test.js`, `test/helpers/transcriptStudioJob.test.js`.

**Interfaces:** `planTranscriptChunks(segments:SourceSegment[], maxInputTokens:number): TranscriptChunk[]`; `startTranscriptEditJob(input:{noteId:number; sourceHash:string; providerChoice:string; strictMode:true; selectedIds?:string[]}): AsyncIterable<TranscriptEditEvent>` with `{type:'chunkProposed'|'progress'|'warning'|'failed'|'done'; ...}` event variants; `validateTranscriptProposal(source:TranscriptChunk, candidate:ProposedChunk): {safe:boolean; warnings:string[]; edits:EditOperation[]}`.

- [x] **Step 1:** Add failing tests: no invocation on upload; explicit click starts; one-hour text yields ordered chunks; missing/duplicated source blocks, altered numbers/names and truncated output get warnings/not automatic approval; cancellation leaves approved text untouched; late response after note/account change is discarded; error resumes from remaining chunk.
- [x] **Step 2:** Run tests and confirm failures.
- [x] **Step 3:** Use existing `ReasoningService` route (not `actionProcessingStore` summary reducer) to request conservative, meaning-preserving edits, per chunk; schedule sequentially by default with small context overlap, map proposed changes back to stable IDs, and persist pending drafts separately from accepted revisions.
- [x] **Step 4:** Run targeted tests; verify output budget fallback, back-pressure, offline/local provider, invalid provider and consent-gated remote provider.
- [x] **Step 5:** Commit `feat(transcript): add progressive validated edit proposals`.

### Task 6: Review, Bulk Accept/Reject and Speaker Suggestions

**Files:** Create `components/ProposalReview.tsx`; modify `components/TranscriptStudioView.tsx`; test `test/components/transcriptStudioReview.test.js`.

**Interfaces:** `acceptProposal(proposalId:string, expectedVersion:number):Promise<void>`; `rejectProposal(proposalId:string):void`; `acceptProposals(ids:string[], expectedVersion:number):Promise<void>`; AI speaker suggestions carry `uncertain:true` and can never auto-apply.

- [x] **Step 1:** Write failing tests: accept one and all; reject one and all; pending suggestions visible while next chunk runs; conflict after user manual edit blocks stale proposal and allows re-review; locked speaker suggestions require confirmation.
- [x] **Step 2:** Confirm red tests.
- [x] **Step 3:** Show per-change diff with type filters; separate speaker proposals from punctuation changes; map each accepted proposal to atomic edit-transaction with Undo/Redo support.
- [x] **Step 4:** Run targeted tests, typecheck and keyboard accessibility checks.
- [x] **Step 5:** Commit `feat(transcript): review individual and bulk AI corrections`.

### Task 7: Durable Version History and Restore

**Files:** Create `components/VersionHistory.tsx`; modify `persistence/repository.ts`; test `test/components/transcriptStudioHistory.test.js`.

**Interfaces:** `listTranscriptVersions(noteId)` shows baseline, important manual checkpoints, pre-AI and approved bulk revisions; `restoreTranscriptVersion` creates a **new** revision and leaves all old snapshots intact.

- [x] **Step 1:** Write failing tests: close/reopen retains history; compare versions; restore old version creates new history entry; undo/redo resets only for new session; no cross-note history leakage.
- [x] **Step 2:** Run tests and observe failure.
- [x] **Step 3:** Build history view and diff/restore confirmation; ensure version snapshots are compressed/deduplicated or otherwise bounded for multi-hour transcripts; create checkpoint policy not per-keystroke snapshots.
- [x] **Step 4:** Run targeted tests plus temporary-SQLite reopening test.
- [x] **Step 5:** Commit `feat(transcript): add durable version history and restore`.

### Task 8: Explicit Original/Approved Resolver, Export and Regression

**Files:** Create `src/custom-features/transcript-studio/domain/transcriptResolver.ts`; modify relevant export and summary/agent consumers only through explicit opt-in; tests `test/services/transcriptStudioResolver.test.js`, `test/helpers/transcriptFormatter.test.js`, `test/stores/actionProcessingNoteOutput.test.js`.

**Interfaces:** `resolveTranscriptForUse(noteId:number, purpose:'display'|'export'|'summary'|'mcp', version:'original'|'approved'):Promise<{text:string;segments:SourceSegment[];sourceHash:string}>` with explicit current permission check. For export, user selects original or approved. If no approved revision, resolve original. SRT available only for meaningful timestamps; no fabrication.

- [x] **Step 1:** Write failing tests for approved transcript default display, original export byte fidelity, summary input selection, JSON/MD/TXT/SRT formats and invalid timing; unchanged notes behave as before.
- [x] **Step 2:** Verify red tests.
- [x] **Step 3:** Implement one resolver; adapt existing `transcriptFormatter.js` and relevant UI action calls. Do not change cloud sync/update payloads by default or mutate the raw data; show stale-overlay warning if sourceHash mismatches.
- [x] **Step 4:** Run targeted plus existing tests for note export and transcriptions; `npm run lint`, `npm run typecheck`, `npm run i18n:check`, `npm run build:renderer`, `npm test`.
- [x] **Step 5:** Commit `feat(transcript): export approved or original revisions safely`.

### Task 9: Long-Form, Privacy, Accessibility and Recovery Acceptance

**Files:** Test `test/helpers/transcriptStudioAcceptance.test.js`; modify narrow files from Tasks 1–8 if test evidence identifies defects; create `docs/custom/transcript-studio-qa.md`.

**Interfaces:** acceptance fixtures: plain transcript 1h, multi-speaker timed segments, unsorted/missing timestamps, Turkish diacritics, named entities and decimals, speaker locks, app restart and permission changes.

- [ ] **Step 1:** Write failing fixtures for 1h/2h content stability, cancellation, process crash, multiple windows, user switching, corrupt overlay fallback, and no remote text transfer without consent.
- [ ] **Step 2:** Run targeted tests and document actual failures.
- [ ] **Step 3:** Apply only evidence-backed repairs; write QA instructions for manual keyboard, screen reader, focus, macOS/Windows smoke tests and data migration.
- [ ] **Step 4:** Run full suite/quality checks; verify on disposable profile, not the user's live data.
- [ ] **Step 5:** Commit `test(transcript): enforce end-to-end editing integrity`.

## Deliverable / Gate

One native Transcript tab that loads raw or last approved edited version, supports direct manual and AI edits with progressive review, session Undo/Redo and durable history, and never destroys original data. No subscription or MCP prerequisite: use the existing local/authorized model provider. Stop and request design revision if source revision, multi-user sync or actual audio alignment proves materially more complex than expected.
