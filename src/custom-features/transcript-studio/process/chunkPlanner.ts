import type { SourceSegment } from "../domain/types";

export interface TranscriptChunkSegment extends SourceSegment {
  /** Context only; this segment is owned by the preceding chunk. */
  contextOnly?: boolean;
  /** Present when a single source block was split to fit the input window. */
  parentSegmentId?: string;
  partIndex?: number;
  partCount?: number;
  textStart?: number;
  textEnd?: number;
}

export interface TranscriptChunk {
  id: string;
  index: number;
  segments: TranscriptChunkSegment[];
  inputTokens: number;
  outputTokens: number;
}

const estimateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 3.5));
const segmentTokens = (segment: SourceSegment): number => estimateTokens(segment.text) + 12;

function splitOversizedSegment(
  segment: SourceSegment,
  maxInputTokens: number
): TranscriptChunkSegment[] {
  if (segmentTokens(segment) <= maxInputTokens) return [segment];
  // Leave one token of rounding/slack for the word-boundary adjustment below.
  const maxChars = Math.max(8, Math.floor((maxInputTokens - 13) * 3.5));
  const spans: Array<{ start: number; end: number }> = [];
  let start = 0;
  while (start < segment.text.length) {
    let end = Math.min(segment.text.length, start + maxChars);
    if (end < segment.text.length) {
      const space = segment.text.lastIndexOf(" ", end);
      if (space > start + Math.floor(maxChars * 0.55)) end = space + 1;
    }
    if (end <= start) end = Math.min(segment.text.length, start + maxChars);
    spans.push({ start, end });
    start = end;
  }
  return spans.map(({ start: textStart, end: textEnd }, partIndex) => ({
    ...segment,
    id: `${segment.id}:part-${partIndex}`,
    text: segment.text.slice(textStart, textEnd),
    parentSegmentId: segment.id,
    partIndex,
    partCount: spans.length,
    textStart,
    textEnd,
  }));
}

/** Build source-ordered chunks. Every source segment is owned exactly once. */
export function planTranscriptChunks(
  segments: SourceSegment[],
  maxInputTokens: number
): TranscriptChunk[] {
  if (!Number.isFinite(maxInputTokens) || maxInputTokens < 32) {
    throw new Error("Transcript chunk token budget must be at least 32 tokens");
  }
  const chunks: TranscriptChunk[] = [];
  let owned: TranscriptChunkSegment[] = [];
  let used = 0;
  let previousSegmentCost = 0;
  const flush = () => {
    if (!owned.length) return;
    const contextSegment = chunks.length
      ? chunks[chunks.length - 1].segments.filter((s) => !s.contextOnly).at(-1)
      : undefined;
    const allowOverlap = !!contextSegment && previousSegmentCost + used <= maxInputTokens;
    const chunkSegments: TranscriptChunkSegment[] = [
      ...(allowOverlap && contextSegment ? [{ ...contextSegment, contextOnly: true }] : []),
      ...owned.map((segment) => ({ ...segment })),
    ];
    const inputTokens = chunkSegments.reduce((sum, segment) => sum + segmentTokens(segment), 0);
    chunks.push({
      id: `chunk-${chunks.length}`,
      index: chunks.length,
      segments: chunkSegments,
      inputTokens,
      outputTokens: Math.max(64, Math.min(2048, Math.floor(maxInputTokens * 0.65))),
    });
    previousSegmentCost = segmentTokens(owned[owned.length - 1]);
    owned = [];
    used = 0;
  };

  const boundedSegments = segments.flatMap((segment) =>
    splitOversizedSegment(segment, maxInputTokens)
  );
  for (const segment of boundedSegments) {
    if (!segment || typeof segment.id !== "string" || typeof segment.text !== "string") {
      throw new Error("Transcript chunk source contains an invalid segment");
    }
    const cost = segmentTokens(segment);
    if (owned.length && used + cost + (chunks.length ? previousSegmentCost : 0) > maxInputTokens)
      flush();
    owned.push(segment);
    used += cost;
  }
  flush();
  return chunks;
}
