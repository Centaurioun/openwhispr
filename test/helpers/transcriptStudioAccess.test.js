const test = require("node:test");
const assert = require("node:assert/strict");
const { createDb } = require("./harness/db.js");
const {
  registerTranscriptStudioWriteIpcHandlers,
} = require("../../src/helpers/transcriptStudioAccess.js");

function registeredHandlers(db, resolvePermission) {
  const handlers = new Map();
  registerTranscriptStudioWriteIpcHandlers(
    { handle: (channel, callback) => handlers.set(channel, callback) },
    db,
    resolvePermission
  );
  return handlers;
}

function sharedNote(db, transcript, ownerId, readerAccount) {
  db.setActiveAccountId(readerAccount);
  const result = db.saveNote(
    "Shared transcript",
    "",
    "meeting",
    null,
    null,
    null,
    null,
    transcript
  );
  db.db
    .prepare("UPDATE notes SET cloud_id = ?, owner_user_id = ? WHERE id = ?")
    .run("cloud-note-1", ownerId, result.note.id);
  return result.note;
}

test("restore authorization rejects a viewer and permits an editor at the IPC boundary", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const raw = "Shared source";
  const note = sharedNote(db, raw, "note-owner", "viewer-account");
  const baselineId = db.listTranscriptVersions(note.id)[0].versionId;
  const viewerHandlers = registeredHandlers(db, async (cloudId) => {
    assert.equal(cloudId, "cloud-note-1");
    return "viewer";
  });
  await assert.rejects(
    async () =>
      viewerHandlers.get("transcript-studio-restore-version")(null, note.id, baselineId, 0),
    /read-only/i
  );
  await assert.rejects(
    async () =>
      viewerHandlers.get("transcript-studio-apply-revision")(null, {
        noteId: note.id,
        expectedVersion: 0,
        sourceHash: db.getTranscriptWorkspace(note.id).sourceHash,
        operations: [],
        description: "Should be denied",
      }),
    /read-only/i
  );
  assert.equal(db.getTranscriptWorkspace(note.id).currentVersion, 0);
  const unverifiableHandlers = registeredHandlers(db, async () => {
    throw new Error("network unavailable");
  });
  await assert.rejects(
    async () =>
      unverifiableHandlers.get("transcript-studio-restore-version")(null, note.id, baselineId, 0),
    /Unable to verify/i
  );

  const editorHandlers = registeredHandlers(db, async () => "editor");
  const restored = await editorHandlers.get("transcript-studio-restore-version")(
    null,
    note.id,
    baselineId,
    0
  );
  assert.equal(restored.currentVersion, 1);
  const ownerNote = sharedNote(db, raw, "viewer-account", "viewer-account");
  const ownerHandlers = registeredHandlers(db, async () => "viewer");
  const ownerRestore = await ownerHandlers.get("transcript-studio-restore-version")(
    null,
    ownerNote.id,
    db.listTranscriptVersions(ownerNote.id)[0].versionId,
    0
  );
  assert.equal(ownerRestore.currentVersion, 1);
});

test("team note edit authorization uses the server-mirrored edit_notes capability", (t) => {
  const db = createDb(t);
  if (!db) return;
  const spaceRow = db.db
    .prepare(
      "INSERT INTO spaces (client_space_id, kind, name, capabilities, my_role) VALUES (?, 'team', ?, ?, ?)"
    )
    .run("transcript-acl-space", "Transcript ACL", JSON.stringify({ edit_notes: true }), "admin");
  const spaceId = Number(spaceRow.lastInsertRowid);
  db.db
    .prepare("INSERT INTO space_accounts (space_id, account_id) VALUES (?, ?)")
    .run(spaceId, "team-account");
  db.setActiveAccountId("team-account");
  const note = db.saveNote(
    "Team transcript",
    "",
    "meeting",
    null,
    null,
    null,
    spaceId,
    "Team source"
  ).note;
  assert.deepEqual(db.getTranscriptEditAuthority(note.id), { canEdit: true, cloudId: null });

  db.db
    .prepare("UPDATE spaces SET capabilities = ?, my_role = ? WHERE id = ?")
    .run(JSON.stringify({ edit_notes: false }), "member", spaceId);
  assert.deepEqual(db.getTranscriptEditAuthority(note.id), { canEdit: false, cloudId: null });
  const handlers = registeredHandlers(db, async () => "editor");
  return assert.rejects(
    async () =>
      handlers.get("transcript-studio-restore-version")(
        null,
        note.id,
        db.listTranscriptVersions(note.id)[0].versionId,
        0
      ),
    /read-only/i
  );
});
