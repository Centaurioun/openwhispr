const runtime = require("../custom-features/transcript-studio/domain/transcriptStudioRuntime.cjs");

function parseSourceSegments(sourceTranscript) {
  try {
    const parsed = JSON.parse(sourceTranscript);
    if (
      Array.isArray(parsed) &&
      parsed.every((segment) => segment && typeof segment.text === "string")
    )
      return parsed;
  } catch {}
  return sourceTranscript ? [{ text: sourceTranscript }] : [];
}

function approvedSegmentsWithSourceFields(sourceTranscript, approved) {
  const sourceSegments = parseSourceSegments(sourceTranscript);
  const normalizedSource = runtime.normalizeTranscriptSource(sourceTranscript, approved.sourceHash);
  return approved.segments.map((segment) => {
    const source = sourceSegments[segment.sourceIndex] ?? {};
    const original = normalizedSource.segments[segment.sourceIndex];
    const speakerAssignmentChanged =
      !!original &&
      (original.speakerId !== segment.speakerId || original.speakerName !== segment.speakerName);
    return {
      ...source,
      id: segment.id,
      text: segment.text,
      speaker: segment.speakerId,
      speakerId: segment.speakerId,
      speakerName: segment.speakerName,
      ...(segment.source ? { source: segment.source } : {}),
      timestamp: segment.startSeconds,
      endTimestamp: segment.endSeconds,
      speakerLocked: segment.speakerLocked,
      ...(source.speakerIsPlaceholder !== undefined
        ? { speakerIsPlaceholder: speakerAssignmentChanged ? false : source.speakerIsPlaceholder }
        : {}),
    };
  });
}

/** Resolve an export only from the current database snapshot and the explicit version choice. */
function resolveTranscriptExport(workspace, { version, expectedSourceHash }) {
  if (!(version === "original" || version === "approved"))
    throw new Error("Invalid transcript selection");
  if (expectedSourceHash !== workspace.sourceHash)
    throw new Error("Transcript source changed; resolve it again");

  const sourceTranscript = workspace.sourceTranscript;
  const isOriginal = version === "original" || workspace.currentVersion === 0;
  if (isOriginal) {
    let sourceIsValidJson = false;
    try {
      JSON.parse(sourceTranscript);
      sourceIsValidJson = true;
    } catch {}
    return {
      sourceTranscript,
      segments: parseSourceSegments(sourceTranscript),
      isOriginal: true,
      sourceIsValidJson,
    };
  }
  if (workspace.stale || workspace.baselineSourceHash !== workspace.sourceHash)
    throw new Error("Transcript source changed; review the stale overlay");

  const source = runtime.normalizeTranscriptSource(sourceTranscript, workspace.sourceHash);
  const approved = runtime.applyEditOperations(source, workspace.approvedOperations, {
    actor: "user",
  });
  return {
    sourceTranscript,
    segments: approvedSegmentsWithSourceFields(sourceTranscript, approved),
    isOriginal: false,
    sourceIsValidJson: false,
  };
}

module.exports = { resolveTranscriptExport };
