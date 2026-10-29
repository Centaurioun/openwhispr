import { applyEditOperations } from "./editOperations";
import { normalizeTranscriptSource } from "./normalizeSource";
import type { EditOperation } from "./editOperations";
import type { SourceSegment } from "./types";
import { transcriptStudioRepository } from "../persistence/repository";

export type TranscriptUsePurpose = "display" | "export" | "summary" | "mcp";
export type TranscriptUseVersion = "original" | "approved";

export interface ResolvedTranscript {
  text: string;
  segments: SourceSegment[];
  sourceHash: string;
  version: number;
}

export function resolvedSegmentsAsTranscript(
  segments: SourceSegment[]
): Array<Record<string, unknown>> {
  return segments.map((segment) => ({
    id: segment.id,
    text: segment.text,
    ...(segment.source ? { source: segment.source } : {}),
    ...(segment.speakerId ? { speaker: segment.speakerId } : {}),
    ...(segment.speakerName ? { speakerName: segment.speakerName } : {}),
    ...(segment.recorderName ? { recorderName: segment.recorderName } : {}),
    ...(segment.startSeconds != null ? { timestamp: segment.startSeconds } : {}),
    ...(segment.endSeconds != null ? { endTimestamp: segment.endSeconds } : {}),
    ...(segment.speakerLocked ? { speakerLocked: true } : {}),
  }));
}

export interface TranscriptResolverRepository {
  getTranscriptWorkspace(noteId: number): Promise<{
    noteId: number;
    sourceTranscript: string;
    sourceHash: string;
    baselineSourceHash: string;
    currentVersion: number;
    approvedOperations: unknown[];
    stale: boolean;
  }>;
}

function renderText(segments: SourceSegment[]): string {
  return segments
    .map((segment) => {
      const speaker = segment.speakerName?.trim() || segment.speakerId?.trim();
      return speaker ? `${speaker}: ${segment.text}` : segment.text;
    })
    .join("\n");
}

/** Resolve a transcript using the current scoped note access check in the repository. */
export async function resolveTranscriptForUse(
  noteId: number,
  purpose: TranscriptUsePurpose,
  version: TranscriptUseVersion,
  repository: TranscriptResolverRepository = transcriptStudioRepository
): Promise<ResolvedTranscript> {
  if (!Number.isSafeInteger(noteId) || noteId <= 0) throw new Error("Invalid note ID.");
  if (!(
    purpose === "display" ||
    purpose === "export" ||
    purpose === "summary" ||
    purpose === "mcp"
  ))
    throw new Error("Invalid transcript use purpose.");
  if (!(version === "original" || version === "approved"))
    throw new Error("Invalid transcript version.");

  // This IPC-backed read rechecks the note against the active account on every call.
  const workspace = await repository.getTranscriptWorkspace(noteId);
  const original = await normalizeTranscriptSource(workspace.sourceTranscript);
  if (original.sourceHash !== workspace.sourceHash)
    throw new Error("Transcript source changed while resolving; reload and try again.");

  if (version === "original") {
    return {
      text: workspace.sourceTranscript,
      segments: original.segments,
      sourceHash: original.sourceHash,
      version: 0,
    };
  }
  if (workspace.stale || workspace.baselineSourceHash !== original.sourceHash)
    throw new Error("Transcript source changed; review the stale overlay before using it.");
  if (workspace.currentVersion === 0) {
    return {
      text: workspace.sourceTranscript,
      segments: original.segments,
      sourceHash: original.sourceHash,
      version: 0,
    };
  }

  const approved = applyEditOperations(original, workspace.approvedOperations as EditOperation[], {
    actor: "user",
  });
  return {
    text: renderText(approved.segments),
    segments: approved.segments,
    sourceHash: original.sourceHash,
    version: workspace.currentVersion,
  };
}
