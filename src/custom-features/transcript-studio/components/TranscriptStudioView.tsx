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
type TranscriptSaveContext = {
  accountKey: string;
  accountId: string;
  noteId: number;
  sourceTranscript: string;
  sourceHash: string;
  baseVersion: number;
  recoveryKey: string;
};
type PendingTranscriptWrite = TranscriptSaveContext & {
  operation: EditOperation;
  description: string;
};
const operationSnapshot = (workspace: TranscriptEditWorkspace) => JSON.stringify(workspace);
const workspaceText = (workspace: TranscriptEditWorkspace) =>
  workspace.segments.map((segment) => segment.text).join("\n");
const proposalDraftKey = (accountKey: string, noteId: number, sourceHash: string) =>
  `transcript-studio-proposals:${accountKey}:${noteId}:${sourceHash}`;
const readLocalRecovery = (key: string): string | null => {
  return window.localStorage?.getItem(key) ?? null;
};
const writeLocalRecovery = (key: string, value: string) => {
  try {
    window.localStorage?.setItem(key, value);
    return true;
  } catch {
    return false;
  }
};
const removeLocalRecovery = (key: string) => {
  try {
    window.localStorage?.removeItem(key);
  } catch {
    // Keep the save outcome independent of optional recovery cleanup.
  }
};

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

function isRecoveryWorkspace(value: unknown, sourceHash: string): value is TranscriptEditWorkspace {
  if (!value || typeof value !== "object") return false;
  const workspace = value as Partial<TranscriptEditWorkspace>;
  if (
    workspace.sourceHash !== sourceHash ||
    (workspace.kind !== "plain" && workspace.kind !== "segments") ||
    !Array.isArray(workspace.segments)
  )
    return false;
  return workspace.segments.every((segment) => {
    if (!segment || typeof segment !== "object") return false;
    const row = segment as Partial<SourceSegment>;
    return (
      typeof row.id === "string" &&
      typeof row.text === "string" &&
      (row.speakerId === null || typeof row.speakerId === "string") &&
      (row.speakerName === null || typeof row.speakerName === "string") &&
      (row.startSeconds === null || typeof row.startSeconds === "number") &&
      (row.endSeconds === null || typeof row.endSeconds === "number") &&
      typeof row.speakerLocked === "boolean" &&
      typeof row.sourceIndex === "number"
    );
  });
}

function isRecoveryOperation(value: unknown): value is EditOperation {
  if (!value || typeof value !== "object") return false;
  const operation = value as Record<string, unknown>;
  switch (operation.kind) {
    case "replaceText":
      return (
        typeof operation.segmentId === "string" &&
        typeof operation.before === "string" &&
        typeof operation.after === "string"
      );
    case "setSpeaker":
      return (
        typeof operation.segmentId === "string" &&
        (operation.speakerId === null || typeof operation.speakerId === "string") &&
        (operation.speakerName === null || typeof operation.speakerName === "string")
      );
    case "split":
      return (
        typeof operation.segmentId === "string" &&
        typeof operation.atOffset === "number" &&
        typeof operation.newId === "string"
      );
    case "merge":
      return typeof operation.leftId === "string" && typeof operation.rightId === "string";
    default:
      return false;
  }
}

