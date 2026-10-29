const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const Database = require("better-sqlite3");
const { createDb } = require("./harness/db.js");
const { createRendererServer } = require("../lib/rendererTestHarness");
const { formatSrt } = require("../../src/helpers/transcriptFormatter.js");

const hash = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const DOM_GLOBALS = [
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "MutationObserver",
  "getComputedStyle",
  "Event",
  "CustomEvent",
  "MouseEvent",
  "FocusEvent",
  "KeyboardEvent",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "ResizeObserver",
];

let happyWindow;
let React;
let vite;
let TranscriptStudioView;
let normalizeTranscriptSource;
let resolveTranscriptForUse;
let startTranscriptEditJob;

test.before(async (t) => {
  const { Window } = await import("happy-dom");
  happyWindow = new Window();
  const define = (name, value) =>
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  define("window", happyWindow);
  for (const name of DOM_GLOBALS) define(name, happyWindow[name]);
  for (const name of ["requestAnimationFrame", "cancelAnimationFrame"])
    define(name, happyWindow[name].bind(happyWindow));
  React = require("react");
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vite = await createRendererServer(t);
  ({ TranscriptStudioView } = await vite.ssrLoadModule(
    "/custom-features/transcript-studio/components/TranscriptStudioView.tsx"
  ));
  ({ normalizeTranscriptSource } = await vite.ssrLoadModule(
    "/custom-features/transcript-studio/domain/normalizeSource.ts"
  ));
  ({ resolveTranscriptForUse } = await vite.ssrLoadModule(
    "/custom-features/transcript-studio/domain/transcriptResolver.ts"
  ));
  ({ startTranscriptEditJob } = await vite.ssrLoadModule(
    "/custom-features/transcript-studio/process/transcriptEditJob.ts"
  ));
});

test.after(async () => {
  await happyWindow?.happyDOM.close();
});

function saveNote(db, transcript, accountId = "acceptance-owner") {
  db.setActiveAccountId(accountId);
  return db.saveNote("Synthetic meeting", "", "meeting", null, null, null, null, transcript).note;
}

function acceptanceSegments(durationSeconds) {
  return Array.from({ length: durationSeconds }, (_, index) => ({
    timestamp: index,
    endTimestamp: index + 1,
    source: index % 2 === 0 ? "mic" : "system",
    speaker: index % 2 === 0 ? "speaker_1" : "speaker_2",
    speakerName: index % 2 === 0 ? "Ada" : "Grace",
    speakerLocked: index === 11,
    text:
      index === 0
        ? "İstanbul'da OpenAI, Dr. Ada Lovelace ile konuştu; toplam 3,14 ve 42,75 olarak kaydedildi."
        : `Synthetic utterance ${index}`,
  }));
}

