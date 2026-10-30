export interface TranscriptPage {
  text: string;
  start: number;
  end: number;
  hasMore: boolean;
}

export const DEFAULT_PAGE_SIZE = 4_000;
export const MAX_PAGE_SIZE = 8_000;

/** Offsets and sizes are Unicode code-point counts, not UTF-16 code units. */
export function pageTranscript(
  text: string,
  offset = 0,
  maxChars = DEFAULT_PAGE_SIZE,
): TranscriptPage {
  if (typeof text !== "string") throw new Error("Transcript must be text.");
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Transcript offset must be a non-negative integer.");
  if (offset > Array.from(text).length) throw new Error("Transcript offset is past the end of the transcript.");
  if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > MAX_PAGE_SIZE) {
    throw new Error(`Transcript page size must be an integer from 1 to ${MAX_PAGE_SIZE}.`);
  }

  const codePoints = Array.from(text);
  const end = Math.min(offset + maxChars, codePoints.length);
  return {
    text: codePoints.slice(offset, end).join(""),
    start: offset,
    end,
    hasMore: end < codePoints.length,
  };
}
