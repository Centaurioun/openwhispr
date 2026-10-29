import type { EditOperation } from "./editOperations";
import type { TranscriptChunk } from "../process/chunkPlanner";

export interface ProposedChunk {
  segments: Array<{ id: string; text: string }>;
  truncated?: boolean;
}

export interface ProposalValidation {
  safe: boolean;
  warnings: string[];
  edits: EditOperation[];
}

const numbers = (text: string): string[] => text.match(/\b\d+(?:[.,]\d+)*%?\b/g) ?? [];
const names = (text: string): string[] =>
  text.match(/\b[A-Z][\p{L}'’-]*(?:\s+[A-Z][\p{L}'’-]*)*\b/gu) ?? [];

export function validateTranscriptProposal(
  source: TranscriptChunk,
  candidate: ProposedChunk
): ProposalValidation {
  const warnings: string[] = [];
  const edits: EditOperation[] = [];
  const expected = source.segments.filter((segment) => !segment.contextOnly);
  const expectedById = new Map(expected.map((segment) => [segment.id, segment]));
  const proposed = Array.isArray(candidate?.segments) ? candidate.segments : [];
  const seen = new Set<string>();
  let safe = true;

  if (candidate?.truncated) {
    warnings.push("The model reported truncated output; this chunk needs manual review.");
    safe = false;
  }
  for (const entry of proposed) {
    if (!entry || typeof entry.id !== "string" || typeof entry.text !== "string") {
      warnings.push("The model returned an invalid source block.");
      safe = false;
      continue;
    }
    if (!expectedById.has(entry.id)) {
      warnings.push(`Unexpected or duplicated source block: ${entry.id}.`);
      safe = false;
      continue;
    }
    if (seen.has(entry.id)) {
      warnings.push(`Duplicated source block: ${entry.id}.`);
      safe = false;
      continue;
    }
    seen.add(entry.id);
    const original = expectedById.get(entry.id)!;
    if (numbers(original.text).join("\u0000") !== numbers(entry.text).join("\u0000")) {
      warnings.push(`Numbers changed in source block ${entry.id}; verify against the recording.`);
      safe = false;
    }
    const originalNames = names(original.text);
    const proposedNames = names(entry.text);
    if (originalNames.some((name) => !proposedNames.includes(name))) {
      warnings.push(`A name or capitalized term changed in source block ${entry.id}.`);
      safe = false;
    }
    if (entry.text !== original.text) {
      edits.push({
        kind: "replaceText",
        segmentId: entry.id,
        before: original.text,
        after: entry.text,
      });
    }
  }
  if (seen.size !== expected.length) {
    warnings.push("One or more source blocks are missing; incomplete output cannot be approved.");
    safe = false;
  }
  if (proposed.length === 0 && expected.length) {
    warnings.push("The model returned no source blocks.");
    safe = false;
  }
  return { safe, warnings, edits };
}
