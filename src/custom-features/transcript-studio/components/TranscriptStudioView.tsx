import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import {
  applyEditOperations,
  type EditOperation,
  type TranscriptEditWorkspace,
} from "../domain/editOperations";
import { normalizeTranscriptSource } from "../domain/normalizeSource";
import type { SourceSegment } from "../domain/types";
import { transcriptStudioRepository } from "../persistence/repository";
import {
  createTranscriptStudioStore,
  type TranscriptStudioSessionState,
} from "../stores/transcriptStudioStore";
import { TranscriptBlockEditor } from "./TranscriptBlockEditor";
import type {
  TranscriptStudioVersionMeta,
  TranscriptStudioWorkspace,
} from "../../../types/electron";
import { startTranscriptEditJob, type TranscriptEditEvent } from "../process/transcriptEditJob";
import { getSettings } from "../../../stores/settingsStore";
import { usePolicyStore } from "../../../stores/policyStore";
import { ProposalReview, type PendingTranscriptProposal } from "./ProposalReview";
import { VersionHistory } from "./VersionHistory";

interface TranscriptStudioViewProps {
  noteId: number;
  sourceTranscript: string;
  canEdit: boolean;
  selectedSegmentIds?: Set<string>;
  onToggleSelect?: (segmentId: string) => void;
  speakerMappings?: Record<string, string>;
  recorderLabel?: string;
  onMapSpeaker?: (
    speakerId: string,
    displayName: string,
    email?: string | null,
    profileId?: number | null,
    recorderName?: string,
    profileName?: string,
    persistSource?: boolean
  ) => string | void | Promise<string | void>;
  onConfirmSuggestion?: (
    speakerId: string,
    suggestedName: string,
    profileId: number,
    recorderName?: string,
    persistSource?: boolean
  ) => string | void | Promise<string | void>;
  onDismissSuggestion?: (speakerId: string, persistSource?: boolean) => void | Promise<void>;
  /** Optional job runner seam for deterministic UI tests. */
  jobRunner?: typeof startTranscriptEditJob;
}

const EMPTY_WORKSPACE: TranscriptEditWorkspace = { sourceHash: "", kind: "plain", segments: [] };
const EMPTY_SELECTED_SEGMENTS = new Set<string>();
const EMPTY_SPEAKER_MAPPINGS: Record<string, string> = {};
const ignoreToggle = () => {};
const operationSnapshot = (workspace: TranscriptEditWorkspace) => JSON.stringify(workspace);
const workspaceText = (workspace: TranscriptEditWorkspace) =>
  workspace.segments.map((segment) => segment.text).join("\n");
const proposalDraftKey = (accountKey: string, noteId: number, sourceHash: string) =>
  `transcript-studio-proposals:${accountKey}:${noteId}:${sourceHash}`;

function revisionIsStale(workspace: TranscriptStudioWorkspace, sourceHash: string): boolean {
  return (
    workspace.stale ||
    workspace.sourceHash !== sourceHash ||
    workspace.baselineSourceHash !== sourceHash
  );
}

function segmentFor(
  store: ReturnType<typeof createTranscriptStudioStore>,
  id: string
): SourceSegment | undefined {
  return store.getState().workspace.segments.find((segment) => segment.id === id);
}

function mergePreservesSpeaker(left: SourceSegment, right: SourceSegment): boolean {
  const matches = left.speakerId === right.speakerId && left.speakerName === right.speakerName;
  const hasIdentity =
    left.speakerId !== null ||
    left.speakerName !== null ||
    right.speakerId !== null ||
    right.speakerName !== null;
  return matches || (!hasIdentity && !left.speakerLocked && !right.speakerLocked);
}

