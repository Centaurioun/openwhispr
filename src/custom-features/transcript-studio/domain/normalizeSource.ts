import { isTranscriptSpeakerLocked } from "../../../utils/transcriptSpeakerState";
import type { TranscriptSegment } from "../../../stores/meetingRecordingStore";
import type { NormalizedTranscriptSource, SourceSegment } from "./types";

type RawSegment = Record<string, unknown> & { text: string };

const isRawSegment = (value: unknown): value is RawSegment =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  typeof (value as Record<string, unknown>).text === "string";

const finiteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const sourceHashFor = async (raw: string): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const asPlainSegment = (raw: string, id: string): SourceSegment => ({
  id,
  text: raw,
  speakerId: null,
  speakerName: null,
  startSeconds: null,
  endSeconds: null,
  speakerLocked: false,
  sourceIndex: 0,
});

/**
 * Normalize a stored transcript without changing it. Timestamp values above
 * the epoch-millisecond boundary are converted to recording-relative seconds;
 * already-relative timestamp values are kept in seconds.
 */
export async function normalizeTranscriptSource(raw: string): Promise<NormalizedTranscriptSource> {
  const sourceHash = await sourceHashFor(raw);
  const stableId = (index: number) => `source-${sourceHash.slice(0, 16)}-${index}`;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { sourceHash, kind: "plain", segments: [asPlainSegment(raw, stableId(0))] };
  }

  if (!Array.isArray(parsed) || !parsed.every(isRawSegment)) {
    return { sourceHash, kind: "plain", segments: [asPlainSegment(raw, stableId(0))] };
  }

  const sourceSegments = parsed as RawSegment[];
  const epochStart = sourceSegments
    .map((segment) => finiteNumber(segment.timestamp))
    .filter((timestamp): timestamp is number => timestamp !== null && timestamp > 1_000_000_000)
    .reduce<number | null>(
      (minimum, timestamp) => (minimum === null ? timestamp : Math.min(minimum, timestamp)),
      null
    );

  const seconds = (value: unknown): number | null => {
    const timestamp = finiteNumber(value);
    if (timestamp === null) return null;
    return epochStart !== null && timestamp > 1_000_000_000
      ? (timestamp - epochStart) / 1000
      : timestamp;
  };

  const segments = sourceSegments.map((segment, sourceIndex): SourceSegment => {
    const lockable = segment as unknown as TranscriptSegment;
    return {
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
      ...(typeof segment.suggestedName === "string"
        ? { suggestedName: segment.suggestedName }
        : {}),
      ...(typeof segment.suggestedProfileId === "number"
        ? { suggestedProfileId: segment.suggestedProfileId }
        : {}),
      ...(typeof segment.recorderName === "string" ? { recorderName: segment.recorderName } : {}),
      startSeconds: seconds(segment.timestamp),
      endSeconds: seconds(segment.endTimestamp),
      speakerLocked: isTranscriptSpeakerLocked(lockable),
      sourceIndex,
    };
  });

  return { sourceHash, kind: "segments", segments };
}
