import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CliAdapterError, createCliInvoker } from "../src/cliAdapter.js";
import { createMcpServer, startupCheck } from "../src/server.js";

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: (signal?: NodeJS.Signals) => void;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  return child;
}

async function withClient<T>(
  commands: Parameters<typeof createMcpServer>[0],
  run: (client: Client) => Promise<T>,
) {
  const server = createMcpServer(commands);
  const client = new Client({ name: "local-mcp-security-test", version: "0.0.0" });
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

test("bridge-unavailable CLI exit gives actionable guidance without exposing stderr", async () => {
  const child = fakeChild();
  const invoke = createCliInvoker({
    spawnImpl: () => {
      queueMicrotask(() => {
        child.stderr.end("private transcript and bearer-token sentinel");
        child.emit("close", 2, null);
      });
      return child as unknown as ChildProcess;
    },
  });

  await assert.rejects(invoke(["notes", "list", "--limit", "1", "--format", "json"]), (error: unknown) => {
    assert.ok(error instanceof CliAdapterError);
    assert.equal(error.code, "CLI_EXIT");
    assert.equal(error.exitCode, 2);
    assert.match(error.message, /desktop app|local bridge/i);
    assert.doesNotMatch(error.message, /private transcript|bearer-token sentinel/i);
    return true;
  });
});

test("startupCheck verifies one bounded local notes read and returns no note data", async () => {
  const calls: string[][] = [];
  const check = await startupCheck(async (args) => {
    calls.push([...args]);
    return { data: [{ id: 1, title: "Private note sentinel" }] };
  });

  assert.deepEqual(check, { ok: true });
  assert.deepEqual(calls, [["notes", "list", "--limit", "1", "--format", "json"]]);
  assert.equal(JSON.stringify(check).includes("Private note sentinel"), false);
});

test("startupCheck fails closed with a safe actionable reason", async () => {
  const check = await startupCheck(async () => {
    throw new CliAdapterError(
      "CLI_EXIT",
      "The local OpenWhispr desktop app or bridge is unavailable.",
      2,
    );
  });

  assert.equal(check.ok, false);
  if (!check.ok) {
    assert.match(check.reason, /openwhispr desktop app|local bridge/i);
    assert.doesNotMatch(check.reason, /transcript|token|stderr/i);
  }
});

test("CLI failure makes one local attempt and never falls back to remote", async () => {
  const child = fakeChild();
  const observed: string[][] = [];
  const invoke = createCliInvoker({
    spawnImpl: (_command, args) => {
      observed.push(args);
      queueMicrotask(() => {
        child.stderr.end("bridge missing");
        child.emit("close", 2, null);
      });
      return child as unknown as ChildProcess;
    },
  });

  await assert.rejects(invoke(["notes", "list"]));
  assert.equal(observed.length, 1);
  assert.equal(observed[0]?.[0], "--local");
  assert.equal(observed.flat().some((argument) => argument === "--remote" || argument.startsWith("--remote=")), false);
});

test("only annotated read-only MCP tools are exposed; no mutation methods are registered", async () => {
  const commands = {
    listNotes: async () => [],
    searchNotes: async () => [],
    getNote: async ({ id }: { id: number }) => ({ id, title: "Synthetic" }),
    getNoteTranscript: async ({ id, version }: { id: number; version: "original" | "approved" }) => ({
      noteId: id,
      version,
      text: "Synthetic transcript",
    }),
  } as unknown as Parameters<typeof createMcpServer>[0];

  const tools = await withClient(commands, (client) => client.listTools());

  assert.deepEqual(
    tools.tools.map(({ name }) => name).sort(),
    ["get_note", "get_note_transcript_page", "list_notes", "search_notes"],
  );
  assert.ok(tools.tools.every((tool) => tool.annotations?.readOnlyHint === true));
  assert.ok(tools.tools.every((tool) => tool.annotations?.destructiveHint === false));
});

test("note text is returned only in the requested result and never logged", async () => {
  const marker = "private-transcript-log-sentinel";
  const commands = {
    listNotes: async () => [{ id: 1, title: "Synthetic" }],
    searchNotes: async () => [{ id: 1, title: "Synthetic" }],
    getNote: async ({ id }: { id: number }) => ({ id, title: "Synthetic", content: "Synthetic body" }),
    getNoteTranscript: async ({ id, version }: { id: number; version: "original" | "approved" }) => ({
      noteId: id,
      version,
      text: marker,
    }),
  } as unknown as Parameters<typeof createMcpServer>[0];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const logged: string[] = [];
  console.log = (...args: unknown[]) => logged.push(args.join(" "));
  console.warn = (...args: unknown[]) => logged.push(args.join(" "));
  console.error = (...args: unknown[]) => logged.push(args.join(" "));

  try {
    const result = await withClient(commands, (client) =>
      client.callTool({
        name: "get_note_transcript_page",
        arguments: { note_id: 1, version: "original" },
      }),
    );
    assert.match(JSON.stringify(result), new RegExp(marker));
    assert.equal(logged.some((entry) => entry.includes(marker)), false);
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
});