export function TranscriptStudioView({
  noteId,
  sourceTranscript,
  canEdit,
  selectedSegmentIds = EMPTY_SELECTED_SEGMENTS,
  onToggleSelect = ignoreToggle,
  speakerMappings = EMPTY_SPEAKER_MAPPINGS,
  recorderLabel = "Speaker",
  onMapSpeaker,
  onConfirmSuggestion,
  onDismissSuggestion,
  jobRunner,
}: TranscriptStudioViewProps) {
  const sessionRef = useRef<ReturnType<typeof createTranscriptStudioStore> | null>(null);
  if (!sessionRef.current) sessionRef.current = createTranscriptStudioStore(EMPTY_WORKSPACE);
  const session = sessionRef.current;
  const workspace = useStore(session, (state: TranscriptStudioSessionState) => state.workspace);
  const metadataRef = useRef({ sourceHash: "", currentVersion: 0, versionId: "" });
  const versionForSnapshotRef = useRef(new Map<string, string>());
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [loading, setLoading] = useState(true);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState("");
  const [jobMessage, setJobMessage] = useState("");
  const [jobProgress, setJobProgress] = useState("");
  const [proposals, setProposals] = useState<PendingTranscriptProposal[]>([]);
  const [currentVersion, setCurrentVersion] = useState(0);
  const [versions, setVersions] = useState<TranscriptStudioVersionMeta[]>([]);
  const [compareVersionId, setCompareVersionId] = useState("");
  const [compareText, setCompareText] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [jobRunning, setJobRunning] = useState(false);
  const [resumeFromChunk, setResumeFromChunk] = useState(0);
  const jobControllerRef = useRef<AbortController | null>(null);
  const accountKey = usePolicyStore(
    (state) => `${state.accountId ?? "anonymous"}:${state.authGeneration ?? "none"}`
  );
  const proposalContextRef = useRef({
    accountKey,
    noteId,
    sourceTranscript,
    sourceHash: "",
    storageKey: "",
  });
  proposalContextRef.current = {
    accountKey,
    noteId,
    sourceTranscript,
    sourceHash: metadataRef.current.sourceHash,
    storageKey: proposalDraftKey(accountKey, noteId, metadataRef.current.sourceHash),
  };

  useEffect(() => () => jobControllerRef.current?.abort(), [accountKey, noteId, sourceTranscript]);
  useEffect(() => {
    const key = proposalContextRef.current.storageKey;
    try {
      const saved = window.sessionStorage?.getItem(key);
      setProposals(saved ? JSON.parse(saved) : []);
    } catch {
      setProposals([]);
    }
  }, [accountKey, noteId, metadataRef.current.sourceHash]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void (async () => {
      const source = await normalizeTranscriptSource(sourceTranscript);
      const saved = await transcriptStudioRepository.getTranscriptWorkspace(noteId);
      const savedVersions = await transcriptStudioRepository.listTranscriptVersions(noteId);
      if (!active) return;
      const isStale = revisionIsStale(saved, source.sourceHash);
      let initial = source;
      if (!isStale && saved.approvedOperations.length > 0) {
        try {
          initial = applyEditOperations(source, saved.approvedOperations as EditOperation[], {
            actor: "user",
          });
        } catch {
          setError("Saved transcript edits could not be applied; showing the original transcript.");
        }
      }
      session.getState().reset(initial);
      metadataRef.current = {
        sourceHash: source.sourceHash,
        currentVersion: isStale ? 0 : saved.currentVersion,
        versionId: isStale
          ? (savedVersions[0]?.versionId ?? "")
          : (saved.versionId ??
            savedVersions.find((version) => version.version === saved.currentVersion)?.versionId ??
            ""),
      };
      setCurrentVersion(metadataRef.current.currentVersion);
      setVersions(savedVersions);
      setCompareVersionId(savedVersions[0]?.versionId ?? "");
      setCompareText(workspaceText(source));
      versionForSnapshotRef.current = new Map([
        [operationSnapshot(initial), metadataRef.current.versionId],
      ]);
      setStale(isStale);
      setLoading(false);
    })().catch(() => {
      if (!active) return;
      session.getState().reset(awaitablePlainSource(sourceTranscript));
      setError("Transcript could not be loaded. The original text is shown read-only.");
      setStale(true);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [noteId, sourceTranscript, session]);

  const persist = useCallback(
    (
      operation: EditOperation | EditOperation[],
      resultingWorkspace: TranscriptEditWorkspace,
      description: string
    ) => {
      const save = saveQueueRef.current.then(async () => {
        const currentMetadata = metadataRef.current;
        const result = await transcriptStudioRepository.applyTranscriptRevision({
          noteId,
          expectedVersion: currentMetadata.currentVersion,
          sourceHash: currentMetadata.sourceHash,
          operations: Array.isArray(operation) ? operation : [operation],
          description,
        });
        if ("conflict" in result) {
          throw new Error(
            "Transcript changed in another window. Reload the transcript before editing."
          );
        }
        metadataRef.current = {
          sourceHash: result.workspace.sourceHash,
          currentVersion: result.version,
          versionId: result.workspace.versionId ?? "",
        };
        setCurrentVersion(result.version);
        window.dispatchEvent(new Event("transcript-studio:revision-updated"));
        setVersions(await transcriptStudioRepository.listTranscriptVersions(noteId));
        versionForSnapshotRef.current.set(
          operationSnapshot(resultingWorkspace),
          result.workspace.versionId ?? ""
        );
      });
      saveQueueRef.current = save;
      void save.catch((saveError: unknown) => {
        setError(
          saveError instanceof Error ? saveError.message : "Transcript edit could not be saved."
        );
      });
      return save;
    },
    [noteId]
  );

  const commitOperation = useCallback(
    async (operation: EditOperation, description: string) => {
      if (!canEdit || stale || error) return;
      try {
        session.getState().apply([operation], { actor: "user" });
        const nextWorkspace = session.getState().workspace;
        await persist(operation, nextWorkspace, description);
        setError("");
      } catch (commitError) {
        setError(
          commitError instanceof Error ? commitError.message : "Transcript edit could not be saved."
        );
      }
    },
    [canEdit, error, persist, session, stale]
  );

  const commitText = useCallback(
    async (segmentId: string, nextText: string) => {
      const segment = segmentFor(session, segmentId);
      if (!segment || segment.text === nextText) return;
      await commitOperation(
        { kind: "replaceText", segmentId, before: segment.text, after: nextText },
        "Edited transcript text"
      );
    },
    [commitOperation, session]
  );

  const commitSpeaker = useCallback(
    async (segmentId: string, nextName: string) => {
      const segment = segmentFor(session, segmentId);
      if (!segment || !canEdit || stale || error) return;
      let speakerName = nextName || null;
      if (segment.speakerId && speakerName) {
        const mappedName = await onMapSpeaker?.(
          segment.speakerId,
          speakerName,
          null,
          undefined,
          segment.recorderName ?? undefined,
          speakerName,
          false
        );
        if (typeof mappedName === "string") speakerName = mappedName;
      }
      if (segment.speakerName === speakerName) return;
      await commitOperation(
        {
          kind: "setSpeaker",
          segmentId,
          speakerId: segment.speakerId,
          speakerName,
          speakerLocked: true,
        },
        "Renamed transcript speaker"
      );
    },
    [canEdit, commitOperation, error, onMapSpeaker, session, stale]
  );

  const reassignSpeaker = useCallback(
    async (segmentId: string, speakerId: string | null, speakerName: string | null) => {
      const segment = segmentFor(session, segmentId);
      if (!canEdit || stale || error) return;
      if (!segment || (segment.speakerId === speakerId && segment.speakerName === speakerName)) {
        return;
      }
      let resolvedName = speakerName;
      if (speakerId && speakerName) {
        const mappedName = await onMapSpeaker?.(
          speakerId,
          speakerName,
          null,
          undefined,
          segment.recorderName ?? undefined,
          speakerName,
          false
        );
        if (typeof mappedName === "string") resolvedName = mappedName;
      }
      await commitOperation(
        {
          kind: "setSpeaker",
          segmentId,
          speakerId,
          speakerName: resolvedName,
          speakerLocked: true,
        },
        "Reassigned transcript speaker"
      );
    },
    [canEdit, commitOperation, error, onMapSpeaker, session, stale]
  );

  const confirmSuggestion = useCallback(
    async (segmentId: string) => {
      const segment = segmentFor(session, segmentId);
      if (!segment?.suggestedName || !canEdit || stale || error) return;
      let speakerName =
        segment.suggestedName.toLocaleLowerCase() === "you"
          ? segment.recorderName || recorderLabel
          : segment.suggestedName;
      if (segment.speakerId && segment.suggestedProfileId != null) {
        const resolvedName = await onConfirmSuggestion?.(
          segment.speakerId,
          segment.suggestedName,
          segment.suggestedProfileId,
          segment.recorderName ?? undefined,
          false
        );
        if (typeof resolvedName === "string" && resolvedName.trim()) speakerName = resolvedName;
      }
      await commitOperation(
        {
          kind: "setSpeaker",
          segmentId,
          speakerId: segment.speakerId,
          speakerName,
          speakerLocked: true,
          suggestedName: null,
          suggestedProfileId: null,
        },
        "Confirmed speaker suggestion"
      );
    },
    [canEdit, commitOperation, error, onConfirmSuggestion, recorderLabel, session, stale]
  );

  const dismissSuggestion = useCallback(
    async (segmentId: string) => {
      const segment = segmentFor(session, segmentId);
      if (!segment?.suggestedName || !canEdit || stale || error) return;
      await commitOperation(
        {
          kind: "setSpeaker",
          segmentId,
          speakerId: segment.speakerId,
          speakerName: segment.speakerName,
          suggestedName: null,
          suggestedProfileId: null,
        },
        "Dismissed speaker suggestion"
      );
      if (segment.speakerId) await onDismissSuggestion?.(segment.speakerId, false);
    },
    [canEdit, commitOperation, error, onDismissSuggestion, session, stale]
  );

  const splitAt = useCallback(
    async (segmentId: string, atOffset: number, text: string) => {
      await commitText(segmentId, text);
      const segment = segmentFor(session, segmentId);
      if (!segment) return;
      const newId = globalThis.crypto?.randomUUID?.() ?? `${segment.id}-split-${Date.now()}`;
      await commitOperation(
        { kind: "split", segmentId, atOffset, newId },
        "Split transcript segment"
      );
    },
    [commitOperation, commitText, session]
  );

  const mergeNext = useCallback(
    async (segmentId: string) => {
      const segments = session.getState().workspace.segments;
      const index = segments.findIndex((segment) => segment.id === segmentId);
      const next = segments[index + 1];
      if (!next) return;
      await commitOperation(
        { kind: "merge", leftId: segmentId, rightId: next.id },
        "Merged transcript segments"
      );
    },
    [commitOperation, session]
  );

  const restoreSessionState = useCallback(
    (direction: "undo" | "redo") => {
      const restore = saveQueueRef.current.then(async () => {
        if (!canEdit || stale || error) return;
        const state = session.getState();
        const command = direction === "undo" ? state.undoStack.at(-1) : state.redoStack.at(-1);
        if (!command) return;
        const targetWorkspace = direction === "undo" ? command.before : command.after;
        const targetVersionId = versionForSnapshotRef.current.get(
          operationSnapshot(targetWorkspace)
        );
        if (!targetVersionId) {
          setError("This edit cannot be restored in the current transcript session.");
          return;
        }
        if (direction === "undo") state.undo();
        else state.redo();
        try {
          const restored = await transcriptStudioRepository.restoreTranscriptVersion(
            noteId,
            targetVersionId,
            metadataRef.current.currentVersion
          );
          metadataRef.current = {
            sourceHash: restored.sourceHash,
            currentVersion: restored.currentVersion,
            versionId: restored.versionId ?? "",
          };
          setCurrentVersion(restored.currentVersion);
          window.dispatchEvent(new Event("transcript-studio:revision-updated"));
          setVersions(await transcriptStudioRepository.listTranscriptVersions(noteId));
          versionForSnapshotRef.current.set(
            operationSnapshot(targetWorkspace),
            restored.versionId ?? ""
          );
          setError("");
        } catch (restoreError) {
          if (direction === "undo") session.getState().redo();
          else session.getState().undo();
          setError(
            restoreError instanceof Error
              ? restoreError.message
              : "Transcript version could not be restored."
          );
        }
      });
      saveQueueRef.current = restore;
      void restore.catch((restoreError: unknown) => {
        setError(
          restoreError instanceof Error
            ? restoreError.message
            : "A pending transcript save failed; history was not restored."
        );
      });
      return restore;
    },
    [canEdit, error, noteId, session, stale]
  );

  const selectComparison = useCallback(
    async (versionId: string) => {
      setCompareVersionId(versionId);
      try {
        const snapshot = await transcriptStudioRepository.getTranscriptVersion(noteId, versionId);
        if (snapshot.sourceHash !== metadataRef.current.sourceHash) {
          setCompareText("");
          setError(
            "This version belongs to a different source transcript; comparison is unavailable."
          );
          return;
        }
        const source = await normalizeTranscriptSource(sourceTranscript);
        const compared = applyEditOperations(source, snapshot.operations as EditOperation[], {
          actor: "user",
        });
        setCompareText(workspaceText(compared));
        setError("");
      } catch (compareError) {
        setError(
          compareError instanceof Error ? compareError.message : "Version could not be loaded."
        );
      }
    },
    [noteId, sourceTranscript]
  );

  const restoreSelectedVersion = useCallback(async () => {
    if (
      !compareVersionId ||
      stale ||
      !canEdit ||
      !window.confirm(
        "Restore this transcript version? This creates a new version and keeps existing history."
      )
    )
      return;
    const restore = saveQueueRef.current.then(async () => {
      try {
        const restored = await transcriptStudioRepository.restoreTranscriptVersion(
          noteId,
          compareVersionId,
          metadataRef.current.currentVersion
        );
        const source = await normalizeTranscriptSource(restored.sourceTranscript);
        const restoredWorkspace = applyEditOperations(
          source,
          restored.approvedOperations as EditOperation[],
          { actor: "user" }
        );
        session.getState().reset(restoredWorkspace);
        metadataRef.current = {
          sourceHash: restored.sourceHash,
          currentVersion: restored.currentVersion,
          versionId: restored.versionId ?? "",
        };
        setCurrentVersion(restored.currentVersion);
        window.dispatchEvent(new Event("transcript-studio:revision-updated"));
        setVersions(await transcriptStudioRepository.listTranscriptVersions(noteId));
        versionForSnapshotRef.current = new Map([
          [operationSnapshot(restoredWorkspace), restored.versionId ?? ""],
        ]);
        setCompareVersionId(restored.versionId ?? compareVersionId);
        setCompareText(workspaceText(restoredWorkspace));
        setError("");
      } catch (restoreError) {
        setError(
          restoreError instanceof Error
            ? restoreError.message
            : "Transcript version could not be restored."
        );
      }
    });
    saveQueueRef.current = restore;
    await restore;
  }, [canEdit, compareVersionId, noteId, session, stale]);

  const startAiEdit = useCallback(async () => {
    if (!canEdit || stale || loading || jobRunning) return;
    const controller = new AbortController();
    jobControllerRef.current?.abort();
    jobControllerRef.current = controller;
    setJobRunning(true);
    setJobMessage("");
    const jobContext = { ...proposalContextRef.current };
    const isJobContextCurrent = () => {
      const current = proposalContextRef.current;
      const policy = usePolicyStore.getState();
      const liveAccountKey = `${policy.accountId ?? "anonymous"}:${policy.authGeneration ?? "none"}`;
      return (
        liveAccountKey === jobContext.accountKey &&
        current.accountKey === jobContext.accountKey &&
        current.noteId === jobContext.noteId &&
        current.sourceTranscript === jobContext.sourceTranscript &&
        current.sourceHash === jobContext.sourceHash &&
        current.storageKey === jobContext.storageKey
      );
    };
    const removeJobDraft = () => {
      try {
        window.sessionStorage?.removeItem(jobContext.storageKey);
      } catch {
        /* ignore unavailable storage */
      }
    };
    const settings = getSettings();
    try {
      const saved = window.sessionStorage?.getItem(jobContext.storageKey);
      if (saved) setProposals(JSON.parse(saved));
    } catch {
      setProposals([]);
    }
    const providerChoice =
      settings.cleanupMode === "providers"
        ? settings.cleanupProvider
        : settings.cleanupMode === "enterprise"
          ? "enterprise"
          : settings.cleanupMode === "self-hosted"
            ? "self-hosted"
            : settings.cleanupMode;
    try {
      const runJob = jobRunner ?? startTranscriptEditJob;
      for await (const event of runJob({
        noteId,
        sourceHash: jobContext.sourceHash,
        providerChoice,
        strictMode: true,
        selectedIds: selectedSegmentIds.size ? [...selectedSegmentIds] : undefined,
        signal: controller.signal,
        resumeFromChunk,
      })) {
        if (!isJobContextCurrent()) {
          removeJobDraft();
          break;
        }
        if (event.type === "chunkProposed") {
          setProposals((previous) => {
            if (!isJobContextCurrent()) {
              removeJobDraft();
              return previous;
            }
            const next = [
              ...previous.filter((item) => item.chunk.id !== event.chunk.id),
              {
                ...event,
                baseVersion: metadataRef.current.currentVersion,
                ...(event.validation.edits.some((edit) => edit.kind === "setSpeaker")
                  ? { uncertain: true as const }
                  : {}),
              },
            ];
            try {
              window.sessionStorage?.setItem(jobContext.storageKey, JSON.stringify(next));
            } catch {
              /* proposals remain in this session */
            }
            return next;
          });
        } else if (event.type === "progress") {
          setResumeFromChunk(event.chunkIndex + 1);
          setJobProgress(`Processed ${event.completed} of ${event.total} transcript chunks.`);
        } else if (event.type === "warning") {
          setJobMessage(event.message);
          if (/account, note, or source changed/i.test(event.message)) {
            removeJobDraft();
            if (isJobContextCurrent()) setProposals([]);
          }
        } else if (event.type === "failed") {
          setResumeFromChunk(event.resumeFromChunk);
          setJobMessage(`${event.message} You can resume from this chunk.`);
        } else if (event.type === "done") {
          setJobRunning(false);
          if (event.cancelled) setJobProgress("Transcript edit job cancelled.");
        }
      }
    } catch (jobError) {
      setJobMessage(jobError instanceof Error ? jobError.message : "Transcript edit job failed.");
    } finally {
      if (jobControllerRef.current === controller) {
        setJobRunning(false);
        jobControllerRef.current = null;
      }
    }
  }, [canEdit, jobRunning, jobRunner, loading, noteId, resumeFromChunk, selectedSegmentIds, stale]);

  const acceptProposals = useCallback(
    async (ids: string[], operations: EditOperation[]) => {
      if (
        !canEdit ||
        stale ||
        error ||
        proposals.some(
          (proposal) =>
            ids.includes(proposal.chunk.id) &&
            proposal.baseVersion !== metadataRef.current.currentVersion
        )
      )
        return;
      let applied = false;
      try {
        session.getState().apply(operations, { actor: "user" });
        applied = true;
        await persist(
          operations,
          session.getState().workspace,
          ids.length > 1 ? "Accepted AI transcript proposals" : "Accepted AI transcript proposal"
        );
        setProposals((previous) => {
          const next = previous.filter((proposal) => !ids.includes(proposal.chunk.id));
          try {
            window.sessionStorage?.setItem(
              proposalContextRef.current.storageKey,
              JSON.stringify(next)
            );
          } catch {
            /* session-only */
          }
          return next;
        });
        setError("");
      } catch (acceptError) {
        if (applied) session.getState().undo();
        setError(
          acceptError instanceof Error ? acceptError.message : "AI proposal could not be accepted."
        );
      }
    },
    [canEdit, error, persist, proposals, session, stale]
  );

  const rejectProposals = useCallback((ids: string[]) => {
    setProposals((previous) => {
      const next = previous.filter((proposal) => !ids.includes(proposal.chunk.id));
      try {
        window.sessionStorage?.setItem(proposalContextRef.current.storageKey, JSON.stringify(next));
      } catch {
        /* session-only */
      }
      return next;
    });
  }, []);

  const rereviewProposal = useCallback((id: string, edits: EditOperation[]) => {
    setProposals((previous) => {
      const next = previous.map((proposal) =>
        proposal.chunk.id === id
          ? {
              ...proposal,
              baseVersion: metadataRef.current.currentVersion,
              validation: { ...proposal.validation, edits },
            }
          : proposal
      );
      try {
        window.sessionStorage?.setItem(proposalContextRef.current.storageKey, JSON.stringify(next));
      } catch {
        /* session-only */
      }
      return next;
    });
  }, []);

  if (loading)
    return <div className="px-4 py-6 text-sm text-muted-foreground">Loading transcript…</div>;
  const sessionState = session.getState();
  const speakers = Array.from(
    new Map(
      workspace.segments
        .filter((segment) => segment.speakerId)
        .map((segment) => [
          segment.speakerId!,
          {
            id: segment.speakerId!,
            name: speakerMappings[segment.speakerId!] || segment.speakerName || segment.speakerId!,
          },
        ])
    ).values()
  );

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-4" aria-label="Transcript Studio">
      {stale && (
        <p
          role="alert"
          className="mb-3 rounded border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
        >
          The source transcript changed. Showing the original text until you review the stale edits.
        </p>
      )}
      {!!error && (
        <p role="alert" className="mb-3 rounded border border-destructive/40 p-3 text-sm">
          {error}
        </p>
      )}
      <div className="mb-3 flex gap-2">
        <button
          type="button"
          aria-expanded={historyOpen}
          onClick={() => {
            const opening = !historyOpen;
            setHistoryOpen(opening);
            if (opening && compareVersionId) void selectComparison(compareVersionId);
          }}
        >
          {historyOpen ? "Hide version history" : "Version history"} · v{currentVersion}
        </button>
        <button
          type="button"
          disabled={!canEdit || stale || sessionState.undoStack.length === 0}
          onClick={() => void restoreSessionState("undo")}
        >
          Undo
        </button>
        <button
          type="button"
          disabled={!canEdit || stale || sessionState.redoStack.length === 0}
          onClick={() => void restoreSessionState("redo")}
        >
          Redo
        </button>
        <button
          type="button"
          disabled={!canEdit || stale || jobRunning}
          onClick={() => void startAiEdit()}
        >
          {resumeFromChunk > 0 ? "Resume AI edit" : "Edit transcript with AI"}
        </button>
        {jobRunning && (
          <button type="button" onClick={() => jobControllerRef.current?.abort()}>
            Cancel AI edit
          </button>
        )}
      </div>
      {historyOpen && (
        <VersionHistory
          versions={versions}
          selectedVersionId={compareVersionId}
          currentText={workspaceText(workspace)}
          comparedText={compareText}
          canRestore={canEdit && !stale && !error && !!compareVersionId && !jobRunning}
          onSelect={(versionId) => void selectComparison(versionId)}
          onRestore={() => void restoreSelectedVersion()}
        />
      )}
      {!!jobMessage && (
        <p role="alert" className="mb-3 text-sm">
          {jobMessage}
        </p>
      )}
      {!!jobProgress && (
        <p role="status" className="mb-3 text-sm">
          {jobProgress}
        </p>
      )}
      {proposals.length > 0 && (
        <ProposalReview
          proposals={proposals}
          workspace={workspace}
          currentVersion={currentVersion}
          canEdit={canEdit && !stale && !error}
          onAccept={acceptProposals}
          onReject={rejectProposals}
          onRereview={rereviewProposal}
        />
      )}
      {workspace.segments.map((segment, index) => (
        <TranscriptBlockEditor
          key={segment.id}
          segment={segment}
          speakers={speakers}
          speakerDisplayName={
            (segment.speakerId && speakerMappings[segment.speakerId]) || segment.speakerName || ""
          }
          selected={selectedSegmentIds.has(segment.id)}
          canEdit={canEdit && !stale && !error}
          onToggleSelect={onToggleSelect}
          onTextCommit={commitText}
          onSpeakerCommit={commitSpeaker}
          onSpeakerReassign={reassignSpeaker}
          onConfirmSuggestion={confirmSuggestion}
          onDismissSuggestion={dismissSuggestion}
          onSplit={splitAt}
          onUndo={() => restoreSessionState("undo")}
          onRedo={() => restoreSessionState("redo")}
          onMergeNext={
            index < workspace.segments.length - 1 &&
            mergePreservesSpeaker(segment, workspace.segments[index + 1])
              ? mergeNext
              : undefined
          }
        />
      ))}
    </div>
  );
}

function awaitablePlainSource(raw: string): TranscriptEditWorkspace {
  return {
    sourceHash: "unavailable",
    kind: "plain",
    segments: [
      {
        id: "unavailable-source",
        text: raw,
        speakerId: null,
        speakerName: null,
        startSeconds: null,
        endSeconds: null,
        speakerLocked: false,
        sourceIndex: 0,
      },
    ],
  };
}
