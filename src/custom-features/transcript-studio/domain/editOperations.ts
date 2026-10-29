import type { NormalizedTranscriptSource, SourceSegment } from "./types";

export type EditOperation =
  | { kind: "replaceText"; segmentId: string; before: string; after: string }
  | { kind: "setSpeaker"; segmentId: string; speakerId: string | null; speakerName: string | null }
  | { kind: "split"; segmentId: string; atOffset: number; newId: string }
  | { kind: "merge"; leftId: string; rightId: string };

export type EditActor = "user" | "ai";
export type TranscriptEditWorkspace = NormalizedTranscriptSource;

export interface TranscriptEditCommand {
  operations: EditOperation[];
  before: TranscriptEditWorkspace;
  after: TranscriptEditWorkspace;
}

export interface TranscriptEditUndoCommand {
  before: TranscriptEditWorkspace;
  after: TranscriptEditWorkspace;
}

export interface ApplyEditOptions {
  actor?: EditActor;
}

const cloneSegment = (segment: SourceSegment): SourceSegment => ({ ...segment });
const cloneWorkspace = (workspace: TranscriptEditWorkspace): TranscriptEditWorkspace => ({
  ...workspace,
  segments: workspace.segments.map(cloneSegment),
});

function requireSegment(
  segments: SourceSegment[],
  id: string
): { segment: SourceSegment; index: number } {
  const index = segments.findIndex((segment) => segment.id === id);
  if (index < 0) throw new Error(`Transcript segment not found: ${id}`);
  return { segment: segments[index], index };
}

function applyOne(
  segments: SourceSegment[],
  operation: EditOperation,
  actor: EditActor
): SourceSegment[] {
  switch (operation.kind) {
    case "replaceText": {
      const { segment, index } = requireSegment(segments, operation.segmentId);
      if (typeof operation.before !== "string" || typeof operation.after !== "string") {
        throw new Error("Transcript replacement text must be a string");
      }
      if (segment.text !== operation.before) {
        throw new Error(`Transcript segment ${operation.segmentId} before text does not match`);
      }
      const next = [...segments];
      next[index] = { ...segment, text: operation.after };
      return next;
    }
    case "setSpeaker": {
      const { segment, index } = requireSegment(segments, operation.segmentId);
      if (
        (operation.speakerId !== null && typeof operation.speakerId !== "string") ||
        (operation.speakerName !== null && typeof operation.speakerName !== "string")
      ) {
        throw new Error("Transcript speaker values must be strings or null");
      }
      const changesAssignment =
        segment.speakerId !== operation.speakerId || segment.speakerName !== operation.speakerName;
      if (actor === "ai" && segment.speakerLocked && changesAssignment) {
        throw new Error(
          `Transcript speaker assignment is locked for segment ${operation.segmentId}`
        );
      }
      const next = [...segments];
      next[index] = {
        ...segment,
        speakerId: operation.speakerId,
        speakerName: operation.speakerName,
      };
      return next;
    }
    case "split": {
      const { segment, index } = requireSegment(segments, operation.segmentId);
      if (!operation.newId || segments.some((item) => item.id === operation.newId)) {
        throw new Error(`Transcript segment ID already exists or is empty: ${operation.newId}`);
      }
      if (
        !Number.isInteger(operation.atOffset) ||
        operation.atOffset <= 0 ||
        operation.atOffset >= segment.text.length
      ) {
        throw new Error("Transcript split offset must be inside the segment text");
      }
      const left: SourceSegment = {
        ...segment,
        text: segment.text.slice(0, operation.atOffset),
        endSeconds: null,
      };
      const right: SourceSegment = {
        ...segment,
        id: operation.newId,
        text: segment.text.slice(operation.atOffset),
        startSeconds: null,
      };
      return [...segments.slice(0, index), left, right, ...segments.slice(index + 1)];
    }
    case "merge": {
      const { segment: left, index: leftIndex } = requireSegment(segments, operation.leftId);
      const { segment: right, index: rightIndex } = requireSegment(segments, operation.rightId);
      if (rightIndex !== leftIndex + 1) {
        throw new Error("Transcript segments must be adjacent to merge");
      }
      const speakerMatches =
        left.speakerId === right.speakerId && left.speakerName === right.speakerName;
      if (actor === "ai" && !speakerMatches && (left.speakerLocked || right.speakerLocked)) {
        throw new Error("Transcript merge would change a locked speaker assignment");
      }
      const merged: SourceSegment = {
        ...left,
        text: left.text + right.text,
        speakerId: speakerMatches ? left.speakerId : null,
        speakerName: speakerMatches ? left.speakerName : null,
        speakerLocked: speakerMatches && (left.speakerLocked || right.speakerLocked),
        // These endpoints came from the outer source segments; a missing outer
        // endpoint stays missing instead of being inferred from duration.
        startSeconds: left.startSeconds,
        endSeconds: right.endSeconds,
      };
      return [...segments.slice(0, leftIndex), merged, ...segments.slice(rightIndex + 1)];
    }
    default:
      throw new Error("Unsupported transcript edit operation");
  }
}

/** Apply a whole command atomically; an invalid later operation cannot leak a partial edit. */
export function applyEditOperations(
  workspace: TranscriptEditWorkspace,
  operations: EditOperation[],
  options: ApplyEditOptions = {}
): TranscriptEditWorkspace {
  if (!Array.isArray(operations)) throw new Error("Transcript edit operations must be an array");
  const actor = options.actor ?? "user";
  let segments = workspace.segments.map(cloneSegment);
  for (const operation of operations) {
    if (!operation || typeof operation !== "object" || typeof operation.kind !== "string") {
      throw new Error("Invalid transcript edit operation");
    }
    segments = applyOne(segments, operation, actor);
  }
  return { ...workspace, segments };
}

/** Capture exact before/after state so inverse commands also restore segment metadata. */
export function createEditCommand(
  workspace: TranscriptEditWorkspace,
  operations: EditOperation[],
  options: ApplyEditOptions = {}
): TranscriptEditCommand {
  const before = cloneWorkspace(workspace);
  const after = applyEditOperations(before, operations, options);
  return { operations: [...operations], before, after };
}

/** Undo is an exact snapshot restoration, not a lossy attempt to synthesize inverse edits. */
export function invertEditCommand(command: TranscriptEditCommand): TranscriptEditUndoCommand {
  return {
    before: cloneWorkspace(command.after),
    after: cloneWorkspace(command.before),
  };
}
