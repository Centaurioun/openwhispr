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
      viewerHandlers.get("transcript-studio-restore-version")(
        null,
        note.id,
        baselineId,
        0,
        "viewer-account"
      ),
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
        expectedAccountId: "viewer-account",
      }),
    /read-only/i
  );
  assert.equal(db.getTranscriptWorkspace(note.id).currentVersion, 0);
  const unverifiableHandlers = registeredHandlers(db, async () => {
    throw new Error("network unavailable");
  });
  await assert.rejects(
    async () =>
      unverifiableHandlers.get("transcript-studio-restore-version")(
        null,
        note.id,
        baselineId,
        0,
        "viewer-account"
      ),
    /Unable to verify/i
  );

  const editorHandlers = registeredHandlers(db, async () => "editor");
  const restored = await editorHandlers.get("transcript-studio-restore-version")(
    null,
    note.id,
    baselineId,
    0,
    "viewer-account"
  );
  assert.equal(restored.currentVersion, 1);
  const ownerNote = sharedNote(db, raw, "viewer-account", "viewer-account");
  const ownerHandlers = registeredHandlers(db, async () => "viewer");
  const ownerRestore = await ownerHandlers.get("transcript-studio-restore-version")(
    null,
    ownerNote.id,
    db.listTranscriptVersions(ownerNote.id)[0].versionId,
    0,
    "viewer-account"
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
        0,
        "team-account"
      ),
    /read-only/i
  );
});

test("IPC account assertion prevents a permission-await account switch from redirecting a write", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const raw = "Shared source";
  const spaceRow = db.db
    .prepare("INSERT INTO spaces (client_space_id, kind, name) VALUES (?, 'team', ?)")
    .run("account-switch-space", "Account switch");
  const spaceId = Number(spaceRow.lastInsertRowid);
  db.db
    .prepare("INSERT INTO space_accounts (space_id, account_id) VALUES (?, ?), (?, ?)")
    .run(spaceId, "account-a", spaceId, "account-b");
  db.setActiveAccountId("account-a");
  const note = db.saveNote("Shared", "", "meeting", null, null, null, spaceId, raw).note;
  db.db
    .prepare("UPDATE notes SET cloud_id = ?, owner_user_id = ? WHERE id = ?")
    .run("cloud-note-1", "note-owner", note.id);
  const originalAuthority = db.getTranscriptEditAuthority.bind(db);
  db.getTranscriptEditAuthority = (noteId) => {
    originalAuthority(noteId);
    return { canEdit: false, cloudId: "cloud-note-1" };
  };
  let finishPermission;
  const handlers = registeredHandlers(
    db,
    () =>
      new Promise((resolve) => {
        finishPermission = resolve;
      })
  );
  const pending = handlers.get("transcript-studio-apply-revision")(null, {
    noteId: note.id,
    expectedVersion: 0,
    sourceHash: db.getTranscriptWorkspace(note.id).sourceHash,
    operations: [],
    description: "Must remain in account A",
    expectedAccountId: "account-a",
  });
  db.setActiveAccountId("account-b");
  finishPermission("editor");
  await assert.rejects(pending, /account|scope|changed/i);
  assert.equal(
    db.db
      .prepare("SELECT COUNT(*) AS count FROM transcript_versions WHERE note_id = ?")
      .get(note.id).count,
    0
  );
  assert.equal(
    db.db
      .prepare("SELECT COUNT(*) AS count FROM transcript_workspaces WHERE note_id = ?")
      .get(note.id).count,
    0
  );
  assert.equal(
    db.db.prepare("SELECT transcript FROM notes WHERE id = ?").get(note.id).transcript,
    raw
  );

  db.setActiveAccountId("account-a");
  const baselineId = `baseline:account:account-a:${db.getTranscriptWorkspace(note.id).sourceHash}`;
  let finishRestorePermission;
  const restoreHandlers = registeredHandlers(
    db,
    () =>
      new Promise((resolve) => {
        finishRestorePermission = resolve;
      })
  );
  const pendingRestore = restoreHandlers.get("transcript-studio-restore-version")(
    null,
    note.id,
    baselineId,
    0,
    "account-a"
  );
  db.setActiveAccountId("account-b");
  finishRestorePermission("editor");
  await assert.rejects(pendingRestore, /account|scope|changed/i);
  assert.equal(
    db.db
      .prepare("SELECT COUNT(*) AS count FROM transcript_versions WHERE note_id = ?")
      .get(note.id).count,
    0
  );
  assert.equal(
    db.db
      .prepare("SELECT COUNT(*) AS count FROM transcript_workspaces WHERE note_id = ?")
      .get(note.id).count,
    0
  );
});

test("anonymous renderer assertion is explicit and mismatched accounts are rejected", async (t) => {
  const db = createDb(t);
  if (!db) return;
  db.setActiveAccountId(null);
  const raw = "Anonymous source";
  const note = db.saveNote("Local", "", "meeting", null, null, null, null, raw).note;
  const handlers = registeredHandlers(db);
  const base = {
    noteId: note.id,
    expectedVersion: 0,
    sourceHash: db.getTranscriptWorkspace(note.id).sourceHash,
    operations: [],
    description: "Anonymous edit",
    expectedAccountId: null,
  };
  const saved = await handlers.get("transcript-studio-apply-revision")(null, base);
  assert.equal(saved.version, 1);
  await assert.rejects(
    handlers.get("transcript-studio-apply-revision")(null, {
      ...base,
      expectedVersion: 1,
      expectedAccountId: "other-account",
    }),
    /account|scope/i
  );
  assert.equal(db.getTranscriptWorkspace(note.id).currentVersion, 1);
});
