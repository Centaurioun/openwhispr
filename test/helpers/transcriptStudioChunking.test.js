const test = require("node:test");
const assert = require("node:assert/strict");

let planTranscriptChunks;
test.before(async () => {
  ({ planTranscriptChunks } =
    await import("../../src/custom-features/transcript-studio/process/chunkPlanner.ts"));
});

const segment = (index, text) => ({
  id: `seg-${index}`,
  text,
  speakerId: null,
  speakerName: null,
  startSeconds: index * 3,
  endSeconds: index * 3 + 2,
  speakerLocked: false,
  sourceIndex: index,
});

test("plans ordered bounded chunks with a small overlap and stable source IDs", () => {
  const segments = Array.from({ length: 200 }, (_, index) =>
    segment(index, `words ${index} `.repeat(20))
  );
  const chunks = planTranscriptChunks(segments, 256);
  assert.ok(chunks.length > 1);
  assert.deepEqual(
    chunks.flatMap((chunk) =>
      chunk.segments.filter((item) => !item.contextOnly).map((item) => item.id)
    ),
    segments.map((item) => item.id)
  );
  assert.ok(chunks.every((chunk) => chunk.inputTokens <= 256));
  assert.ok(chunks.every((chunk, index) => index === 0 || chunk.segments[0]?.contextOnly));
});

test("handles a one-hour transcript without dropping, reordering, or duplicating owned blocks", () => {
  const segments = Array.from({ length: 1800 }, (_, index) =>
    segment(index, `Segment ${index}: the meeting proceeded as planned.`)
  );
  const chunks = planTranscriptChunks(segments, 1200);
  assert.ok(chunks.length > 1);
  const owned = chunks.flatMap((chunk) =>
    chunk.segments.filter((item) => !item.contextOnly).map((item) => item.id)
  );
  assert.deepEqual(
    owned,
    segments.map((item) => item.id)
  );
});

test("rejects invalid token budgets", () => {
  assert.throws(() => planTranscriptChunks([segment(0, "text")], 0), /token/i);
});

test("splits a single legacy plain-text source block losslessly into bounded ordered pieces", () => {
  const source = segment(0, "This is a long plain transcript. ".repeat(500));
  const chunks = planTranscriptChunks([source], 128);
  const pieces = chunks.flatMap((chunk) => chunk.segments.filter((item) => !item.contextOnly));
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.inputTokens <= 128));
  assert.ok(pieces.every((piece) => piece.parentSegmentId === source.id));
  assert.deepEqual(
    pieces.map((piece) => piece.partIndex),
    pieces.map((_, index) => index)
  );
  assert.equal(pieces.map((piece) => piece.text).join(""), source.text);
});
