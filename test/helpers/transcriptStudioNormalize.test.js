const test = require("node:test");
const assert = require("node:assert/strict");

let normalizeTranscriptSource;
test.before(async () => {
  ({ normalizeTranscriptSource } =
    await import("../../src/custom-features/transcript-studio/domain/normalizeSource.ts"));
});

test("normalizes plain UTF-8 text as one untimed, unnamed segment", async () => {
  const raw = "Merhaba, dünya! 🌍";
  const result = await normalizeTranscriptSource(raw);

  assert.equal(result.kind, "plain");
  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0].text, raw);
  assert.equal(result.segments[0].speakerId, null);
  assert.equal(result.segments[0].speakerName, null);
  assert.equal(result.segments[0].startSeconds, null);
  assert.equal(result.segments[0].endSeconds, null);
  assert.equal(result.segments[0].speakerLocked, false);
  assert.equal(result.segments[0].sourceIndex, 0);
});

test("preserves segment speaker labels, lock state, and timing", async () => {
  const raw = JSON.stringify([
    {
      text: "Hello there",
      source: "system",
      speaker: "speaker-7",
      speakerName: "Ada",
      speakerLocked: true,
      timestamp: 2.25,
      endTimestamp: 3.5,
    },
  ]);
  const result = await normalizeTranscriptSource(raw);

  assert.equal(result.kind, "segments");
  assert.deepEqual(result.segments[0], {
    id: result.segments[0].id,
    text: "Hello there",
    speakerId: "speaker-7",
    speakerName: "Ada",
    startSeconds: 2.25,
    endSeconds: 3.5,
    speakerLocked: true,
    sourceIndex: 0,
  });
});

test("normalizes epoch-millisecond timestamps to source-relative seconds", async () => {
  const raw = JSON.stringify([
    {
      text: "one",
      source: "system",
      timestamp: 1_000_000_000_000,
      endTimestamp: 1_000_000_000_500,
    },
    {
      text: "two",
      source: "system",
      timestamp: 1_000_000_001_000,
      endTimestamp: 1_000_000_001_250,
    },
  ]);

  assert.deepEqual(
    (await normalizeTranscriptSource(raw)).segments.map(({ startSeconds, endSeconds }) => [
      startSeconds,
      endSeconds,
    ]),
    [
      [0, 0.5],
      [1, 1.25],
    ]
  );
});

test("malformed segment JSON remains recoverable as literal raw text", async () => {
  const raw = '[{"text":"Aylin konuştu"},';
  const result = await normalizeTranscriptSource(raw);

  assert.equal(result.kind, "plain");
  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0].text, raw);
});

test("identical source bytes produce equal hashes and deterministic IDs", async () => {
  const raw = JSON.stringify([{ text: "café 👋", source: "mic", timestamp: 4 }]);
  const first = await normalizeTranscriptSource(raw);
  const second = await normalizeTranscriptSource(raw);

  assert.equal(first.sourceHash, second.sourceHash);
  assert.equal(first.segments[0].id, second.segments[0].id);
  assert.match(first.sourceHash, /^[a-f0-9]{64}$/);
  assert.equal((await normalizeTranscriptSource(`${raw} `)).sourceHash === first.sourceHash, false);
});

test("hashes the exact UTF-8 representation as SHA-256", async () => {
  const result = await normalizeTranscriptSource("");

  assert.equal(
    result.sourceHash,
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  );
});
