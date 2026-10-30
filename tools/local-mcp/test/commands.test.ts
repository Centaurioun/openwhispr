import assert from "node:assert/strict";
import test from "node:test";
import { createLocalCommands } from "../src/commands.js";

const note = {
  id: 7,
  title: "Synthetic note",
  content: "Only synthetic content",
  transcript: '[{"text":"Original words"}]',
  transcript_studio: {
    approved: { status: "available", version: 2, text: "Approved words" },
  },
};

function commandsFor(payload: unknown) {
  const calls: string[][] = [];
  const commands = createLocalCommands(async (args) => {
    calls.push([...args]);
    return payload;
  });
  return { commands, calls };
}

test("listNotes uses the fixed local JSON command and returns only note summaries", async () => {
  const { commands, calls } = commandsFor({
    data: [{ id: 7, title: "Synthetic note", content: "private body", transcript: "private transcript" }],
  });

  assert.deepEqual(await commands.listNotes({ limit: 12 }), [{ id: 7, title: "Synthetic note" }]);
  assert.deepEqual(calls, [["notes", "list", "--limit", "12", "--format", "json"]]);
});

test("searchNotes passes metacharacters as one literal argv value", async () => {
  const { commands, calls } = commandsFor({ data: [{ id: 7, title: "Synthetic note" }] });
  const query = "meeting; touch /tmp/not-run";

  await commands.searchNotes({ query, limit: 3 });

  assert.deepEqual(calls, [["notes", "search", query, "--limit", "3", "--format", "json"]]);
});

test("getNote returns a validated note record using the documented local command", async () => {
  const { commands, calls } = commandsFor({ data: note });

  assert.deepEqual(await commands.getNote({ id: 7 }), note);
  assert.deepEqual(calls, [["notes", "get", "7", "--format", "json"]]);
});

test("getNoteTranscript explicitly selects original or approved text", async () => {
  const { commands, calls } = commandsFor({ data: note });

  assert.deepEqual(await commands.getNoteTranscript({ id: 7, version: "original" }), {
    noteId: 7,
    version: "original",
    text: note.transcript,
  });
  assert.deepEqual(await commands.getNoteTranscript({ id: 7, version: "approved" }), {
    noteId: 7,
    version: "approved",
    text: "Approved words",
  });
  assert.deepEqual(calls, [
    ["notes", "get", "7", "--format", "json"],
    ["notes", "get", "7", "--format", "json"],
  ]);
});

test("stale or malformed approved transcripts fail closed while Original remains readable", async () => {
  const stale = commandsFor({
    data: { ...note, transcript_studio: { approved: { status: "stale" } } },
  }).commands;
  assert.equal(
    (await stale.getNoteTranscript({ id: 7, version: "original" })).text,
    note.transcript,
  );
  await assert.rejects(stale.getNoteTranscript({ id: 7, version: "approved" }), /approved transcript unavailable/i);

  const malformed = commandsFor({ data: { ...note, transcript_studio: { approved: { status: "available", text: 3 } } } }).commands;
  await assert.rejects(malformed.getNoteTranscript({ id: 7, version: "approved" }), /approved transcript unavailable/i);
});

test("note IDs, limits, queries, JSON shapes, and ID mismatches are rejected", async () => {
  const { commands } = commandsFor({ data: { id: 8, title: "Other note" } });

  await assert.rejects(commands.getNote({ id: -1 }), /invalid note id/i);
  await assert.rejects(commands.listNotes({ limit: 0 }), /limit/i);
  await assert.rejects(commands.searchNotes({ query: "   " }), /query/i);
  await assert.rejects(commands.getNote({ id: 7 }), /invalid note response/i);
  await assert.rejects(commands.listNotes({ limit: 1 }).then(() => undefined), /invalid notes response/i);
});

test("transcription history is not exposed until its database routes enforce active-account scope", () => {
  const { commands } = commandsFor({ data: [] });
  assert.equal("listTranscriptions" in commands, false);
  assert.equal("getTranscription" in commands, false);
});
