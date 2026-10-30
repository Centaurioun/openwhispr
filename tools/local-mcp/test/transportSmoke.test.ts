import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transcript = "Original synthetic text 👋";
const note = {
  id: 31,
  title: "Transport fixture",
  content: "Synthetic note body",
  note_type: "meeting",
  created_at: "2026-10-30",
  transcript,
  transcript_studio: {
    approved: { status: "available", version: 1, text: "Approved synthetic text 👋" },
  },
};

test("MCP server completes real stdio handshake, discovery, notes and transcript paging", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openwhispr-mcp-stdio-"));
  const binDir = path.join(tempRoot, "bin");
  await mkdir(binDir, { recursive: true });
  const packageDir = path.join(tempRoot, "Packaged Local MCP");
  await mkdir(packageDir, { recursive: true });
  const entryPoint = path.join(packageDir, "server with spaces.ts");
  await symlink(path.resolve("src/server.ts"), entryPoint);
  const fakeCli = path.join(binDir, "openwhispr");
  const fakeCliSource = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] !== "--local") process.exit(22);
const command = args.slice(1);
const note = ${JSON.stringify(note)};
if (command[0] !== "notes") process.exit(23);
if (command[1] === "list" || command[1] === "search") process.stdout.write(JSON.stringify([note]));
else if (command[1] === "get" && command[2] === String(note.id)) process.stdout.write(JSON.stringify(note));
else process.exit(24);
`;
  await writeFile(fakeCli, fakeCliSource, "utf8");
  await chmod(fakeCli, 0o700);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", entryPoint],
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: tempRoot,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "synthetic-stdio-smoke", version: "0.0.0" });
  t.after(async () => {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    await rm(tempRoot, { recursive: true, force: true });
  });

  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map(({ name }) => name).sort(),
    ["get_note", "get_note_transcript_page", "list_notes", "search_notes"],
  );

  const list = await client.callTool({ name: "list_notes", arguments: { limit: 5 } });
  assert.match(JSON.stringify(list), /Transport fixture/);

  const original = await client.callTool({
    name: "get_note_transcript_page",
    arguments: { note_id: 31, version: "original", offset: 0, page_size: 8 },
  });
  assert.deepEqual(JSON.parse(readText(original)), {
    note_id: 31,
    version: "original",
    text: "Original",
    start: 0,
    end: 8,
    has_more: true,
  });

  const approved = await client.callTool({
    name: "get_note_transcript_page",
    arguments: { note_id: 31, version: "approved", offset: 0, page_size: 8 },
  });
  assert.equal(JSON.parse(readText(approved)).text, "Approved");
});

function readText(result: unknown): string {
  assert.ok(typeof result === "object" && result !== null && "content" in result);
  const content = (result as { content: unknown }).content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { text?: unknown } | undefined;
  assert.ok(first);
  assert.equal(typeof first.text, "string");
  return first.text as string;
}
