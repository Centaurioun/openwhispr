import { invokeLocalCli } from "./cliAdapter.js";

export interface LocalNoteSummary {
  id: number;
  title: string;
  note_type?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface LocalNote extends LocalNoteSummary {
  content?: string | null;
  transcript?: string | null;
  transcript_studio?: {
    approved?: {
      status?: "available" | "stale" | "invalid";
      version?: number;
      text?: string;
    };
  };
}

export interface TranscriptSelection {
  noteId: number;
  version: "original" | "approved";
  text: string;
}

export type LocalCliInvoker = (args: readonly string[]) => Promise<unknown>;

const MAX_LIMIT = 100;
const MAX_QUERY_CHARS = 500;

/** Fixed, read-only commands only. The CLI's --local mode retains its account checks. */
export function createLocalCommands(invoke: LocalCliInvoker = invokeLocalCli) {
  const getNote = async ({ id }: { id: number }): Promise<LocalNote> => {
    const noteId = validateId(id);
    const payload = await invoke(["notes", "get", String(noteId), "--format", "json"]);
    return noteRecord(payload, noteId);
  };

  return {
    async listNotes({ limit = 20 }: { limit?: number } = {}): Promise<LocalNoteSummary[]> {
      const boundedLimit = validateLimit(limit);
      const payload = await invoke(["notes", "list", "--limit", String(boundedLimit), "--format", "json"]);
      const rows = extractList(payload);
      return rows.map((row) => noteSummary(row));
    },

    async searchNotes({
      query,
      limit = 20,
    }: {
      query: string;
      limit?: number;
    }): Promise<LocalNoteSummary[]> {
      if (typeof query !== "string" || !query.trim() || query.length > MAX_QUERY_CHARS) {
        throw new Error(`Search query must contain 1–${MAX_QUERY_CHARS} characters.`);
      }
      const boundedLimit = validateLimit(limit);
      const payload = await invoke([
        "notes",
        "search",
        query,
        "--limit",
        String(boundedLimit),
        "--format",
        "json",
      ]);
      return extractList(payload).map((row) => noteSummary(row));
    },

    getNote,

    async getNoteTranscript({
      id,
      version,
    }: {
      id: number;
      version: "original" | "approved";
    }): Promise<TranscriptSelection> {
      const noteId = validateId(id);
      if (version !== "original" && version !== "approved") {
        throw new Error("Transcript version must be original or approved.");
      }

      const note = await getNote({ id: noteId });
      if (version === "original") {
        if (typeof note.transcript !== "string") throw new Error("Original transcript is unavailable.");
        return { noteId, version, text: note.transcript };
      }

      const approved = note.transcript_studio?.approved;
      if (approved?.status !== "available" || typeof approved.text !== "string") {
        throw new Error("Approved transcript unavailable; select Original or review it in OpenWhispr.");
      }
      return { noteId, version, text: approved.text };
    },
  };
}

export const localCommands = createLocalCommands();

function validateId(id: number): number {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Invalid note ID.");
  return id;
}

function validateLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`Limit must be an integer from 1 to ${MAX_LIMIT}.`);
  }
  return limit;
}

function unwrap(payload: unknown): unknown {
  if (isRecord(payload) && "data" in payload) return payload.data;
  return payload;
}

function extractList(payload: unknown): unknown[] {
  const value = unwrap(payload);
  const rows = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.notes) ? value.notes : null;
  if (!rows) throw new Error("Invalid notes response from the local OpenWhispr CLI.");
  return rows;
}

function noteSummary(value: unknown): LocalNoteSummary {
  if (!isRecord(value) || !Number.isSafeInteger(value.id) || (value.id as number) <= 0) {
    throw new Error("Invalid note response from the local OpenWhispr CLI.");
  }
  return {
    id: value.id as number,
    title: typeof value.title === "string" ? value.title : "Untitled",
    ...(optionalString(value.note_type) !== undefined ? { note_type: optionalString(value.note_type) } : {}),
    ...(optionalString(value.created_at) !== undefined ? { created_at: optionalString(value.created_at) } : {}),
    ...(optionalString(value.updated_at) !== undefined ? { updated_at: optionalString(value.updated_at) } : {}),
  };
}

function noteRecord(payload: unknown, expectedId: number): LocalNote {
  const value = unwrap(payload);
  if (!isRecord(value) || value.id !== expectedId) {
    throw new Error("Invalid note response from the local OpenWhispr CLI.");
  }
  const summary = noteSummary(value);
  const record: LocalNote = { ...summary };
  if (typeof value.content === "string" || value.content === null) record.content = value.content;
  if (typeof value.transcript === "string" || value.transcript === null) record.transcript = value.transcript;
  if (isRecord(value.transcript_studio)) {
    const candidate = value.transcript_studio.approved;
    if (isRecord(candidate)) {
      record.transcript_studio = {
        approved: {
          ...(candidate.status === "available" || candidate.status === "stale" || candidate.status === "invalid"
            ? { status: candidate.status }
            : {}),
          ...(Number.isSafeInteger(candidate.version) && (candidate.version as number) >= 0
            ? { version: candidate.version as number }
            : {}),
          ...(typeof candidate.text === "string" ? { text: candidate.text } : {}),
        },
      };
    }
  }
  return record;
}

function optionalString(value: unknown): string | null | undefined {
  return typeof value === "string" || value === null ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
