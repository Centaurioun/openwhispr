import type { EditOperation } from "../domain/editOperations";
import {
  validateTranscriptProposal,
  type ProposalValidation,
  type ProposedChunk,
} from "../domain/validateProposal";
import { planTranscriptChunks, type TranscriptChunk } from "./chunkPlanner";
import type { SourceSegment } from "../domain/types";

export type TranscriptEditEvent =
  | {
      type: "chunkProposed";
      chunk: TranscriptChunk;
      candidate: ProposedChunk;
      validation: ProposalValidation;
    }
  | { type: "progress"; completed: number; total: number; chunkIndex: number }
  | { type: "warning"; message: string; chunkIndex?: number }
  | { type: "failed"; message: string; chunkIndex: number; resumeFromChunk: number }
  | { type: "done"; completed: number; total: number; cancelled?: boolean };

interface Runtime {
  getSourceSegments(noteId: number, sourceHash: string): Promise<SourceSegment[]>;
  captureContext(noteId: number, sourceHash: string): Promise<string>;
  contextIsCurrent(noteId: number, sourceHash: string, context: string): Promise<boolean>;
  processChunk(
    text: string,
    providerChoice: string,
    outputTokens: number,
    signal: AbortSignal
  ): Promise<string>;
  confirmRemote(providerChoice: string): Promise<boolean>;
  maxInputTokens?: number;
}

export interface StartTranscriptEditJobInput {
  noteId: number;
  sourceHash: string;
  providerChoice: string;
  strictMode: true;
  selectedIds?: string[];
  signal?: AbortSignal;
  resumeFromChunk?: number;
  /** @internal dependency seam for deterministic tests and embedders. */
  runtime?: Runtime;
}

const VALID_PROVIDER_CHOICES = new Set([
  "local",
  "openwhispr",
  "openai",
  "anthropic",
  "gemini",
  "groq",
  "tinfoil",
  "custom",
  "openrouter",
  "corti",
  "bedrock",
  "azure",
  "vertex",
  "lan",
  "self-hosted",
  "enterprise",
  "providers",
]);

function extractCandidate(response: string): ProposedChunk {
  const stripped = response
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const candidate = JSON.parse(stripped) as ProposedChunk;
  if (!candidate || !Array.isArray(candidate.segments))
    throw new Error("Invalid structured response");
  return candidate;
}