async function assertLongTranscriptStable(t, durationSeconds) {
  const db = createDb(t);
  if (!db) return;
  const isPlainText = durationSeconds === 3_600;
  const raw = isPlainText
    ? [
        "İstanbul'da OpenAI, Dr. Ada Lovelace ile konuştu; toplam 3,14 ve 42,75 olarak kaydedildi.",
        ...Array.from(
          { length: durationSeconds - 1 },
          (_, index) => `Synthetic utterance ${index + 1}`
        ),
      ].join("\n")
    : JSON.stringify(acceptanceSegments(durationSeconds));
  const note = saveNote(db, raw);
  const source = await normalizeTranscriptSource(raw);
  const editIndex = isPlainText ? 0 : durationSeconds - 1;
  const before = source.segments[editIndex].text;
  const after = isPlainText
    ? before.replace("3,14", "3,15")
    : `Edited at ${durationSeconds} seconds: İğdır 2,75`;
  const saved = db.applyTranscriptRevision({
    noteId: note.id,
    expectedVersion: 0,
    sourceHash: source.sourceHash,
    operations: [
      {
        kind: "replaceText",
        segmentId: source.segments[editIndex].id,
        before,
        after,
      },
    ],
    description: `Synthetic ${durationSeconds}-second revision`,
  });
  assert.equal(saved.version, 1);

  // A closed/reopened temporary SQLite handle models process exit/restart without
  // touching Electron userData, an installed app, or a real profile.
  const filename = db.db.name;
  db.db.close();
  db.db = new Database(filename);
  db.setActiveAccountId("acceptance-owner");
  const resolved = await resolveTranscriptForUse(note.id, "display", "approved", db);

  assert.equal(resolved.sourceHash, source.sourceHash);
  assert.equal(resolved.segments.length, isPlainText ? 1 : durationSeconds);
  const actualSegments = resolved.segments.map((segment) => ({
    id: segment.id,
    text: segment.text,
    source: segment.source ?? null,
    speakerId: segment.speakerId,
    speakerName: segment.speakerName,
    startSeconds: segment.startSeconds,
    endSeconds: segment.endSeconds,
    speakerLocked: segment.speakerLocked,
    sourceIndex: segment.sourceIndex,
  }));
  const expectedSegments = isPlainText
    ? [
        {
          id: `source-${source.sourceHash.slice(0, 16)}-0`,
          text: after,
          source: null,
          speakerId: null,
          speakerName: null,
          startSeconds: null,
          endSeconds: null,
          speakerLocked: false,
          sourceIndex: 0,
        },
      ]
    : acceptanceSegments(durationSeconds).map((segment, index) => ({
        id: `source-${source.sourceHash.slice(0, 16)}-${index}`,
        text: index === editIndex ? after : segment.text,
        source: segment.source,
        speakerId: segment.speaker,
        speakerName: segment.speakerName,
        startSeconds: segment.timestamp,
        endSeconds: segment.endTimestamp,
        speakerLocked: segment.speakerLocked,
        sourceIndex: index,
      }));
  assert.deepEqual(actualSegments, expectedSegments, "every normalized segment survives reopen");
  if (isPlainText) {
    assert.equal(resolved.segments[0].text, after);
    assert.equal(resolved.segments[0].startSeconds, null);
  } else {
    assert.equal(resolved.segments[0].text, acceptanceSegments(durationSeconds)[0].text);
    assert.equal(resolved.segments[11].speakerLocked, true);
    const middleIndex = Math.floor(durationSeconds / 2);
    const corruptedMiddle = actualSegments.map((segment, index) =>
      index === middleIndex ? { ...segment, text: `${segment.text} (corrupted)` } : segment
    );
    assert.throws(
      () => assert.deepEqual(corruptedMiddle, expectedSegments),
      assert.AssertionError,
      "the full-list comparison must catch corruption in a middle segment"
    );
  }
  assert.equal(resolved.segments[editIndex].text, after);
  assert.equal(db.getNote(note.id).transcript, raw, "approved edits never rewrite source data");
  assert.equal(db.getTranscriptWorkspace(note.id).currentVersion, 1);
}

test("one-hour plain transcript keeps Unicode, entities, decimals, and approvals after restart", async (t) => {
  await assertLongTranscriptStable(t, 3_600);
});

test("two-hour multi-speaker transcript keeps timed segments, locks, and approved edits after restart", async (t) => {
  await assertLongTranscriptStable(t, 7_200);
});

test("a committed edit survives an abrupt child-process exit and database restart", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const raw = '[{"text":"Before the simulated crash"}]';
  const note = saveNote(db, raw);
  const source = await normalizeTranscriptSource(raw);
  const filename = db.db.name;
  const repoRoot = process.cwd();
  db.db.close();

  const childSource = `
    const { installElectronStub, setUserDataDir } = require(process.env.QA_REPO + "/test/helpers/harness/electronStub.js");
    installElectronStub();
    setUserDataDir(process.env.QA_USER_DATA);
    const DatabaseManager = require(process.env.QA_REPO + "/src/helpers/database.js");
    const db = new DatabaseManager();
    db.setActiveAccountId("acceptance-owner");
    if (db.db.name !== process.env.QA_DB_PATH) throw new Error("Child opened an unexpected database");
    const result = db.applyTranscriptRevision({
      noteId: Number(process.env.QA_NOTE_ID),
      expectedVersion: 0,
      sourceHash: process.env.QA_SOURCE_HASH,
      operations: [{
        kind: "replaceText",
        segmentId: process.env.QA_SEGMENT_ID,
        before: "Before the simulated crash",
        after: "Committed before abrupt exit",
      }],
      description: "Synthetic crash recovery fixture",
    });
    if (result.version !== 1) throw new Error("Synthetic revision did not commit");
    process.exit(86);
  `;
  const child = spawnSync(process.execPath, ["-e", childSource], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      QA_REPO: repoRoot,
      QA_USER_DATA: require("node:path").dirname(filename),
      QA_DB_PATH: filename,
      QA_NOTE_ID: String(note.id),
      QA_SOURCE_HASH: source.sourceHash,
      QA_SEGMENT_ID: source.segments[0].id,
    },
  });

  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 86, child.stderr);
  db.db = new Database(filename);
  db.setActiveAccountId("acceptance-owner");
  const workspace = db.getTranscriptWorkspace(note.id);
  assert.equal(workspace.currentVersion, 1);
  assert.equal(workspace.approvedOperations[0].after, "Committed before abrupt exit");
  assert.equal(db.getNote(note.id).transcript, raw);
});