function isRecoveryDraft(
  value: unknown,
  sourceHash: string
): value is {
  sourceHash: string;
  baseVersion: number;
  operation: EditOperation;
  description: string;
  workspace: TranscriptEditWorkspace;
} {
  if (!value || typeof value !== "object") return false;
  const draft = value as Record<string, unknown>;
  return (
    draft.sourceHash === sourceHash &&
    Number.isInteger(draft.baseVersion) &&
    typeof draft.description === "string" &&
    isRecoveryOperation(draft.operation) &&
    isRecoveryWorkspace(draft.workspace, sourceHash)
  );
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
  const failedOperationRef = useRef<PendingTranscriptWrite | null>(null);
  const inFlightSaveRef = useRef<TranscriptSaveContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
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
  const recoveryAccountId = usePolicyStore((state) => state.accountId ?? "anonymous");
  const recoveryKey = `transcript-studio-recovery:${recoveryAccountId}:${noteId}:${metadataRef.current.sourceHash}`;
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

  const captureSaveContext = () => ({
    accountKey,
    accountId: recoveryAccountId,
    noteId,
    sourceTranscript,
    sourceHash: metadataRef.current.sourceHash,
    baseVersion: metadataRef.current.currentVersion,
    recoveryKey,
  });
  const saveContextIdentityIsCurrent = (context: TranscriptSaveContext) => {
    const policy = usePolicyStore.getState();
    const liveAccountKey = `${policy.accountId ?? "anonymous"}:${policy.authGeneration ?? "none"}`;
    const active = proposalContextRef.current;
    return (
      liveAccountKey === context.accountKey &&
      (policy.accountId ?? "anonymous") === context.accountId &&
      active.noteId === context.noteId &&
      active.sourceTranscript === context.sourceTranscript &&
      metadataRef.current.sourceHash === context.sourceHash
    );
  };
  const saveContextIsCurrent = (context: TranscriptSaveContext) =>
    saveContextIdentityIsCurrent(context) &&
    metadataRef.current.currentVersion === context.baseVersion;
  const beginSaveLock = (context: TranscriptSaveContext) => {
    const inFlight = inFlightSaveRef.current;
    if (inFlight && saveContextIdentityIsCurrent(inFlight)) return false;
    inFlightSaveRef.current = context;
    setSaving(true);
    return true;
  };
  const releaseSaveLock = (context: TranscriptSaveContext) => {
    if (inFlightSaveRef.current !== context) return;
    inFlightSaveRef.current = null;
    setSaving(false);
  };

  useEffect(() => {
    const inFlight = inFlightSaveRef.current;
    if (inFlight && !saveContextIdentityIsCurrent(inFlight)) {
      inFlightSaveRef.current = null;
      setSaving(false);
    }
  }, [accountKey, noteId, sourceTranscript]);

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
      const pendingWrite = failedOperationRef.current;
      if (
        pendingWrite &&
        (pendingWrite.accountId !== recoveryAccountId ||
          pendingWrite.accountKey !== accountKey ||
          pendingWrite.noteId !== noteId ||
          pendingWrite.sourceHash !== source.sourceHash ||
          pendingWrite.baseVersion !== metadataRef.current.currentVersion)
      ) {
        failedOperationRef.current = null;
      }
      const key = `transcript-studio-recovery:${recoveryAccountId}:${noteId}:${source.sourceHash}`;
      try {
        const recovery = readLocalRecovery(key);
        if (recovery) {
          const savedDraft: unknown = JSON.parse(recovery);
          if (isRecoveryDraft(savedDraft, source.sourceHash)) {
            const baseVersionMatches =
              savedDraft.baseVersion === metadataRef.current.currentVersion;
            session.getState().reset(savedDraft.workspace);
            failedOperationRef.current = baseVersionMatches
              ? {
                  operation: savedDraft.operation,
                  description: savedDraft.description,
                  accountKey,
                  accountId: recoveryAccountId,
                  noteId,
                  sourceTranscript,
                  sourceHash: savedDraft.sourceHash,
                  baseVersion: savedDraft.baseVersion,
                  recoveryKey: key,
                }
              : null;
            setError(
              baseVersionMatches
                ? "Unsaved transcript changes were recovered. Retry save to persist them."
                : "A recovered draft is based on an older transcript version. It is preserved here; review the version conflict before saving."
            );
          } else {
            setError(
              "A saved local transcript recovery copy is invalid. Showing the persisted transcript instead."
            );
          }
        }
      } catch {
        setError(
          "Local transcript recovery could not be read. Showing the persisted transcript; check local storage availability before continuing."
        );
      }
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
  }, [accountKey, noteId, recoveryAccountId, sourceTranscript, session]);

  const persist = useCallback(
    (
      operation: EditOperation | EditOperation[],
      resultingWorkspace: TranscriptEditWorkspace,
      description: string,
      expectedContext: TranscriptSaveContext = captureSaveContext()
    ) => {
      const save = saveQueueRef.current.then(async () => {
        if (!saveContextIsCurrent(expectedContext)) return false;
        const currentMetadata = metadataRef.current;
        if (
          currentMetadata.currentVersion !== expectedContext.baseVersion ||
          currentMetadata.sourceHash !== expectedContext.sourceHash
        )
          return false;
        const result = await transcriptStudioRepository.applyTranscriptRevision({
          noteId: expectedContext.noteId,
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
        if (!saveContextIsCurrent(expectedContext)) return false;
        const savedVersions = await transcriptStudioRepository.listTranscriptVersions(
          expectedContext.noteId
        );
        if (!saveContextIsCurrent(expectedContext)) return false;
        metadataRef.current = {
          sourceHash: result.workspace.sourceHash,
          currentVersion: result.version,
          versionId: result.workspace.versionId ?? "",
        };
        setCurrentVersion(result.version);
        window.dispatchEvent(new Event("transcript-studio:revision-updated"));
        setVersions(savedVersions);
        versionForSnapshotRef.current.set(
          operationSnapshot(resultingWorkspace),
          result.workspace.versionId ?? ""
        );
        return true;
      });
      // Keep the returned promise rejectable for the caller, but let later queue work run.
      saveQueueRef.current = save.catch(() => undefined);
      void save.catch((saveError: unknown) => {
        if (saveContextIsCurrent(expectedContext)) {
          setError(
            saveError instanceof Error ? saveError.message : "Transcript edit could not be saved."
          );
        }
      });
      return save;
    },
    [accountKey, noteId, recoveryAccountId, recoveryKey, sourceTranscript]
  );

  const commitOperation = useCallback(
    async (operation: EditOperation, description: string) => {
      if (!canEdit || stale || error) return;
      const context = captureSaveContext();
      if (!beginSaveLock(context)) return;
      try {
        session.getState().apply([operation], { actor: "user" });
        const nextWorkspace = session.getState().workspace;
        const pendingWrite: PendingTranscriptWrite = {
          ...context,
          operation,
          description,
        };
        failedOperationRef.current = pendingWrite;
        const recoveryStored = writeLocalRecovery(
          context.recoveryKey,
          JSON.stringify({
            sourceHash: context.sourceHash,
            baseVersion: context.baseVersion,
            operation,
            description,
            workspace: nextWorkspace,
          })
        );
        if (!recoveryStored) {
          failedOperationRef.current = null;
          setError(
            "Local recovery storage is unavailable. This edit is shown only in this window; copy it before leaving. Nothing was sent to the transcript store."
          );
          return;
        }
        const persisted = await persist(operation, nextWorkspace, description, context);
        if (persisted && saveContextIdentityIsCurrent(context)) {
          if (failedOperationRef.current === pendingWrite) failedOperationRef.current = null;
          removeLocalRecovery(context.recoveryKey);
          setError("");
        } else if (!persisted && saveContextIdentityIsCurrent(context)) {
          setError(
            "Transcript context changed before the edit could be saved. The draft remains in local recovery."
          );
        }
      } catch (commitError) {
        if (saveContextIsCurrent(context)) {
          setError(
            commitError instanceof Error
              ? commitError.message
              : "Transcript edit could not be saved."
          );
        }
      } finally {
        releaseSaveLock(context);
      }
    },
    [canEdit, error, persist, recoveryAccountId, recoveryKey, session, stale]
  );

  const retryFailedOperation = useCallback(async () => {
    const failed = failedOperationRef.current;
    if (!failed || stale) return;
    if (!beginSaveLock(failed)) return;
    try {
      const retireIfStale = () => {
        if (failedOperationRef.current !== failed) return true;
        if (saveContextIsCurrent(failed)) return false;
        failedOperationRef.current = null;
        return true;
      };
      if (retireIfStale()) return;
      let saved: TranscriptStudioWorkspace;
      try {
        saved = await transcriptStudioRepository.getTranscriptWorkspace(failed.noteId);
      } catch (readError) {
        if (!retireIfStale()) {
          setError(
            readError instanceof Error
              ? readError.message
              : "Transcript version could not be checked."
          );
        }
        return;
      }
      if (retireIfStale()) return;
      if (
        saved.currentVersion !== failed.baseVersion ||
        revisionIsStale(saved, failed.sourceHash)
      ) {
        failedOperationRef.current = null;
        if (saveContextIsCurrent(failed)) {
          setError(
            "Transcript changed in another window. The recovered draft is preserved; reload and review the conflict before saving."
          );
        }
        return;
      }
      try {
        const persisted = await persist(
          failed.operation,
          session.getState().workspace,
          failed.description,
          failed
        );
        if (persisted) {
          if (!saveContextIdentityIsCurrent(failed)) return;
          removeLocalRecovery(failed.recoveryKey);
          if (failedOperationRef.current === failed) failedOperationRef.current = null;
          setError("");
        } else if (retireIfStale()) {
          return;
        }
      } catch (retryError) {
        if (!retireIfStale()) {
          setError(
            retryError instanceof Error ? retryError.message : "Transcript edit could not be saved."
          );
        }
      }
    } finally {
      releaseSaveLock(failed);
    }
  }, [persist, session, stale]);

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
      const restoreContext = captureSaveContext();
      const restore = saveQueueRef.current.then(async () => {
        if (!saveContextIdentityIsCurrent(restoreContext) || !canEdit || stale || error || saving)
          return;
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
            restoreContext.noteId,
            targetVersionId,
            metadataRef.current.currentVersion
          );
          if (!saveContextIdentityIsCurrent(restoreContext)) return;
          const restoredVersions = await transcriptStudioRepository.listTranscriptVersions(
            restoreContext.noteId
          );
          if (!saveContextIdentityIsCurrent(restoreContext)) return;
          metadataRef.current = {
            sourceHash: restored.sourceHash,
            currentVersion: restored.currentVersion,
            versionId: restored.versionId ?? "",
          };
          setCurrentVersion(restored.currentVersion);
          window.dispatchEvent(new Event("transcript-studio:revision-updated"));
          setVersions(restoredVersions);
          versionForSnapshotRef.current.set(
            operationSnapshot(targetWorkspace),
            restored.versionId ?? ""
          );
          setError("");
        } catch (restoreError) {
          if (!saveContextIdentityIsCurrent(restoreContext)) return;
          if (direction === "undo") session.getState().redo();
          else session.getState().undo();
          setError(
            restoreError instanceof Error
              ? restoreError.message
              : "Transcript version could not be restored."
          );
        }
      });
      saveQueueRef.current = restore.catch(() => undefined);
      void restore.catch((restoreError: unknown) => {
        if (saveContextIdentityIsCurrent(restoreContext)) {
          setError(
            restoreError instanceof Error
              ? restoreError.message
              : "A pending transcript save failed; history was not restored."
          );
        }
      });
      return restore;
    },
    [canEdit, error, noteId, saving, session, stale]
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
    const restoreContext = captureSaveContext();
    const restore = saveQueueRef.current.then(async () => {
      try {
        if (!saveContextIdentityIsCurrent(restoreContext)) return;
        const restored = await transcriptStudioRepository.restoreTranscriptVersion(
          restoreContext.noteId,
          compareVersionId,
          metadataRef.current.currentVersion
        );
        if (!saveContextIdentityIsCurrent(restoreContext)) return;
        const source = await normalizeTranscriptSource(restored.sourceTranscript);
        if (!saveContextIdentityIsCurrent(restoreContext)) return;
        const restoredWorkspace = applyEditOperations(
          source,
          restored.approvedOperations as EditOperation[],
          { actor: "user" }
        );
        const restoredVersions = await transcriptStudioRepository.listTranscriptVersions(
          restoreContext.noteId
        );
        if (!saveContextIdentityIsCurrent(restoreContext)) return;
        session.getState().reset(restoredWorkspace);
        metadataRef.current = {
          sourceHash: restored.sourceHash,
          currentVersion: restored.currentVersion,
          versionId: restored.versionId ?? "",
        };
        setCurrentVersion(restored.currentVersion);
        window.dispatchEvent(new Event("transcript-studio:revision-updated"));
        setVersions(restoredVersions);
        versionForSnapshotRef.current = new Map([
          [operationSnapshot(restoredWorkspace), restored.versionId ?? ""],
        ]);
        setCompareVersionId(restored.versionId ?? compareVersionId);
        setCompareText(workspaceText(restoredWorkspace));
        setError("");
      } catch (restoreError) {
        if (saveContextIdentityIsCurrent(restoreContext)) {
          setError(
            restoreError instanceof Error
              ? restoreError.message
              : "Transcript version could not be restored."
          );
        }
      }
    });
    saveQueueRef.current = restore.catch(() => undefined);
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
        saving ||
        proposals.some(
          (proposal) =>
            ids.includes(proposal.chunk.id) &&
            proposal.baseVersion !== metadataRef.current.currentVersion
        )
      )
        return;
      const context = captureSaveContext();
      if (!beginSaveLock(context)) return;
      const contextProposalsKey = proposalContextRef.current.storageKey;
      let applied = false;
      try {
        session.getState().apply(operations, { actor: "user" });
        applied = true;
        const persisted = await persist(
          operations,
          session.getState().workspace,
          ids.length > 1 ? "Accepted AI transcript proposals" : "Accepted AI transcript proposal",
          context
        );
        if (!persisted || !saveContextIdentityIsCurrent(context)) {
          if (applied && saveContextIdentityIsCurrent(context)) session.getState().undo();
          if (saveContextIdentityIsCurrent(context)) {
            setError(
              "The transcript changed before these proposals could be saved. The proposal remains available for review."
            );
          }
          return;
        }
        setProposals((previous) => {
          if (!saveContextIdentityIsCurrent(context)) return previous;
          const next = previous.filter((proposal) => !ids.includes(proposal.chunk.id));
          try {
            window.sessionStorage?.setItem(contextProposalsKey, JSON.stringify(next));
          } catch {
            /* session-only */
          }
          return next;
        });
        setError("");
      } catch (acceptError) {
        if (applied && saveContextIdentityIsCurrent(context)) session.getState().undo();
        if (saveContextIdentityIsCurrent(context)) {
          setError(
            acceptError instanceof Error
              ? acceptError.message
              : "AI proposal could not be accepted."
          );
        }
      } finally {
        releaseSaveLock(context);
      }
    },
    [beginSaveLock, canEdit, error, persist, proposals, saving, session, stale]
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
      {failedOperationRef.current && (
        <div className="mb-3 rounded border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
          <p>Unsaved transcript changes</p>
          <button type="button" onClick={() => void retryFailedOperation()}>
            Retry save
          </button>
        </div>
      )}
      {saving && (
        <p role="status" className="mb-3 text-sm text-muted-foreground">
          Saving transcript changes. Editing is paused until the save finishes.
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
          disabled={!canEdit || stale || !!error || saving || sessionState.undoStack.length === 0}
          onClick={() => void restoreSessionState("undo")}
        >
          Undo
        </button>
        <button
          type="button"
          disabled={!canEdit || stale || !!error || saving || sessionState.redoStack.length === 0}
          onClick={() => void restoreSessionState("redo")}
        >
          Redo
        </button>
        <button
          type="button"
          disabled={!canEdit || stale || saving || jobRunning}
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
          canRestore={canEdit && !stale && !error && !saving && !!compareVersionId && !jobRunning}
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
          canEdit={canEdit && !stale && !error && !saving}
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
          canEdit={canEdit && !stale && !error && !saving}
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
