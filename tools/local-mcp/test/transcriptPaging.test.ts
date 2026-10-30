import assert from "node:assert/strict";
import test from "node:test";
import { pageTranscript } from "../src/transcriptPaging.js";

test("pages transcript by Unicode code points without splitting surrogate pairs", () => {
  const text = "A👋B🦊C";

  assert.deepEqual(pageTranscript(text, 0, 2), {
    text: "A👋",
    start: 0,
    end: 2,
    hasMore: true,
  });
  assert.deepEqual(pageTranscript(text, 2, 2), {
    text: "B🦊",
    start: 2,
    end: 4,
    hasMore: true,
  });
  assert.deepEqual(pageTranscript(text, 4, 2), {
    text: "C",
    start: 4,
    end: 5,
    hasMore: false,
  });
});

test("applies the default and maximum page-size limits", () => {
  assert.equal(pageTranscript("x".repeat(5_000)).text.length, 4_000);
  assert.equal(pageTranscript("x".repeat(10_000), 0, 8_000).text.length, 8_000);
  assert.throws(() => pageTranscript("x", 0, 8_001), /page size/i);
});

test("rejects invalid text, offset, and page size values", () => {
  assert.throws(() => pageTranscript(12 as unknown as string), /transcript/i);
  assert.throws(() => pageTranscript("words", -1), /offset/i);
  assert.throws(() => pageTranscript("words", 6), /offset/i);
  assert.throws(() => pageTranscript("words", 0, 0), /page size/i);
  assert.throws(() => pageTranscript("words", 0, 1.5), /page size/i);
});