test("two database windows serialize stale writes and a user switch loses access", (t) => {
  const firstWindow = createDb(t);
  if (!firstWindow) return;
  const filename = firstWindow.db.name;
  // createDb installs the Electron test stub before loading DatabaseManager;
  // reusing that cached class makes the second handle point at the same tmp DB.
  const DatabaseManager = require("../../src/helpers/database.js");
  const secondWindow = new DatabaseManager();
  t.after(() => secondWindow.db?.close());
  const raw = '[{"text":"Original line"}]';
  const note = saveNote(firstWindow, raw);
  secondWindow.setActiveAccountId("acceptance-owner");

  const expectedSourceHash = hash(raw);
  const first = firstWindow.applyTranscriptRevision({
    noteId: note.id,
    expectedVersion: 0,
    sourceHash: expectedSourceHash,
    operations: [
      {
        kind: "replaceText",
        segmentId: `source-${expectedSourceHash.slice(0, 16)}-0`,
        before: "Original line",
        after: "First window edit",
      },
    ],
    description: "First window",
  });
  const stale = secondWindow.applyTranscriptRevision({
    noteId: note.id,
    expectedVersion: 0,
    sourceHash: expectedSourceHash,
    operations: [
      {
        kind: "replaceText",
        segmentId: `source-${expectedSourceHash.slice(0, 16)}-0`,
        before: "Original line",
        after: "Stale second window edit",
      },
    ],
    description: "Stale second window",
  });

  assert.equal(firstWindow.db.name, filename);
  assert.equal(first.version, 1);
  assert.deepEqual(stale, { conflict: true });
  assert.equal(
    firstWindow.getTranscriptWorkspace(note.id).approvedOperations[0].after,
    "First window edit"
  );

  secondWindow.setActiveAccountId("different-account");
  assert.throws(() => secondWindow.getTranscriptWorkspace(note.id), /inaccessible|not found/i);
});

test("team transcript edit permission changes are honored on the next check", (t) => {
  const db = createDb(t);
  if (!db) return;
  const spaceId = Number(
    db.db
      .prepare(
        "INSERT INTO spaces (client_space_id, kind, name, sort_order, capabilities) VALUES (?, 'team', ?, 1, ?)"
      )
      .run("synthetic-acceptance-space", "Synthetic", JSON.stringify({ edit_notes: true }))
      .lastInsertRowid
  );
  db.db
    .prepare("INSERT INTO space_accounts (space_id, account_id) VALUES (?, ?)")
    .run(spaceId, "acceptance-owner");
  db.setActiveAccountId("acceptance-owner");
  const note = db.saveNote(
    "Synthetic team meeting",
    "",
    "meeting",
    null,
    null,
    null,
    spaceId,
    "Line"
  ).note;

  assert.equal(db.getTranscriptEditAuthority(note.id).canEdit, true);
  db.db
    .prepare("UPDATE spaces SET capabilities = ? WHERE id = ?")
    .run(JSON.stringify({ edit_notes: false }), spaceId);
  assert.equal(db.getTranscriptEditAuthority(note.id).canEdit, false);
});

test("unsorted or missing timestamps stay missing and SRT does not invent cue positions", async () => {
  const raw = JSON.stringify([
    { timestamp: 5, text: "İstanbul 3,14" },
    { timestamp: 1, text: "Named entity: Ada" },
    { text: "No fabricated time" },
  ]);
  const resolved = await resolveTranscriptForUse(18, "export", "original", {
    getTranscriptWorkspace: async () => ({
      noteId: 18,
      sourceTranscript: raw,
      sourceHash: hash(raw),
      baselineSourceHash: hash(raw),
      currentVersion: 0,
      approvedOperations: [],
      stale: false,
    }),
  });

  assert.deepEqual(
    resolved.segments.map(({ text, startSeconds }) => [text, startSeconds]),
    [
      ["İstanbul 3,14", 5],
      ["Named entity: Ada", 1],
      ["No fabricated time", null],
    ]
  );
  assert.equal(
    formatSrt(
      resolved.segments.map((segment) => ({
        text: segment.text,
        timestamp: segment.startSeconds,
      })),
      {},
      {}
    ),
    ""
  );
});

