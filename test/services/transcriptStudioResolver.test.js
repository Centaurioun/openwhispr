const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const {
  formatJson,
  formatMd,
  formatSrt,
  formatTxt,
} = require("../../src/helpers/transcriptFormatter");

let resolveTranscriptForUse;
let resolvedSegmentsAsTranscript;
test.before(async () => {
  ({ resolveTranscriptForUse, resolvedSegmentsAsTranscript } =
    await import("../../src/custom-features/transcript-studio/domain/transcriptResolver.ts"));
});

const hash = (text) => createHash("sha256").update(text, "utf8").digest("hex");

function repositoryFor(sourceTranscript, overrides = {}) {
  const sourceHash = hash(sourceTranscript);
  return {
    getTranscriptWorkspace: async () => ({
      noteId: 17,
      sourceTranscript,
      originalTranscript: sourceTranscript,
      sourceHash,
      baselineSourceHash: sourceHash,
      currentVersion: 0,
      versionId: null,
      approvedOperations: [],
      stale: false,
      ...overrides,
    }),
  };
}

test("original resolution returns the raw source byte for byte", async () => {
  const raw = '[{"text":"İlk satır\\nİkinci satır 👋"}]';
  const result = await resolveTranscriptForUse(17, "export", "original", repositoryFor(raw));

  assert.equal(result.text, raw);
  assert.equal(result.sourceHash, hash(raw));
  assert.deepEqual(
    result.segments.map((segment) => segment.text),
    ["İlk satır\nİkinci satır 👋"]
  );
});

test("approved resolution applies the current approved overlay", async () => {
  const raw = '[{"text":"raw","timestamp":5,"endTimestamp":8,"speaker":"speaker-1"}]';
  const result = await resolveTranscriptForUse(
    17,
    "summary",
    "approved",
    repositoryFor(raw, {
      currentVersion: 1,
      approvedOperations: [
        {
          kind: "replaceText",
          segmentId: `source-${hash(raw).slice(0, 16)}-0`,
          before: "raw",
          after: "approved",
        },
      ],
    })
  );

  assert.equal(result.text, "speaker-1: approved");
  assert.equal(result.sourceHash, hash(raw));
  assert.equal(result.segments[0].text, "approved");
  assert.equal(result.segments[0].startSeconds, 5);
});

test("approved segment content reaches JSON, Markdown, text, and timestamped SRT exports", async () => {
  const raw = '[{"text":"Correct me","source":"mic","speaker":"speaker-1","timestamp":2}]';
  const resolved = await resolveTranscriptForUse(
    17,
    "export",
    "approved",
    repositoryFor(raw, {
      currentVersion: 1,
      approvedOperations: [
        {
          kind: "replaceText",
          segmentId: `source-${hash(raw).slice(0, 16)}-0`,
          before: "Correct me",
          after: "Approved words",
        },
      ],
    })
  );
  const segments = resolvedSegmentsAsTranscript(resolved.segments);
  const note = { title: "Test", created_at: "2026-01-01T00:00:00Z" };

  assert.match(formatTxt(note, segments, {}), /Approved words/);
  assert.match(formatMd(note, segments, {}), /Approved words/);
  assert.match(formatSrt(segments, {}, note), /Approved words/);
  assert.equal(JSON.parse(formatJson(note, segments, {})).segments[0].text, "Approved words");
});

test("an unchanged note resolves approved to the original", async () => {
  const raw = "plain raw text";
  const result = await resolveTranscriptForUse(17, "display", "approved", repositoryFor(raw));

  assert.equal(result.text, raw);
  assert.equal(result.sourceHash, hash(raw));
});

test("stale approved overlays fail closed while original remains available", async () => {
  const raw = '[{"text":"current"}]';
  const repository = repositoryFor(raw, {
    stale: true,
    baselineSourceHash: "old-hash",
    currentVersion: 1,
  });

  await assert.rejects(
    resolveTranscriptForUse(17, "export", "approved", repository),
    /source changed/i
  );
  assert.equal((await resolveTranscriptForUse(17, "export", "original", repository)).text, raw);
});

test("current permission failure from the scoped repository is preserved", async () => {
  const repository = {
    getTranscriptWorkspace: async () => {
      throw new Error("Permission denied");
    },
  };

  await assert.rejects(
    resolveTranscriptForUse(17, "mcp", "approved", repository),
    /Permission denied/
  );
});