async function createDefaultRuntime(): Promise<Runtime> {
  const [
    { getSettings },
    { usePolicyStore },
    { transcriptStudioRepository },
    { normalizeTranscriptSource },
  ] = await Promise.all([
    import("../../../stores/settingsStore"),
    import("../../../stores/policyStore"),
    import("../persistence/repository"),
    import("../domain/normalizeSource"),
  ]);
  const contextKey = () => {
    const policy = usePolicyStore.getState();
    return `${policy.accountId ?? "anonymous"}:${policy.authGeneration ?? "none"}`;
  };
  return {
    async getSourceSegments(noteId, sourceHash) {
      const workspace = await transcriptStudioRepository.getTranscriptWorkspace(noteId);
      const normalized = await normalizeTranscriptSource(workspace.originalTranscript);
      if (normalized.sourceHash !== sourceHash)
        throw new Error("Transcript source changed; reload before editing.");
      return normalized.segments;
    },
    async captureContext() {
      return contextKey();
    },
    async contextIsCurrent(noteId, sourceHash, captured) {
      if (contextKey() !== captured) return false;
      try {
        const workspace = await transcriptStudioRepository.getTranscriptWorkspace(noteId);
        return workspace.baselineSourceHash === sourceHash && workspace.sourceHash === sourceHash;
      } catch {
        return false;
      }
    },
    async confirmRemote(providerChoice) {
      if (providerChoice === "local") return true;
      if (typeof window === "undefined" || typeof window.confirm !== "function") return false;
      return window.confirm("Send transcript text to the selected AI provider for edit proposals?");
    },
    async processChunk(text, providerChoice, outputTokens, signal) {
      const { default: ReasoningService } = await import("../../../services/ReasoningService");
      if (signal.aborted) throw new Error("Transcript editing cancelled");
      const settings = getSettings();
      const mode = settings.cleanupMode;
      let provider: string | undefined;
      let model = settings.cleanupModel;
      let lanUrl: string | undefined;
      if (providerChoice === "local" || mode === "local") provider = "local";
      else if (
        providerChoice === "self-hosted" ||
        providerChoice === "lan" ||
        mode === "self-hosted"
      ) {
        provider = "lan";
        lanUrl = settings.cleanupRemoteUrl || undefined;
        model = settings.cleanupModel || "local";
      } else if (providerChoice === "openwhispr" || mode === "openwhispr") provider = "openwhispr";
      else {
        provider =
          providerChoice === "providers" || providerChoice === "enterprise"
            ? settings.cleanupProvider
            : providerChoice;
        model = settings.cleanupModel;
      }
      if (!provider || !VALID_PROVIDER_CHOICES.has(provider))
        throw new Error("Invalid transcript editing provider");
      const prompt = [
        "Edit this transcript conservatively for punctuation, spelling, and obvious transcription errors.",
        "Preserve meaning, wording, every fact, all names and numbers, chronology, and uncertainty.",
        "Do not summarize, omit, reorder, merge, infer speakers, or add information.",
        'Return only valid JSON: {"segments":[{"id":string,"text":string}]}.',
        "Return every owned source ID exactly once, in its original order. Context-only segments may inform wording but must not be returned.",
        "Source blocks:\n" + text,
      ].join("\n\n");
      const config = {
        provider,
        ...(lanUrl ? { lanUrl } : {}),
        inferenceScope: "dictationCleanup" as const,
        maxTokens: outputTokens,
        temperature: 0,
        systemPrompt:
          "You produce complete, lossless transcript edit proposals as JSON. Never apply edits or approve them.",
        requireCompleteOutput: true,
      };
      // ReasoningService supports request cancellation through a request ID. The abort handler is
      // deliberately local to this chunk and does not affect unrelated reasoning requests.
      const requestId = `transcript-edit-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const { trackRequest, cancelRequest } =
        await import("../../../services/ai/requestCancellation");
      const releaseRequest = trackRequest(requestId);
      const abortRequest = () => {
        cancelRequest(requestId);
        if (provider === "local") void window.electronAPI?.cancelLocalReasoning?.(requestId);
      };
      signal.addEventListener("abort", abortRequest, { once: true });
      try {
        return await ReasoningService.processText(prompt, model, null, { ...config, requestId });
      } finally {
        signal.removeEventListener("abort", abortRequest);
        releaseRequest();
        void signal;
      }
    },
  };
}

function sourcePayload(chunk: TranscriptChunk): string {
  return JSON.stringify(
    chunk.segments.map(({ id, text, contextOnly, parentSegmentId, partIndex, partCount }) => ({
      id,
      text,
      contextOnly: !!contextOnly,
      ...(parentSegmentId ? { parentSegmentId, partIndex, partCount } : {}),
    }))
  );
}

/**
 * Explicitly invoked sequential edit job. It only emits proposals: accepted/approved revisions
 * remain owned by the existing Transcript Studio review flow.
 */
export async function* startTranscriptEditJob(
  input: StartTranscriptEditJobInput
): AsyncIterable<TranscriptEditEvent> {
  let runtime = input.runtime;
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  input.signal?.addEventListener("abort", forwardAbort, { once: true });
  let completed = 0;
  let chunks: TranscriptChunk[] = [];
  try {
    if (!input.providerChoice || !VALID_PROVIDER_CHOICES.has(input.providerChoice)) {
      yield {
        type: "failed",
        message: "Choose a valid transcript editing provider.",
        chunkIndex: 0,
        resumeFromChunk: 0,
      };
      return;
    }
    runtime ??= await createDefaultRuntime();
    const capturedContext = await runtime.captureContext(input.noteId, input.sourceHash);
    if (
      input.providerChoice !== "local" &&
      !(await (runtime
        ? runtime.confirmRemote(input.providerChoice)
        : Promise.resolve(
            typeof window !== "undefined" &&
              typeof window.confirm === "function" &&
              window.confirm("Send transcript text to the selected AI provider for edit proposals?")
          )))
    ) {
      yield {
        type: "warning",
        message: "Remote transcript processing was not approved. No transcript text was sent.",
      };
      yield { type: "done", completed: 0, total: 0, cancelled: true };
      return;
    }
    if (!(await runtime.contextIsCurrent(input.noteId, input.sourceHash, capturedContext))) {
      yield {
        type: "warning",
        message: "The account, note, or source changed; transcript editing was cancelled.",
      };
      yield { type: "done", completed: 0, total: 0, cancelled: true };
      return;
    }
    let segments: SourceSegment[];
    try {
      segments = await runtime.getSourceSegments(input.noteId, input.sourceHash);
    } catch (error) {
      yield {
        type: "failed",
        message: error instanceof Error ? error.message : "Transcript source is unavailable.",
        chunkIndex: 0,
        resumeFromChunk: 0,
      };
      return;
    }
    const selected = input.selectedIds?.length
      ? segments.filter((segment) => input.selectedIds!.includes(segment.id))
      : segments;
    chunks = planTranscriptChunks(selected, runtime.maxInputTokens ?? 6000);
    const sourceById = new Map(selected.map((segment) => [segment.id, segment]));
    const sourcePartCandidates = new Map<string, Map<number, string>>();
    const firstChunkBySourceId = new Map<string, number>();
    for (const chunk of chunks) {
      for (const segment of chunk.segments) {
        if (!segment.contextOnly && segment.parentSegmentId && segment.partCount) {
          if (!firstChunkBySourceId.has(segment.parentSegmentId))
            firstChunkBySourceId.set(segment.parentSegmentId, chunk.index);
        }
      }
    }
    if (!chunks.length) {
      yield { type: "done", completed: 0, total: 0 };
      return;
    }
    const start = Math.max(0, Math.min(input.resumeFromChunk ?? 0, chunks.length));
    for (let index = start; index < chunks.length; index += 1) {
      if (controller.signal.aborted) {
        yield { type: "done", completed, total: chunks.length, cancelled: true };
        return;
      }
      if (!(await runtime.contextIsCurrent(input.noteId, input.sourceHash, capturedContext))) {
        yield {
          type: "warning",
          message: "The account, note, or source changed; the late proposal was discarded.",
          chunkIndex: index,
        };
        yield { type: "done", completed, total: chunks.length, cancelled: true };
        return;
      }
      const chunk = chunks[index];
      try {
        const response = await runtime.processChunk(
          sourcePayload(chunk),
          input.providerChoice,
          chunk.outputTokens,
          controller.signal
        );
        if (controller.signal.aborted) {
          yield { type: "done", completed, total: chunks.length, cancelled: true };
          return;
        }
        if (!(await runtime.contextIsCurrent(input.noteId, input.sourceHash, capturedContext))) {
          yield {
            type: "warning",
            message: "The account, note, or source changed; the late proposal was discarded.",
            chunkIndex: index,
          };
          yield { type: "done", completed, total: chunks.length, cancelled: true };
          return;
        }
        let candidate: ProposedChunk;
        try {
          candidate = extractCandidate(response);
          if (candidate.truncated) throw new Error("The model marked its output as truncated");
        } catch {
          // Reduce input and proportionally resize the output allowance. Retrying the same text
          // with fewer output tokens would make a clipped response more likely, not less.
          const owned = chunk.segments.filter((segment) => !segment.contextOnly);
          if (owned.length < 2) {
            const partialSource = owned.find((segment) => segment.parentSegmentId);
            yield {
              type: "warning",
              message: "Model output was incomplete or invalid; this chunk needs another pass.",
              chunkIndex: index,
            };
            yield {
              type: "failed",
              message: "Could not validate the model response.",
              chunkIndex: index,
              resumeFromChunk: partialSource
                ? (firstChunkBySourceId.get(partialSource.parentSegmentId!) ?? index)
                : index,
            };
            return;
          }
          const groupSize = Math.ceil(owned.length / 2);
          const groups = [owned.slice(0, groupSize), owned.slice(groupSize)];
          const recovered: ProposedChunk["segments"] = [];
          for (const group of groups) {
            if (!group.length) continue;
            if (controller.signal.aborted) {
              yield { type: "done", completed, total: chunks.length, cancelled: true };
              return;
            }
            if (
              !(await runtime.contextIsCurrent(input.noteId, input.sourceHash, capturedContext))
            ) {
              yield {
                type: "warning",
                message: "The account, note, or source changed; the late proposal was discarded.",
                chunkIndex: index,
              };
              yield { type: "done", completed, total: chunks.length, cancelled: true };
              return;
            }
            const subchunk: TranscriptChunk = {
              ...chunk,
              segments: group,
              inputTokens: group.reduce(
                (sum, segment) => sum + Math.ceil(segment.text.length / 3.5) + 12,
                0
              ),
              outputTokens: Math.max(
                64,
                Math.floor(chunk.outputTokens * (group.length / owned.length))
              ),
            };
            const retry = await runtime.processChunk(
              sourcePayload(subchunk),
              input.providerChoice,
              subchunk.outputTokens,
              controller.signal
            );
            if (controller.signal.aborted) {
              yield { type: "done", completed, total: chunks.length, cancelled: true };
              return;
            }
            if (
              !(await runtime.contextIsCurrent(input.noteId, input.sourceHash, capturedContext))
            ) {
              yield {
                type: "warning",
                message: "The account, note, or source changed; the late proposal was discarded.",
                chunkIndex: index,
              };
              yield { type: "done", completed, total: chunks.length, cancelled: true };
              return;
            }
            const retryCandidate = extractCandidate(retry);
            if (retryCandidate.truncated)
              throw new Error("Output remained truncated after reducing the input chunk");
            recovered.push(...retryCandidate.segments);
          }
          candidate = { segments: recovered };
        }
        const owned = chunk.segments.filter((segment) => !segment.contextOnly);
        const splitSegments = owned.filter(
          (segment) => segment.partCount && segment.parentSegmentId
        );
        const normalSegments = owned.filter((segment) => !segment.parentSegmentId);
        const splitIds = new Set(splitSegments.map((segment) => segment.id));
        const normalIds = new Set(normalSegments.map((segment) => segment.id));
        const normalCandidates = candidate.segments.filter(
          (item) => normalIds.has(item.id) || !splitIds.has(item.id)
        );
        if (normalSegments.length) {
          const normalChunk: TranscriptChunk = {
            ...chunk,
            segments: chunk.segments.filter(
              (segment) => segment.contextOnly || normalIds.has(segment.id)
            ),
          };
          const normalCandidate = { segments: normalCandidates, truncated: candidate.truncated };
          const validation = validateTranscriptProposal(normalChunk, normalCandidate);
          if (!validation.safe) {
            for (const message of validation.warnings)
              yield { type: "warning", message, chunkIndex: index };
          }
          yield {
            type: "chunkProposed",
            chunk: normalChunk,
            candidate: normalCandidate,
            validation,
          };
        }
        if (splitSegments.length) {
          const seenParts = new Set<string>();
          let malformedParts = false;
          for (const item of candidate.segments) {
            if (!splitIds.has(item.id) && !normalIds.has(item.id)) {
              malformedParts = true;
              yield {
                type: "warning",
                message: `Unexpected source block returned (${String(item.id)}).`,
                chunkIndex: index,
              };
            }
          }
          for (const item of candidate.segments) {
            if (!splitIds.has(item.id)) continue;
            if (seenParts.has(item.id) || typeof item.text !== "string") {
              malformedParts = true;
              yield {
                type: "warning",
                message: `A split source block was duplicated or invalid (${item.id}).`,
                chunkIndex: index,
              };
              continue;
            }
            seenParts.add(item.id);
            const sourcePart = splitSegments.find((segment) => segment.id === item.id)!;
            const parts = sourcePartCandidates.get(sourcePart.parentSegmentId!) ?? new Map();
            parts.set(sourcePart.partIndex!, item.text);
            sourcePartCandidates.set(sourcePart.parentSegmentId!, parts);
          }
          for (const segment of splitSegments) {
            if (!seenParts.has(segment.id)) {
              malformedParts = true;
              yield {
                type: "warning",
                message: `A split source block is missing (${segment.id}); this chunk cannot be approved.`,
                chunkIndex: index,
              };
            }
          }
          if (malformedParts) {
            const parent = splitSegments[0].parentSegmentId!;
            const resumeFromChunk = firstChunkBySourceId.get(parent) ?? index;
            yield {
              type: "failed",
              message: "Split source block coverage was incomplete.",
              chunkIndex: index,
              resumeFromChunk,
            };
            return;
          }
          const completedParents = new Set(
            splitSegments
              .map((segment) => segment.parentSegmentId!)
              .filter(
                (parent) =>
                  sourcePartCandidates.get(parent)?.size ===
                  splitSegments.find((s) => s.parentSegmentId === parent)?.partCount
              )
          );
          for (const parent of completedParents) {
            const source = sourceById.get(parent);
            const parts = sourcePartCandidates.get(parent);
            if (!source || !parts) continue;
            const text = Array.from(parts.entries())
              .sort(([left], [right]) => left - right)
              .map(([, value]) => value)
              .join("");
            const proposalChunk: TranscriptChunk = {
              id: `${chunk.id}-${parent}`,
              index: chunk.index,
              segments: [source],
              inputTokens: Math.max(1, Math.ceil(source.text.length / 3.5)) + 12,
              outputTokens: chunk.outputTokens,
            };
            const proposal = { segments: [{ id: parent, text }] };
            const validation = validateTranscriptProposal(proposalChunk, proposal);
            if (!validation.safe) {
              for (const message of validation.warnings)
                yield { type: "warning", message, chunkIndex: index };
            }
            yield { type: "chunkProposed", chunk: proposalChunk, candidate: proposal, validation };
            sourcePartCandidates.delete(parent);
          }
        }
        completed += 1;
        yield { type: "progress", completed, total: chunks.length, chunkIndex: index };
      } catch (error) {
        if (controller.signal.aborted) {
          yield { type: "done", completed, total: chunks.length, cancelled: true };
          return;
        }
        const partialSource = chunk.segments.find(
          (segment) => !segment.contextOnly && segment.parentSegmentId
        );
        yield {
          type: "failed",
          message: error instanceof Error ? error.message : "Transcript editing failed.",
          chunkIndex: index,
          resumeFromChunk: partialSource
            ? (firstChunkBySourceId.get(partialSource.parentSegmentId!) ?? index)
            : index,
        };
        return;
      }
    }
    yield { type: "done", completed, total: chunks.length };
  } finally {
    input.signal?.removeEventListener("abort", forwardAbort);
  }
}
