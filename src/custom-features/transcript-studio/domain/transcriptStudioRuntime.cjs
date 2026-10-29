// Shared by the renderer's TypeScript domain layer and Electron's main process.
// Keep transcript normalization and edit semantics in this runtime module so
// the main process can resolve approved exports without trusting renderer data.

const finiteNumber = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function isTranscriptSpeakerLocked(segment) {
  return (
    !!segment.speakerLocked ||
    segment.speakerLockSource === "user" ||
    segment.speakerStatus === "locked" ||
    segment.speakerStatus === "user_locked"
  );
}

function normalizeTranscriptSource(raw, sourceHash) {
  const stableId = (index) => `source-${sourceHash.slice(0, 16)}-${index}`;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      sourceHash,
      kind: "plain",
      segments: [
        {
          id: stableId(0),
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

  if (
    !Array.isArray(parsed) ||
    !parsed.every(
      (segment) =>
        typeof segment === "object" && segment !== null && !Array.isArray(segment) && typeof segment.text === "string"
    )
  ) {
    return {
      sourceHash,
      kind: "plain",
      segments: [
        {
          id: stableId(0),
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

  const epochStart = parsed
    .map((segment) => finiteNumber(segment.timestamp))
    .filter((timestamp) => timestamp !== null && timestamp > 1_000_000_000)
    .reduce((minimum, timestamp) => (minimum === null ? timestamp : Math.min(minimum, timestamp)), null);
  const seconds = (value) => {
    const timestamp = finiteNumber(value);
    if (timestamp === null) return null;
    return epochStart !== null && timestamp > 1_000_000_000
      ? (timestamp - epochStart) / 1000
      : timestamp;
  };

  return {
    sourceHash,
    kind: "segments",
    segments: parsed.map((segment, sourceIndex) => ({
      id: stableId(sourceIndex),
      text: segment.text,
      speakerId:
        typeof segment.speakerId === "string"
          ? segment.speakerId
          : typeof segment.speaker === "string"
            ? segment.speaker
            : null,
      speakerName:
        typeof segment.speakerName === "string"
          ? segment.speakerName
          : typeof segment.recorderName === "string"
            ? segment.recorderName
            : null,
      ...(typeof segment.suggestedName === "string" ? { suggestedName: segment.suggestedName } : {}),
      ...(typeof segment.suggestedProfileId === "number"
        ? { suggestedProfileId: segment.suggestedProfileId }
        : {}),
      ...(typeof segment.recorderName === "string" ? { recorderName: segment.recorderName } : {}),
      ...(segment.source === "mic" || segment.source === "system" ? { source: segment.source } : {}),
      startSeconds: seconds(segment.timestamp),
      endSeconds: seconds(segment.endTimestamp),
      speakerLocked: isTranscriptSpeakerLocked(segment),
      sourceIndex,
    })),
  };
}

const cloneSegment = (segment) => ({ ...segment });

function requireSegment(segments, id) {
  const index = segments.findIndex((segment) => segment.id === id);
  if (index < 0) throw new Error(`Transcript segment not found: ${id}`);
  return { segment: segments[index], index };
}

function applyOne(segments, operation, actor) {
  switch (operation.kind) {
    case "replaceText": {
      const { segment, index } = requireSegment(segments, operation.segmentId);
      if (typeof operation.before !== "string" || typeof operation.after !== "string")
        throw new Error("Transcript replacement text must be a string");
      if (segment.text !== operation.before)
        throw new Error(`Transcript segment ${operation.segmentId} before text does not match`);
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
      if (actor === "ai" && segment.speakerLocked && changesAssignment)
        throw new Error(`Transcript speaker assignment is locked for segment ${operation.segmentId}`);
      const next = [...segments];
      next[index] = {
        ...segment,
        speakerId: operation.speakerId,
        speakerName: operation.speakerName,
        speakerLocked: operation.speakerLocked ?? segment.speakerLocked,
        ...(operation.suggestedName !== undefined ? { suggestedName: operation.suggestedName } : {}),
        ...(operation.suggestedProfileId !== undefined
          ? { suggestedProfileId: operation.suggestedProfileId }
          : {}),
      };
      return next;
    }
    case "split": {
      const { segment, index } = requireSegment(segments, operation.segmentId);
      if (!operation.newId || segments.some((item) => item.id === operation.newId))
        throw new Error(`Transcript segment ID already exists or is empty: ${operation.newId}`);
      if (
        !Number.isInteger(operation.atOffset) ||
        operation.atOffset <= 0 ||
        operation.atOffset >= segment.text.length
      ) {
        throw new Error("Transcript split offset must be inside the segment text");
      }
      const left = { ...segment, text: segment.text.slice(0, operation.atOffset), endSeconds: null };
      const right = {
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
      if (rightIndex !== leftIndex + 1) throw new Error("Transcript segments must be adjacent to merge");
      const speakerMatches =
        left.speakerId === right.speakerId && left.speakerName === right.speakerName;
      const hasSpeakerAssignment =
        left.speakerId !== null ||
        left.speakerName !== null ||
        right.speakerId !== null ||
        right.speakerName !== null;
      if (!speakerMatches && (hasSpeakerAssignment || left.speakerLocked || right.speakerLocked))
        throw new Error("Transcript merge would change or discard a speaker assignment");
      const merged = {
        ...left,
        text: left.text + right.text,
        speakerId: speakerMatches ? left.speakerId : null,
        speakerName: speakerMatches ? left.speakerName : null,
        speakerLocked: speakerMatches && (left.speakerLocked || right.speakerLocked),
        startSeconds: left.startSeconds,
        endSeconds: right.endSeconds,
      };
      return [...segments.slice(0, leftIndex), merged, ...segments.slice(rightIndex + 1)];
    }
    default:
      throw new Error("Unsupported transcript edit operation");
  }
}

function applyEditOperations(workspace, operations, options = {}) {
  if (!Array.isArray(operations)) throw new Error("Transcript edit operations must be an array");
  const actor = options.actor ?? "user";
  let segments = workspace.segments.map(cloneSegment);
  for (const operation of operations) {
    if (!operation || typeof operation !== "object" || typeof operation.kind !== "string")
      throw new Error("Invalid transcript edit operation");
    segments = applyOne(segments, operation, actor);
  }
  return { ...workspace, segments };
}

module.exports = { normalizeTranscriptSource, applyEditOperations };
