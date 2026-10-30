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

const numberWords = new Map<string, string>([
  ...Object.entries({
    zero: "0",
    oh: "0",
    one: "1",
    two: "2",
    three: "3",
    four: "4",
    five: "5",
    six: "6",
    seven: "7",
    eight: "8",
    nine: "9",
    ten: "10",
    eleven: "11",
    twelve: "12",
    thirteen: "13",
    fourteen: "14",
    fifteen: "15",
    sixteen: "16",
    seventeen: "17",
    eighteen: "18",
    nineteen: "19",
    twenty: "20",
    thirty: "30",
    forty: "40",
    fifty: "50",
    sixty: "60",
    seventy: "70",
    eighty: "80",
    ninety: "90",
    hundred: "100",
    thousand: "1000",
    million: "1000000",
    billion: "1000000000",
    point: ".",
    decimal: ".",
    percent: "%",
    percentage: "%",
    minus: "-",
    negative: "-",
    plus: "+",
    positive: "+",
  }),
]);
const numbers = (text: string): string[] => {
  const tokens = text.toLocaleLowerCase().match(/[+-]?\d+(?:[.,]\d+)*%?|[\p{L}]+|[.,%+-]/gu) ?? [];
  const result: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (/^[+-]?\d/.test(token)) {
      result.push(token.replace(/,/g, ""));
      continue;
    }
    const mapped = numberWords.get(token);
    if (!mapped) continue;
    if (mapped === "." && result.length && index + 1 < tokens.length)
      result[result.length - 1] += ".";
    else if (mapped === "-" || mapped === "+") result.push(mapped);
    else if (mapped === "%" && result.length) result[result.length - 1] += "%";
    else if (mapped === "%") result.push(mapped);
    else if ((result.at(-1) === "-" || result.at(-1) === "+") && /^\d+$/.test(mapped))
      result[result.length - 1] += mapped;
    else result.push(mapped);
  }
  return result.flatMap((part) => part.match(/[+-]?\d+(?:\.\d+)?%?/g) ?? []);
};
const names = (text: string): string[] =>
  text.match(/\b[A-Z][\p{L}'’-]*(?:\s+[A-Z][\p{L}'’-]*)*\b/gu) ?? [];
const contentWords = (text: string): string[] =>
  text.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
const commaPlacementChanged = (source: string, candidate: string): boolean => {
  const placements = (text: string) =>
    [...text.matchAll(/,/gu)].map((match) => {
      const beforeComma = text.slice(0, match.index ?? 0);
      return (beforeComma.match(/[\p{L}\p{N}]+/gu) ?? []).length;
    });
  return JSON.stringify(placements(source)) !== JSON.stringify(placements(candidate));
};
const meaningBearingSentencePunctuationChanged = (source: string, candidate: string): boolean => {
  const endings = (text: string) => text.match(/[.!?]+(?=["'”’)\]]*(?:\s|$))/gu) ?? [];
  const sourceEndings = endings(source);
  const candidateEndings = endings(candidate);
  if (JSON.stringify(sourceEndings) === JSON.stringify(candidateEndings)) return false;
  if ([...sourceEndings, ...candidateEndings].some((ending) => /[!?]/u.test(ending))) return true;
  return sourceEndings.length > 0 && candidateEndings.length > 0;
};

export function validateTranscriptProposal(
  source: TranscriptChunk,
  candidate: ProposedChunk
): ProposalValidation {
  const warnings: string[] = [];
  const edits: EditOperation[] = [];
  if (
    !candidate ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    Object.keys(candidate).some((key) => key !== "segments" && key !== "truncated") ||
    !Array.isArray(candidate.segments) ||
    (candidate.truncated !== undefined && typeof candidate.truncated !== "boolean")
  ) {
    return {
      safe: false,
      warnings: ["The model returned an invalid proposal structure; review the response manually."],
      edits,
    };
  }
  const expected = source.segments.filter((segment) => !segment.contextOnly);
  const expectedById = new Map(expected.map((segment) => [segment.id, segment]));
  const proposed = Array.isArray(candidate?.segments) ? candidate.segments : [];
  const seen = new Set<string>();
  let expectedIndex = 0;
  let safe = true;

  if (candidate?.truncated) {
    warnings.push("The model reported truncated output; this chunk needs manual review.");
    safe = false;
  }
  for (const entry of proposed) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      Object.keys(entry).some((key) => key !== "id" && key !== "text") ||
      typeof entry.id !== "string" ||
      !entry.id.trim() ||
      typeof entry.text !== "string" ||
      !entry.text.trim()
    ) {
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
    if (expected[expectedIndex]?.id !== entry.id) {
      warnings.push("Source blocks were reordered; review this proposal manually.");
      safe = false;
    }
    expectedIndex += 1;
    seen.add(entry.id);
    const original = expectedById.get(entry.id)!;
    if (numbers(original.text).join("\u0000") !== numbers(entry.text).join("\u0000")) {
      warnings.push(`Numbers changed in source block ${entry.id}; verify against the recording.`);
      safe = false;
    }
    const originalNames = names(original.text);
    const proposedNames = names(entry.text);
    if (
      originalNames.some((name) => !proposedNames.includes(name)) ||
      proposedNames.some((name) => !originalNames.includes(name))
    ) {
      warnings.push(`A name or capitalized term changed in source block ${entry.id}.`);
      safe = false;
    }
    const originalContent = contentWords(original.text);
    const proposedContent = contentWords(entry.text);
    const originalCounts = new Map<string, number>();
    const proposedCounts = new Map<string, number>();
    for (const word of originalContent)
      originalCounts.set(word, (originalCounts.get(word) ?? 0) + 1);
    for (const word of proposedContent)
      proposedCounts.set(word, (proposedCounts.get(word) ?? 0) + 1);
    const contentChanged =
      [...originalCounts].some(([word, count]) => (proposedCounts.get(word) ?? 0) < count) ||
      [...proposedCounts].some(([word, count]) => (originalCounts.get(word) ?? 0) < count);
    if (contentChanged) {
      warnings.push(
        `Transcript wording changed in source block ${entry.id}; manually review for omitted or added content.`
      );
      safe = false;
    }
    const sameContentMultiset =
      originalContent.length === proposedContent.length &&
      [...originalCounts].every(([word, count]) => proposedCounts.get(word) === count);
    if (
      sameContentMultiset &&
      originalContent.some((word, index) => proposedContent[index] !== word)
    ) {
      warnings.push(`Word order changed in source block ${entry.id}; manually review the meaning.`);
      safe = false;
    }
    if (commaPlacementChanged(original.text, entry.text)) {
      warnings.push(
        `Comma placement may change the meaning of source block ${entry.id}; manually review it.`
      );
      safe = false;
    }
    if (meaningBearingSentencePunctuationChanged(original.text, entry.text)) {
      warnings.push(
        `Sentence-ending punctuation may change the meaning of source block ${entry.id}; manually review it.`
      );
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
