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

test("maps complete unique source IDs but flags punctuation changes for manual review", () => {
  const source = chunk(segment("a", "Hello world.", 0), segment("b", "Next sentence.", 1));
  const result = validateTranscriptProposal(source, {
    segments: [
      { id: "a", text: "Hello, world." },
      { id: "b", text: "Next sentence." },
    ],
  });
  assert.equal(result.safe, false);
  assert.ok(result.warnings.some((warning) => /comma|punctuation|review/i.test(warning)));
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

test("rejects reordered blocks, malformed shapes, and empty or non-string content", () => {
  const source = chunk(segment("a", "First line.", 0), segment("b", "Second line.", 1));
  for (const candidate of [
    {
      segments: [
        { id: "b", text: "Second line." },
        { id: "a", text: "First line." },
      ],
    },
    {
      segments: [
        { id: "a", text: "First line." },
        { id: "b", text: 42 },
      ],
    },
    {
      segments: [
        { id: "a", text: "First line." },
        { id: "b", text: "" },
      ],
    },
    { segments: "not-an-array" },
  ]) {
    const result = validateTranscriptProposal(source, candidate);
    assert.equal(result.safe, false);
    assert.ok(result.warnings.length > 0);
  }
});

test("flags omitted content, added terms, names, and spelled or signed number changes for individual review", () => {
  const source = chunk(
    segment("a", "Ada reviewed every section of the Orion protocol on March 5.", 0),
    segment("b", "The value is minus twelve point five percent.", 1)
  );
  const candidate = {
    segments: [
      { id: "a", text: "Ada approved the Orion protocol on March 5. Keep this confidential." },
      { id: "b", text: "The value is plus twelve point five percent." },
    ],
  };
  const result = validateTranscriptProposal(source, candidate);
  assert.equal(result.safe, false);
  assert.ok(result.warnings.some((warning) => /review/i.test(warning)));
  assert.equal(result.edits.length, 2);
});

test("flags reordered words that preserve the same token multiset", () => {
  const source = chunk(segment("a", "Alice told Bob.", 0));
  const result = validateTranscriptProposal(source, {
    segments: [{ id: "a", text: "Bob told Alice." }],
  });
  assert.equal(result.safe, false);
  assert.ok(result.warnings.some((warning) => /word order|content|manually review/i.test(warning)));
});

test("flags punctuation-only changes that can reverse meaning", () => {
  const source = chunk(segment("a", "Let's eat, Grandma.", 0));
  const result = validateTranscriptProposal(source, {
    segments: [{ id: "a", text: "Let's eat Grandma." }],
  });
  assert.equal(result.safe, false);
  assert.ok(result.warnings.some((warning) => /punctuation|meaning|review/i.test(warning)));
});

test("flags sentence-ending punctuation changes that alter a statement into a question", () => {
  const source = chunk(segment("a", "You came.", 0));
  const result = validateTranscriptProposal(source, {
    segments: [{ id: "a", text: "You came?" }],
  });
  assert.equal(result.safe, false);
  assert.ok(result.warnings.some((warning) => /punctuation|meaning|review/i.test(warning)));
});

test("flags comma deletions that change list and clause meaning", () => {
  const examples = [
    ["I enjoy cooking, my family, and my pets.", "I enjoy cooking my family and my pets."],
    [
      "We invited the guests, who had arrived early.",
      "We invited the guests who had arrived early.",
    ],
  ];
  for (const [before, after] of examples) {
    const result = validateTranscriptProposal(chunk(segment("a", before, 0)), {
      segments: [{ id: "a", text: after }],
    });
    assert.equal(result.safe, false, `${before} -> ${after}`);
    assert.ok(result.warnings.some((warning) => /comma|punctuation|meaning|review/i.test(warning)));
  }
});

test("rejects a non-JSON envelope rather than accepting a partially parsed object", () => {
  const source = chunk(segment("a", "Keep all words.", 0));
  const result = validateTranscriptProposal(source, {
    segments: [{ id: "a", text: "Keep all words." }],
    extra: true,
  });
  assert.equal(result.safe, false);
});

test("structural omissions cannot produce a partial set of edits", () => {
  const source = chunk(segment("a", "Original first.", 0), segment("b", "Original second.", 1));
  const result = validateTranscriptProposal(source, {
    segments: [{ id: "a", text: "Edited first." }],
  });

  assert.deepEqual(result.edits, []);
  assert.equal(result.structurallyValid, false);
  assert.equal(result.safe, false);
});

test("duplicates, unexpected IDs, reordered blocks, truncation, and invalid content are structurally blocked", () => {
  const source = chunk(segment("a", "First original.", 0), segment("b", "Second original.", 1));
  const candidates = [
    {
      segments: [
        { id: "a", text: "First edit." },
        { id: "a", text: "Duplicate." },
        { id: "b", text: "Second original." },
      ],
    },
    {
      segments: [
        { id: "a", text: "First edit." },
        { id: "unexpected", text: "Unexpected." },
        { id: "b", text: "Second original." },
      ],
    },
    {
      segments: [
        { id: "b", text: "Second original." },
        { id: "a", text: "First edit." },
      ],
    },
    {
      segments: [
        { id: "a", text: "First edit." },
        { id: "b", text: "Second original." },
      ],
      truncated: true,
    },
    {
      segments: [
        { id: "a", text: "First edit." },
        { id: "b", text: "" },
      ],
    },
  ];

  for (const candidate of candidates) {
    const result = validateTranscriptProposal(source, candidate);
    assert.equal(result.structurallyValid, false);
    assert.equal(result.safe, false);
    assert.deepEqual(result.edits, []);
  }
});

test("semantic uncertainty remains structurally valid for deliberate manual review", () => {
  const source = chunk(segment("a", "Alice told Bob the value was 42.", 0));
  const result = validateTranscriptProposal(source, {
    segments: [{ id: "a", text: "Bob told Alice the value was 42." }],
  });

  assert.equal(result.structurallyValid, true);
  assert.equal(result.safe, false);
  assert.deepEqual(result.edits, [
    {
      kind: "replaceText",
      segmentId: "a",
      before: "Alice told Bob the value was 42.",
      after: "Bob told Alice the value was 42.",
    },
  ]);
});

test("complete semantically safe proposals remain eligible for ordinary acceptance", () => {
  const source = chunk(segment("a", "The meeting starts at nine.", 0));
  const result = validateTranscriptProposal(source, {
    segments: [{ id: "a", text: "The meeting starts at nine." }],
  });

  assert.equal(result.structurallyValid, true);
  assert.equal(result.safe, true);
  assert.deepEqual(result.edits, []);
});
