const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { createDb } = require("./harness/db.js");
const { createHash } = require("node:crypto");

const hash = (value) => createHash("sha256").update(value, "utf8").digest("hex");

function saveTranscriptNote(db, transcript, accountId = "transcript-account") {
  db.setActiveAccountId(accountId);
  const saved = db.saveNote("Transcript", "", "meeting", null, null, null, null, transcript);
  return saved.note;
}

test("a missing overlay returns the current raw transcript at version zero", (t) => {
  const db = createDb(t);
  if (!db) return;
  const raw = '[{"text":"Merhaba","speaker":"speaker-1","timestamp":2}]';
  const note = saveTranscriptNote(db, raw);

  assert.deepEqual(db.getTranscriptWorkspace(note.id), {
    noteId: note.id,
    sourceTranscript: raw,
    originalTranscript: raw,
    sourceHash: hash(raw),
    baselineSourceHash: hash(raw),
    currentVersion: 0,
    versionId: null,
    approvedOperations: [],
    stale: false,
  });
  assert.deepEqual(db.listTranscriptVersions(note.id), [
    {
      versionId: `baseline:account:transcript-account:${hash(raw)}`,
      version: 0,
      description: "Original transcript",
      createdAt: null,
    },
  ]);
});

test("approved revisions never mutate notes.transcript and stale versions conflict atomically", (t) => {
  const db = createDb(t);
  if (!db) return;
  const raw = '[{"text":"Original 👋","source":"mic"}]';
  const note = saveTranscriptNote(db, raw);
  const input = {
    noteId: note.id,
    expectedVersion: 0,
    sourceHash: hash(raw),
    operations: [
      { kind: "replaceText", segmentId: "source-a", before: "Original 👋", after: "Edited 👋" },
    ],
    description: "Correct greeting",
  };

  const applied = db.applyTranscriptRevision(input);
  assert.equal(applied.version, 1);
  assert.equal(
    db.db.prepare("SELECT transcript FROM notes WHERE id = ?").get(note.id).transcript,
    raw
  );
  assert.deepEqual(db.getTranscriptWorkspace(note.id).approvedOperations, input.operations);

  const conflict = db.applyTranscriptRevision({
    ...input,
    operations: [{ kind: "replaceText", segmentId: "source-a", after: "Lost" }],
  });
  assert.deepEqual(conflict, { conflict: true });
  assert.equal(db.getTranscriptWorkspace(note.id).currentVersion, 1);
  assert.equal(db.listTranscriptVersions(note.id).length, 2);
});

test("a source hash change marks the existing approved overlay stale", (t) => {
  const db = createDb(t);
  if (!db) return;
  const raw = "Meeting starts";
  const note = saveTranscriptNote(db, raw);
  db.applyTranscriptRevision({
    noteId: note.id,
    expectedVersion: 0,
    sourceHash: hash(raw),
    operations: [{ kind: "replaceText", segmentId: "source-0", after: "Meeting begins" }],
    description: "Correct wording",
  });
  db.updateNote(note.id, { transcript: "Meeting starts in room 2" });

  const workspace = db.getTranscriptWorkspace(note.id);
  assert.equal(workspace.sourceTranscript, "Meeting starts in room 2");
  assert.equal(workspace.stale, true);
  assert.equal(workspace.currentVersion, 1);
  assert.equal(workspace.approvedOperations[0].after, "Meeting begins");
});

test("note access is rechecked for reads and writes after an account switch or deletion", (t) => {
  const db = createDb(t);
  if (!db) return;
  const raw = "Private transcript";
  const note = saveTranscriptNote(db, raw, "owner-account");
  const input = {
    noteId: note.id,
    expectedVersion: 0,
    sourceHash: hash(raw),
    operations: [],
    description: "Empty revision",
  };

  db.setActiveAccountId("other-account");
  assert.throws(() => db.getTranscriptWorkspace(note.id), /not found|inaccessible/i);
  assert.throws(() => db.listTranscriptVersions(note.id), /not found|inaccessible/i);
  assert.throws(() => db.applyTranscriptRevision(input), /not found|inaccessible/i);
  assert.throws(
    () => db.restoreTranscriptVersion(note.id, `baseline:${hash(raw)}`, 0),
    /not found|inaccessible/i
  );

  db.setActiveAccountId("owner-account");
  db.db.prepare("DELETE FROM notes WHERE id = ?").run(note.id);
  assert.throws(() => db.getTranscriptWorkspace(note.id), /not found|inaccessible/i);
  assert.throws(() => db.listTranscriptVersions(note.id), /not found|inaccessible/i);
  assert.throws(() => db.applyTranscriptRevision(input), /not found|inaccessible/i);
  assert.throws(
    () => db.restoreTranscriptVersion(note.id, `baseline:${hash(raw)}`, 0),
    /not found|inaccessible/i
  );
});

