const test = require("node:test");
const assert = require("node:assert/strict");

let applyEditOperations;
let createEditCommand;
let invertEditCommand;
let createTranscriptStudioStore;

test.before(async () => {
  ({ applyEditOperations, createEditCommand, invertEditCommand } =
    await import("../../src/custom-features/transcript-studio/domain/editOperations.ts"));
  ({ createTranscriptStudioStore } =
    await import("../../src/custom-features/transcript-studio/stores/transcriptStudioStore.ts"));
});

const segment = (id, text, sourceIndex, extra = {}) => ({
  id,
  text,
  speakerId: null,
  speakerName: null,
  startSeconds: null,
  endSeconds: null,
  speakerLocked: false,
  sourceIndex,
  ...extra,
});
const workspace = (segments) => ({ sourceHash: "source-hash", kind: "segments", segments });

test("replaceText validates before content and preserves source order", () => {
  const initial = workspace([segment("a", "first", 0), segment("b", "second", 1)]);
  const edited = applyEditOperations(initial, [
    { kind: "replaceText", segmentId: "b", before: "second", after: "edited second" },
  ]);

  assert.deepEqual(
    edited.segments.map(({ id, text }) => [id, text]),
    [
      ["a", "first"],
      ["b", "edited second"],
    ]
  );
  assert.throws(
    () =>
      applyEditOperations(initial, [
        { kind: "replaceText", segmentId: "b", before: "stale", after: "lost" },
      ]),
    /before text/i
  );
});

test("split and merge are reversible and reject duplicate or missing ids", () => {
  const initial = workspace([segment("a", "Hello world", 0), segment("b", "Next", 1)]);
  const splitOps = [{ kind: "split", segmentId: "a", atOffset: 5, newId: "a-right" }];
  const split = applyEditOperations(initial, splitOps);

  assert.deepEqual(
    split.segments.map(({ id, text }) => [id, text]),
    [
      ["a", "Hello"],
      ["a-right", " world"],
      ["b", "Next"],
    ]
  );
  assert.throws(
    () => applyEditOperations(split, [{ ...splitOps[0], newId: "b" }]),
    /already exists/i
  );
  assert.throws(
    () =>
      applyEditOperations(initial, [
        { kind: "split", segmentId: "missing", atOffset: 1, newId: "c" },
      ]),
    /segment/i
  );
  const merged = applyEditOperations(split, [{ kind: "merge", leftId: "a", rightId: "a-right" }]);
  assert.deepEqual(
    merged.segments.map(({ id, text }) => [id, text]),
    [
      ["a", "Hello world"],
      ["b", "Next"],
    ]
  );
  const command = createEditCommand(initial, splitOps);
  assert.deepEqual(invertEditCommand(command).after, initial);

  const mergeCommand = createEditCommand(initial, [{ kind: "merge", leftId: "a", rightId: "b" }]);
  assert.deepEqual(invertEditCommand(mergeCommand).after, initial);
});

test("merge requires adjacent segments and never invents an end timestamp", () => {
  const initial = workspace([
    segment("a", "Hello ", 0, { startSeconds: 1.25, endSeconds: 2.5 }),
    segment("b", "world", 1, { startSeconds: 3.5, endSeconds: null }),
    segment("c", "later", 2),
  ]);
  const merged = applyEditOperations(initial, [{ kind: "merge", leftId: "a", rightId: "b" }]);

  assert.equal(merged.segments[0].text, "Hello world");
  assert.equal(merged.segments[0].startSeconds, 1.25);
  assert.equal(merged.segments[0].endSeconds, null);
  assert.equal(merged.segments[0].speakerId, null);
  assert.throws(
    () => applyEditOperations(initial, [{ kind: "merge", leftId: "a", rightId: "c" }]),
    /adjacent/i
  );
});

test("AI cannot change a locked speaker while a user can explicitly override it", () => {
  const initial = workspace([
    segment("a", "spoken words", 0, {
      speakerId: "speaker-1",
      speakerName: "Ada",
      speakerLocked: true,
    }),
  ]);
  const operation = [
    { kind: "setSpeaker", segmentId: "a", speakerId: "speaker-2", speakerName: "Lin" },
  ];

  assert.throws(() => applyEditOperations(initial, operation, { actor: "ai" }), /locked/i);
  assert.deepEqual(applyEditOperations(initial, operation, { actor: "user" }).segments[0], {
    ...initial.segments[0],
    speakerId: "speaker-2",
    speakerName: "Lin",
    speakerLocked: true,
  });
});

test("AI cannot merge distinct confirmed speakers into an unnamed segment", () => {
  const initial = workspace([
    segment("a", "First", 0, { speakerId: "speaker-1", speakerName: "Ada" }),
    segment("b", "Second", 1, { speakerId: "speaker-2", speakerName: "Lin" }),
  ]);
  const operation = [{ kind: "merge", leftId: "a", rightId: "b" }];

  assert.throws(() => applyEditOperations(initial, operation, { actor: "ai" }), /speaker/i);
  const userMerge = applyEditOperations(initial, operation, { actor: "user" });
  assert.equal(userMerge.segments[0].text, "FirstSecond");
  assert.equal(userMerge.segments[0].speakerId, null);
  assert.equal(userMerge.segments[0].speakerName, null);
});

test("one accepted bulk edit is one undo unit and redo reapplies it", () => {
  const store = createTranscriptStudioStore(
    workspace([segment("a", "one", 0), segment("b", "two", 1)])
  );
  const operations = [
    { kind: "replaceText", segmentId: "a", before: "one", after: "ONE" },
    { kind: "replaceText", segmentId: "b", before: "two", after: "TWO" },
  ];

  store.getState().apply(operations, { actor: "ai" });
  assert.deepEqual(
    store.getState().workspace.segments.map(({ text }) => text),
    ["ONE", "TWO"]
  );
  assert.equal(store.getState().undoStack.length, 1);
  store.getState().undo();
  assert.deepEqual(
    store.getState().workspace.segments.map(({ text }) => text),
    ["one", "two"]
  );
  store.getState().redo();
  assert.deepEqual(
    store.getState().workspace.segments.map(({ text }) => text),
    ["ONE", "TWO"]
  );
});
