const test = require("node:test");
const assert = require("node:assert/strict");

let validateTranscriptProposal;
test.before(async () => {
  ({ validateTranscriptProposal } =
    await import("../../src/custom-features/transcript-studio/domain/validateProposal.ts"));
});

const segment = (id, text, sourceIndex) => ({
  id,
  text,
  speakerId: null,
  speakerName: null,
  startSeconds: null,
  endSeconds: null,
  speakerLocked: false,
  sourceIndex,
});
const chunk = (...segments) => ({ id: "chunk-1", index: 0, inputTokens: 10, segments });

test("maps only complete, unique source IDs into stable replaceText operations", () => {
  const source = chunk(segment("a", "Hello world.", 0), segment("b", "Next sentence.", 1));
  const result = validateTranscriptProposal(source, {
    segments: [
      { id: "a", text: "Hello, world." },
      { id: "b", text: "Next sentence." },
    ],
  });
  assert.equal(result.safe, true);
  assert.deepEqual(result.edits, [
    { kind: "replaceText", segmentId: "a", before: "Hello world.", after: "Hello, world." },
  ]);
});

test("flags missing, duplicate, numeric, named-entity, and truncated output", () => {
  const source = chunk(
    segment("a", "Ada paid 42 dollars.", 0),
    segment("b", "The Atlas project starts Monday.", 1)
  );
  for (const candidate of [
    { segments: [{ id: "a", text: "Ada paid 42 dollars." }] },
    {
      segments: [
        { id: "a", text: "Ada paid 42 dollars." },
        { id: "a", text: "duplicate" },
        { id: "b", text: "The Atlas project starts Monday." },
      ],
    },
    {
      segments: [
        { id: "a", text: "Ada paid 24 dollars." },
        { id: "b", text: "The Atlas project starts Monday." },
      ],
    },
    {
      segments: [
        { id: "a", text: "Eve paid 42 dollars." },
        { id: "b", text: "The Atlas project starts Monday." },
      ],
    },
    { segments: [{ id: "a", text: "Ada paid 42 dollars." }], truncated: true },
  ]) {
    const result = validateTranscriptProposal(source, candidate);
    assert.equal(result.safe, false);
    assert.ok(result.warnings.length > 0);
  }
});