test("shared team-note members keep separate overlay workspaces and version histories", (t) => {
  const db = createDb(t);
  if (!db) return;
  const teamSpace = db.db
    .prepare(
      "INSERT INTO spaces (client_space_id, kind, name, sort_order) VALUES (?, 'team', ?, 1)"
    )
    .run("transcript-team-space", "Transcript Team");
  const spaceId = Number(teamSpace.lastInsertRowid);
  db.db
    .prepare("INSERT INTO space_accounts (space_id, account_id) VALUES (?, ?), (?, ?)")
    .run(spaceId, "team-owner", spaceId, "team-member");

  db.setActiveAccountId("team-owner");
  const saved = db.saveNote(
    "Shared transcript",
    "",
    "meeting",
    null,
    null,
    null,
    spaceId,
    "Team source"
  );
  db.applyTranscriptRevision({
    noteId: saved.note.id,
    expectedVersion: 0,
    sourceHash: hash("Team source"),
    operations: [{ kind: "replaceText", segmentId: "source-0", after: "Shared edit" }],
    description: "Shared edit",
  });

  db.setActiveAccountId("team-member");
  assert.equal(db.getTranscriptWorkspace(saved.note.id).currentVersion, 0);
  assert.deepEqual(db.getTranscriptWorkspace(saved.note.id).approvedOperations, []);
  assert.equal(db.listTranscriptVersions(saved.note.id).length, 1);
  const memberEdit = db.applyTranscriptRevision({
    noteId: saved.note.id,
    expectedVersion: 0,
    sourceHash: hash("Team source"),
    operations: [{ kind: "replaceText", segmentId: "source-0", after: "Member edit" }],
    description: "Member edit",
  });
  assert.equal(memberEdit.version, 1);
  assert.match(memberEdit.workspace.versionId, /^.+$/);

  db.setActiveAccountId("team-owner");
  const ownerWorkspace = db.getTranscriptWorkspace(saved.note.id);
  assert.equal(ownerWorkspace.currentVersion, 1);
  assert.equal(ownerWorkspace.approvedOperations[0].after, "Shared edit");
  const ownerVersions = db.listTranscriptVersions(saved.note.id);
  assert.equal(ownerVersions.length, 2);
  assert.ok(!ownerVersions.some(({ versionId }) => versionId === memberEdit.workspace.versionId));
  assert.throws(
    () => db.restoreTranscriptVersion(saved.note.id, memberEdit.workspace.versionId, 1),
    /not found/i
  );

  db.setActiveAccountId("not-a-member");
  assert.throws(() => db.getTranscriptWorkspace(saved.note.id), /not found|inaccessible/i);
});

test("account-less private notes use a stable local scope across account switches", (t) => {
  const db = createDb(t);
  if (!db) return;
  const raw = "Local legacy transcript";
  db.setActiveAccountId("first-account");
  const note = db.saveNote("Local", "", "meeting", null, null, null, null, raw).note;
  db.db.prepare("UPDATE notes SET account_id = NULL WHERE id = ?").run(note.id);
  const result = db.applyTranscriptRevision({
    noteId: note.id,
    expectedVersion: 0,
    sourceHash: hash(raw),
    operations: [{ kind: "replaceText", segmentId: "source-0", after: "Local edit" }],
    description: "Local edit",
  });

  db.setActiveAccountId("second-account");
  assert.equal(db.getTranscriptWorkspace(note.id).versionId, result.workspace.versionId);
  assert.equal(db.getTranscriptWorkspace(note.id).approvedOperations[0].after, "Local edit");
  assert.deepEqual(
    db.db.prepare("SELECT scope_key FROM transcript_workspaces WHERE note_id = ?").get(note.id),
    { scope_key: "local:default" }
  );
});

test("workspace revisions survive database reopen and restore appends a revision", (t) => {
  const db = createDb(t);
  if (!db) return;
  const raw = "First line";
  const note = saveTranscriptNote(db, raw);
  const first = db.applyTranscriptRevision({
    noteId: note.id,
    expectedVersion: 0,
    sourceHash: hash(raw),
    operations: [{ kind: "replaceText", segmentId: "source-0", after: "First edited" }],
    description: "First edit",
  });
  db.applyTranscriptRevision({
    noteId: note.id,
    expectedVersion: first.version,
    sourceHash: hash(raw),
    operations: [{ kind: "replaceText", segmentId: "source-0", after: "Second edit" }],
    description: "Second edit",
  });

  const filename = db.db.name;
  db.db.close();
  db.db = new Database(filename);
  db.setActiveAccountId("transcript-account");
  const latest = db.getTranscriptWorkspace(note.id);
  assert.equal(latest.approvedOperations.length, 2);
  assert.equal(latest.approvedOperations[1].after, "Second edit");

  const restored = db.restoreTranscriptVersion(
    note.id,
    first.workspace.versions?.[0]?.versionId ?? first.workspace.versionId,
    2
  );
  assert.equal(restored.currentVersion, 3);
  assert.equal(restored.approvedOperations[0].after, "First edited");
  assert.deepEqual(
    db.listTranscriptVersions(note.id).map((version) => version.version),
    [0, 1, 2, 3]
  );
});

