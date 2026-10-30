const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "./windowBroadcast") {
    return { broadcastToWindows() {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { createDb } = require("./harness/db.js");
const CliBridge = require("../../src/helpers/cliBridge.js");
const { call } = require("./harness/cliBridge.js");

function createBridge(t) {
  const db = createDb(t);
  if (!db) return null;

  const bridge = new CliBridge({
    databaseManager: db,
    notifyVectorChanges() {},
    _asyncMirrorWrite() {},
  });
  return { bridge, db };
}

test("PATCH /v1/notes/:id is not_found when the note does not exist", (t) => {
  const ctx = createBridge(t);
  if (!ctx) return;

  assert.throws(() => call(ctx.bridge, "PATCH", "/v1/notes/999", { title: "New Title" }), {
    code: "NOT_FOUND",
  });
});

test("PATCH /v1/notes/:id is not_found for a deleted note and leaves it unchanged", (t) => {
  const ctx = createBridge(t);
  if (!ctx) return;

  const { id } = ctx.db.saveNote("Original", "content").note;
  ctx.db.deleteNote(id);

  assert.throws(() => call(ctx.bridge, "PATCH", `/v1/notes/${id}`, { title: "Edited" }), {
    code: "NOT_FOUND",
  });
  assert.equal(ctx.db.getNote(id).title, "Original");
});

test("PATCH /v1/notes/:id is a validation error when the folder or space does not exist", (t) => {
  const ctx = createBridge(t);
  if (!ctx) return;

  const { id } = ctx.db.saveNote("Original", "content").note;

  assert.throws(() => call(ctx.bridge, "PATCH", `/v1/notes/${id}`, { folder_id: 888 }), {
    code: "VALIDATION",
    message: "Folder not found",
  });
  assert.throws(() => call(ctx.bridge, "PATCH", `/v1/notes/${id}`, { space_id: 888 }), {
    code: "VALIDATION",
    message: "Space not found",
  });
});

test("PATCH /v1/notes/:id is not_found for a non-integer id", (t) => {
  const ctx = createBridge(t);
  if (!ctx) return;

  assert.throws(() => call(ctx.bridge, "PATCH", "/v1/notes/invalid-id", { title: "New Title" }), {
    code: "NOT_FOUND",
    message: "Invalid note id",
  });
});

test("PATCH /v1/notes/:id returns the updated note", (t) => {
  const ctx = createBridge(t);
  if (!ctx) return;

  const { id } = ctx.db.saveNote("Original", "Existing content").note;
  const result = call(ctx.bridge, "PATCH", `/v1/notes/${id}`, { title: "Updated Title" });

  assert.equal(result.data.id, id);
  assert.equal(result.data.title, "Updated Title");
  assert.equal(result.data.content, "Existing content");
});

test("PATCH /v1/notes/:id clears a provided blank text field so the clear syncs", (t) => {
  const ctx = createBridge(t);
  if (!ctx) return;

  const { id } = ctx.db.saveNote("Original", "Existing content").note;
  ctx.db.updateNote(id, { enhanced_content: "Summary", transcript: "Spoken words" });

  const result = call(ctx.bridge, "PATCH", `/v1/notes/${id}`, {
    content: "",
    enhanced_content: null,
    transcript: "",
  });

  assert.equal(result.data.content, "");
  assert.equal(result.data.content_sync_operation, "clear");
  assert.equal(result.data.enhanced_content, null);
  assert.equal(result.data.enhanced_content_sync_operation, "clear");
  // Transcript is never a clear target; the bridge stores it as before.
  assert.equal(result.data.transcript, "");
  assert.throws(
    () => call(ctx.bridge, "PATCH", `/v1/notes/${id}`, { content: "", clear_fields: "content" }),
    { code: "VALIDATION" }
  );
});

test("GET /v1/notes/:id preserves original transcript and adds the current approved transcript", (t) => {
  const ctx = createBridge(t);
  if (!ctx) return;

  const sourceTranscript = '[{"text":"Original words"}]';
  const { id } = ctx.db.saveNote("Transcript", "", "meeting", null, null, null, null, sourceTranscript).note;
  const sourceHash = require("node:crypto").createHash("sha256").update(sourceTranscript).digest("hex");
  ctx.db.getTranscriptWorkspace = () => ({
    noteId: id,
    sourceTranscript,
    sourceHash,
    baselineSourceHash: sourceHash,
    currentVersion: 1,
    approvedOperations: [
      {
        kind: "replaceText",
        segmentId: `source-${sourceHash.slice(0, 16)}-0`,
        before: "Original words",
        after: "Approved words",
      },
    ],
    stale: false,
  });

  const result = call(ctx.bridge, "GET", `/v1/notes/${id}`);

  assert.equal(result.data.transcript, sourceTranscript);
  assert.equal(result.data.transcript_studio.approved.status, "available");
  assert.match(result.data.transcript_studio.approved.text, /Approved words/);
  assert.doesNotMatch(result.data.transcript_studio.approved.text, /Original words/);
});

test("GET /v1/notes/:id keeps Original available and fails closed for a stale approved transcript", (t) => {
  const ctx = createBridge(t);
  if (!ctx) return;

  const sourceTranscript = '[{"text":"Original words"}]';
  const { id } = ctx.db.saveNote("Transcript", "", "meeting", null, null, null, null, sourceTranscript).note;
  const sourceHash = require("node:crypto").createHash("sha256").update(sourceTranscript).digest("hex");
  ctx.db.getTranscriptWorkspace = () => ({
    noteId: id,
    sourceTranscript,
    sourceHash,
    baselineSourceHash: "old-source-hash",
    currentVersion: 1,
    approvedOperations: [],
    stale: true,
  });

  const result = call(ctx.bridge, "GET", `/v1/notes/${id}`);

  assert.equal(result.data.transcript, sourceTranscript);
  assert.equal(result.data.transcript_studio.approved.status, "stale");
  assert.equal("text" in result.data.transcript_studio.approved, false);
});

test("GET /v1/notes/:id keeps Original available and fails closed for malformed approved operations", (t) => {
  const ctx = createBridge(t);
  if (!ctx) return;

  const sourceTranscript = '[{"text":"Original words"}]';
  const { id } = ctx.db.saveNote("Transcript", "", "meeting", null, null, null, null, sourceTranscript).note;
  const sourceHash = require("node:crypto").createHash("sha256").update(sourceTranscript).digest("hex");
  ctx.db.getTranscriptWorkspace = () => ({
    noteId: id,
    sourceTranscript,
    sourceHash,
    baselineSourceHash: sourceHash,
    currentVersion: 1,
    approvedOperations: [{ kind: "replaceText", segmentId: "not-in-source", before: "Original", after: "Lost" }],
    stale: false,
  });

  const result = call(ctx.bridge, "GET", `/v1/notes/${id}`);

  assert.equal(result.data.transcript, sourceTranscript);
  assert.equal(result.data.transcript_studio.approved.status, "invalid");
  assert.equal("text" in result.data.transcript_studio.approved, false);
});
