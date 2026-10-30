const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const runtime = require("../../src/custom-features/transcript-studio/domain/transcriptStudioRuntime.cjs");

let normalizeTranscriptSource;
let applyEditOperations;

test.before(async () => {
  ({ normalizeTranscriptSource } =
    await import("../../src/custom-features/transcript-studio/domain/normalizeSource.ts"));
  ({ applyEditOperations } =
    await import("../../src/custom-features/transcript-studio/domain/editOperations.ts"));
});

test("main-process runtime stays in parity with TypeScript normalization and every edit operation", async () => {
  const raw = JSON.stringify([
    {
      text: "one two",
      source: "system",
      speaker: "speaker_0",
      speakerName: "Ada",
      speakerLocked: true,
      timestamp: 4,
      endTimestamp: 6,
    },
    { text: "three", source: "mic", timestamp: 7 },
  ]);
  const sourceHash = createHash("sha256").update(raw, "utf8").digest("hex");
  const typedSource = await normalizeTranscriptSource(raw);
  const mainSource = runtime.normalizeTranscriptSource(raw, sourceHash);
  assert.deepEqual(mainSource, typedSource, "normalization must produce identical source segments");

  const id = typedSource.segments[0].id;
  const newId = "split-one-two";
  const operations = [
    { kind: "replaceText", segmentId: id, before: "one two", after: "one changed" },
    {
      kind: "setSpeaker",
      segmentId: id,
      speakerId: "speaker_0",
      speakerName: "Ada",
      speakerLocked: true,
    },
    { kind: "split", segmentId: id, atOffset: 4, newId },
    { kind: "merge", leftId: id, rightId: newId },
  ];
  const typedResult = applyEditOperations(typedSource, operations, { actor: "user" });
  const mainResult = runtime.applyEditOperations(mainSource, operations, { actor: "user" });
  assert.deepEqual(mainResult, typedResult, "approved edit operations must match across runtimes");
});