test("transcript overlay schema initialization is idempotent", (t) => {
  const db = createDb(t);
  if (!db) return;

  assert.doesNotThrow(() => db.initTranscriptStudioSchema());
  assert.doesNotThrow(() => db.initTranscriptStudioSchema());
  assert.equal(
    db.db
      .prepare(
        "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('transcript_workspaces', 'transcript_versions')"
      )
      .get().count,
    2
  );
  assert.ok(
    db.db
      .prepare("PRAGMA table_info(transcript_workspaces)")
      .all()
      .some((column) => column.name === "scope_key")
  );
  assert.ok(
    db.db
      .prepare("PRAGMA table_info(transcript_versions)")
      .all()
      .some((column) => column.name === "scope_key")
  );
});

test("legacy note-keyed overlay data migrates to the owning account scope without losing history", (t) => {
  const db = createDb(t);
  if (!db) return;
  const raw = "Legacy transcript";
  const note = saveTranscriptNote(db, raw, "legacy-owner");
  const teamSpace = db.db
    .prepare(
      "INSERT INTO spaces (client_space_id, kind, name, sort_order) VALUES (?, 'team', ?, 2)"
    )
    .run("legacy-transcript-team", "Legacy Team");
  const teamSpaceId = Number(teamSpace.lastInsertRowid);
  db.db
    .prepare("INSERT INTO space_accounts (space_id, account_id) VALUES (?, ?), (?, ?)")
    .run(teamSpaceId, "legacy-owner", teamSpaceId, "legacy-member");
  const teamNote = db.saveNote(
    "Legacy team transcript",
    "",
    "meeting",
    null,
    null,
    null,
    teamSpaceId,
    "Legacy team source"
  ).note;
  db.db.exec("DROP TABLE transcript_versions; DROP TABLE transcript_workspaces;");
  db.db.exec(`
    CREATE TABLE transcript_workspaces (
      note_id INTEGER PRIMARY KEY,
      source_hash TEXT NOT NULL,
      source_transcript TEXT NOT NULL,
      current_version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
    );
    CREATE TABLE transcript_versions (
      version_id TEXT PRIMARY KEY,
      note_id INTEGER NOT NULL,
      version INTEGER NOT NULL,
      source_hash TEXT NOT NULL,
      operations_json TEXT NOT NULL,
      description TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (note_id, version),
      FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_transcript_versions_note ON transcript_versions(note_id, version);
  `);
  const insertLegacyWorkspace = db.db.prepare(
    "INSERT INTO transcript_workspaces (note_id, source_hash, source_transcript, current_version) VALUES (?, ?, ?, 1)"
  );
  insertLegacyWorkspace.run(note.id, hash(raw), raw);
  insertLegacyWorkspace.run(teamNote.id, hash("Legacy team source"), "Legacy team source");
  db.db
    .prepare(
      "INSERT INTO transcript_versions (version_id, note_id, version, source_hash, operations_json, description) VALUES (?, ?, 1, ?, ?, ?)"
    )
    .run(
      "legacy-version-id",
      note.id,
      hash(raw),
      JSON.stringify([{ kind: "legacy" }]),
      "Legacy edit"
    );
  db.db
    .prepare(
      "INSERT INTO transcript_versions (version_id, note_id, version, source_hash, operations_json, description) VALUES (?, ?, 1, ?, ?, ?)"
    )
    .run(
      "legacy-team-version-id",
      teamNote.id,
      hash("Legacy team source"),
      JSON.stringify([{ kind: "team-legacy" }]),
      "Legacy team edit"
    );

  assert.doesNotThrow(() => db.initTranscriptStudioSchema());
  db.initTranscriptStudioSchema();
  const migrated = db.getTranscriptWorkspace(note.id);
  assert.equal(migrated.currentVersion, 1);
  assert.deepEqual(migrated.approvedOperations, [{ kind: "legacy" }]);
  assert.deepEqual(
    db.db.prepare("SELECT scope_key FROM transcript_workspaces WHERE note_id = ?").get(note.id),
    { scope_key: "account:legacy-owner" }
  );
  assert.equal(db.listTranscriptVersions(note.id)[1].versionId, "legacy-version-id");

  db.setActiveAccountId("legacy-member");
  const isolatedTeam = db.getTranscriptWorkspace(teamNote.id);
  assert.equal(isolatedTeam.currentVersion, 0);
  assert.deepEqual(isolatedTeam.approvedOperations, []);
  assert.equal(db.listTranscriptVersions(teamNote.id).length, 1);
  assert.deepEqual(
    db.db.prepare("SELECT scope_key FROM transcript_workspaces WHERE note_id = ?").get(teamNote.id),
    { scope_key: "local:legacy" }
  );
  assert.equal(
    db.db
      .prepare(
        "SELECT count(*) AS count FROM transcript_versions WHERE note_id = ? AND scope_key = 'local:legacy'"
      )
      .get(teamNote.id).count,
    1,
    "old unscoped team history is preserved without showing it to every team member"
  );
});