async function mountTranscriptStudio(
  t,
  props,
  workspace,
  ready = (host) => host.querySelector("textarea")
) {
  const { createRoot } = require("react-dom/client");
  happyWindow.electronAPI = {
    getTranscriptWorkspace: async () => workspace,
    listTranscriptVersions: async () => [
      {
        versionId: `baseline:${workspace.sourceHash}`,
        version: 0,
        description: "Original transcript",
        createdAt: null,
      },
    ],
    getTranscriptVersion: async () => ({
      versionId: `baseline:${workspace.sourceHash}`,
      version: 0,
      description: "Original transcript",
      createdAt: null,
      sourceHash: workspace.sourceHash,
      operations: [],
    }),
    applyTranscriptRevision: async () => ({ conflict: true }),
    restoreTranscriptVersion: async () => workspace,
  };
  const host = happyWindow.document.createElement("div");
  happyWindow.document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await React.act(async () => root.unmount());
    host.remove();
  });
  await React.act(async () => root.render(React.createElement(TranscriptStudioView, props)));
  for (let attempt = 0; attempt < 500 && !ready(host); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  await React.act(async () => {});
  return host;
}

test("corrupt approved overlay falls back to the original transcript with an error", async (t) => {
  const raw = '[{"text":"Safe original line"}]';
  const source = await normalizeTranscriptSource(raw);
  const workspace = {
    noteId: 31,
    sourceTranscript: raw,
    originalTranscript: raw,
    sourceHash: source.sourceHash,
    baselineSourceHash: source.sourceHash,
    currentVersion: 1,
    versionId: "corrupt-overlay",
    approvedOperations: [
      {
        kind: "replaceText",
        segmentId: "missing-segment-id",
        before: "Safe original line",
        after: "Corrupt edit",
      },
    ],
    stale: false,
  };
  const host = await mountTranscriptStudio(
    t,
    { noteId: 31, sourceTranscript: raw, canEdit: true },
    workspace,
    (container) =>
      container.querySelector("textarea")?.value === "Safe original line" &&
      /showing the original transcript/i.test(container.textContent)
  );

  assert.equal(host.querySelector("textarea")?.value, "Safe original line");
  assert.match(host.textContent, /showing the original transcript/i);
});

async function events(job) {
  const values = [];
  for await (const event of job) values.push(event);
  return values;
}

function jobRuntime(overrides = {}) {
  return {
    captureContext: async () => "account-1",
    contextIsCurrent: async () => true,
    getSourceSegments: async () => [
      {
        id: "segment-1",
        text: "Synthetic transcript with Ada and 42,75",
        speakerId: "speaker-1",
        speakerName: "Ada",
        speakerLocked: true,
        sourceIndex: 0,
      },
    ],
    confirmRemote: async () => false,
    maxInputTokens: 1024,
    processChunk: async () => '{"segments":[{"id":"segment-1","text":"unchanged"}]}',
    ...overrides,
  };
}

test("remote transcript text is not sent when the user has not granted consent", async () => {
  let providerCalls = 0;
  const result = await events(
    startTranscriptEditJob({
      noteId: 5,
      sourceHash: "synthetic-hash",
      providerChoice: "openai",
      strictMode: true,
      runtime: jobRuntime({
        processChunk: async () => {
          providerCalls += 1;
          return "{}";
        },
      }),
    })
  );

  assert.equal(providerCalls, 0);
  assert.ok(result.some((event) => /no transcript text was sent/i.test(event.message ?? "")));
  assert.equal(result.at(-1).cancelled, true);
});

test("cancellation during provider work discards its late proposal", async () => {
  const controller = new AbortController();
  let transferredText;
  const result = await events(
    startTranscriptEditJob({
      noteId: 5,
      sourceHash: "synthetic-hash",
      providerChoice: "local",
      strictMode: true,
      signal: controller.signal,
      runtime: jobRuntime({
        processChunk: async (text) => {
          transferredText = text;
          controller.abort();
          return JSON.stringify({
            segments: [{ id: "segment-1", text: "Late changed words" }],
          });
        },
      }),
    })
  );

  assert.match(transferredText, /Synthetic transcript/);
  assert.equal(
    result.some((event) => event.type === "chunkProposed"),
    false
  );
  assert.equal(result.at(-1).cancelled, true);
});
