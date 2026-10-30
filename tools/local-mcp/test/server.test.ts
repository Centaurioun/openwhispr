import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/server.js";

const syntheticTranscript = "A👋B";

function fakeCommands() {
  const calls: string[] = [];
  const commands = {
    async listNotes({ limit }: { limit?: number } = {}) {
      calls.push(`list:${limit}`);
      return [{ id: 1, title: "Synthetic note" }];
    },
    async searchNotes({ query, limit }: { query: string; limit?: number }) {
      calls.push(`search:${query}:${limit}`);
      return [{ id: 1, title: "Synthetic note" }];
    },
    async getNote({ id }: { id: number }) {
      calls.push(`note:${id}`);
      return { id, title: "Synthetic note", content: "Synthetic note body", transcript: syntheticTranscript };
    },
    async getNoteTranscript({ id, version }: { id: number; version: "original" | "approved" }) {
      calls.push(`transcript:${id}:${version}`);
      return { noteId: id, version, text: syntheticTranscript };
    },
  };
  return { commands, calls };
}

function firstText(result: unknown): string {
  assert.ok(typeof result === "object" && result !== null && "content" in result);
  const content = (result as { content: unknown }).content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { text?: unknown } | undefined;
  assert.ok(first);
  assert.equal(typeof first.text, "string");
  return first.text as string;
}

async function withClient<T>(commands: ReturnType<typeof fakeCommands>["commands"], run: (client: Client) => Promise<T>) {
  const server = createMcpServer(commands);
  const client = new Client({ name: "local-mcp-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

test("MCP handshake discovers only four read-only local tools", async () => {
  const { commands } = fakeCommands();

  const tools = await withClient(commands, async (client) => client.listTools());

  assert.deepEqual(
    tools.tools.map(({ name }) => name).sort(),
    ["get_note", "get_note_transcript_page", "list_notes", "search_notes"],
  );
  assert.ok(tools.tools.every((tool) => tool.description?.includes("local")));
});

test("list, search, and note tools call fixed read-only command methods", async () => {
  const { commands, calls } = fakeCommands();

  const results = await withClient(commands, async (client) => {
    const list = await client.callTool({ name: "list_notes", arguments: { limit: 5 } });
    const search = await client.callTool({ name: "search_notes", arguments: { query: "test; touch /tmp/x", limit: 4 } });
    const note = await client.callTool({ name: "get_note", arguments: { note_id: 1 } });
    return { list, search, note };
  });

  assert.deepEqual(calls, ["list:5", "search:test; touch /tmp/x:4", "note:1"]);
  assert.equal(JSON.parse(firstText(results.list)).length, 1);
  assert.equal(JSON.parse(firstText(results.search)).length, 1);
  const note = JSON.parse(firstText(results.note));
  assert.equal(note.id, 1);
  assert.equal("transcript" in note, false, "full transcript must use the paged transcript tool");
});

test("transcript tool uses explicit Original/Approved selection and returns bounded pages", async () => {
  const { commands, calls } = fakeCommands();

  const result = await withClient(commands, async (client) =>
    client.callTool({
      name: "get_note_transcript_page",
      arguments: { note_id: 2, version: "approved", offset: 1, page_size: 1 },
    }),
  );

  assert.deepEqual(calls, ["transcript:2:approved"]);
  const page = JSON.parse(firstText(result));
  assert.deepEqual(page, { note_id: 2, version: "approved", text: "👋", start: 1, end: 2, has_more: true });
  assert.equal(result.isError, undefined);
});

test("MCP input schemas reject unknown keys and invalid transcript selection", async () => {
  const { commands } = fakeCommands();

  const results = await withClient(commands, async (client) => {
    const extra = await client.callTool({ name: "list_notes", arguments: { limit: 5, path: "/tmp" } });
    const badVersion = await client.callTool({
      name: "get_note_transcript_page",
      arguments: { note_id: 1, version: "latest" },
    });
    return { extra, badVersion };
  });

  assert.equal(results.extra.isError, true);
  assert.equal(results.badVersion.isError, true);
});

test("approved transcript errors fail closed as MCP tool errors", async () => {
  const commands = {
    ...fakeCommands().commands,
    async getNoteTranscript() {
      throw new Error("Approved transcript unavailable; select Original.");
    },
  };

  const result = await withClient(commands, (client) =>
    client.callTool({
      name: "get_note_transcript_page",
      arguments: { note_id: 1, version: "approved" },
    }),
  );

  assert.equal(result.isError, true);
  assert.match(firstText(result), /approved transcript unavailable/i);
});
