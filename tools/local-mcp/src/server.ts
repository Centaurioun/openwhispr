import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createLocalCommands, localCommands, type LocalCliInvoker, type LocalNote } from "./commands.js";
import { CliAdapterError, invokeLocalCli } from "./cliAdapter.js";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, pageTranscript } from "./transcriptPaging.js";

const NOTE_LIMIT = 100;
const MAX_NOTE_RESPONSE_BYTES = 64_000;
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

type LocalCommands = typeof localCommands;

export type StartupCheckResult = { ok: true } | { ok: false; reason: string };

/** Verify the explicit local bridge once, discarding the bounded note-list result. */
export async function startupCheck(invoke: LocalCliInvoker = invokeLocalCli): Promise<StartupCheckResult> {
  try {
    await createLocalCommands(invoke).listNotes({ limit: 1 });
    return { ok: true };
  } catch (error) {
    if (error instanceof CliAdapterError && error.code === "CLI_EXIT" && error.exitCode === 2) {
      return {
        ok: false,
        reason: "The OpenWhispr desktop app or its local bridge is unavailable. Open the desktop app and retry.",
      };
    }
    if (error instanceof CliAdapterError && error.code === "SPAWN_ERROR") {
      return {
        ok: false,
        reason: "The local OpenWhispr CLI could not start. Install the CLI and open the desktop app, then retry.",
      };
    }
    if (error instanceof CliAdapterError && error.code === "TIMEOUT") {
      return { ok: false, reason: "The local OpenWhispr bridge timed out. Open the desktop app and retry." };
    }
    return {
      ok: false,
      reason: "The local OpenWhispr check failed. Open the desktop app and confirm its CLI version; no remote fallback was attempted.",
    };
  }
}

/** Creates a local-only stdio MCP server; the injectable command layer is for synthetic tests. */
export function createMcpServer(commands: LocalCommands = localCommands): McpServer {
  const server = new McpServer(
    { name: "OpenWhispr Local MCP", version: "0.1.0" },
    { capabilities: { tools: {} }, maxToolInputElements: 64 },
  );

  server.registerTool(
    "list_notes",
    {
      title: "List local OpenWhispr notes",
      description: "Read note titles and dates from the active local OpenWhispr account. Local-only, read-only.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(NOTE_LIMIT).optional() }).strict(),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ limit }) => runTool(() => commands.listNotes({ limit })),
  );

  server.registerTool(
    "search_notes",
    {
      title: "Search local OpenWhispr notes",
      description: "Search notes in the active local OpenWhispr account. Local-only, read-only.",
      inputSchema: z
        .object({
          query: z.string().trim().min(1).max(500),
          limit: z.number().int().min(1).max(NOTE_LIMIT).optional(),
        })
        .strict(),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ query, limit }) => runTool(() => commands.searchNotes({ query, limit })),
  );

  server.registerTool(
    "get_note",
    {
      title: "Read a local OpenWhispr note",
      description:
        "Read note text and metadata from the active local OpenWhispr account. Transcript content is available separately through the paged transcript tool. Local-only, read-only.",
      inputSchema: z.object({ note_id: z.number().int().positive().safe() }).strict(),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ note_id }) =>
      runTool(async () => {
        const note = await commands.getNote({ id: note_id });
        const result = noteForMcp(note);
        const serialized = JSON.stringify(result);
        if (Buffer.byteLength(serialized, "utf8") > MAX_NOTE_RESPONSE_BYTES) {
          throw new Error("Note is too large for one response; use note search or open it in OpenWhispr.");
        }
        return result;
      }),
  );

  server.registerTool(
    "get_note_transcript_page",
    {
      title: "Read a local transcript page",
      description:
        "Read one bounded page from a local transcript. Choose Original or Approved explicitly; stale or invalid Approved revisions are refused. Local-only, read-only.",
      inputSchema: z
        .object({
          note_id: z.number().int().positive().safe(),
          version: z.enum(["original", "approved"]),
          offset: z.number().int().nonnegative().safe().default(0),
          page_size: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
        })
        .strict(),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ note_id, version, offset, page_size }) =>
      runTool(async () => {
        const transcript = await commands.getNoteTranscript({ id: note_id, version });
        const page = pageTranscript(transcript.text, offset, page_size);
        return {
          note_id: transcript.noteId,
          version: transcript.version,
          text: page.text,
          start: page.start,
          end: page.end,
          has_more: page.hasMore,
        };
      }),
  );

  return server;
}

export async function runStdioServer(): Promise<void> {
  const check = await startupCheck();
  if (!check.ok) {
    process.stderr.write(`${check.reason}\n`);
    process.exitCode = 1;
    return;
  }
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
}

async function runTool<T>(operation: () => Promise<T>): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  try {
    return { content: [{ type: "text", text: JSON.stringify(await operation()) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Local OpenWhispr read failed.";
    return { content: [{ type: "text", text: message.slice(0, 300) }], isError: true };
  }
}

function noteForMcp(note: LocalNote): Omit<LocalNote, "transcript" | "transcript_studio"> {
  const { transcript: _transcript, transcript_studio: _studio, ...safeNote } = note;
  return safeNote;
}

function isMainEntry(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainEntry()) {
  runStdioServer().catch(() => {
    // Keep stdout exclusively for JSON-RPC stdio; do not log note data or CLI details.
    process.stderr.write("OpenWhispr Local MCP could not start. Confirm the local app and CLI are available.\n");
    process.exitCode = 1;
  });
}
