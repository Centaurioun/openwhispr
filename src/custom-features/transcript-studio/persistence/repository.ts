import type {
  ApplyTranscriptRevisionInput,
  ApplyTranscriptRevisionResult,
  TranscriptStudioVersionMeta,
  TranscriptStudioWorkspace,
} from "../../../types/electron";

/** Narrow renderer access to the local, authorization-checked transcript store. */
export const transcriptStudioRepository = {
  getTranscriptWorkspace(noteId: number): Promise<TranscriptStudioWorkspace> {
    return window.electronAPI.getTranscriptWorkspace(noteId);
  },

  applyTranscriptRevision(
    input: ApplyTranscriptRevisionInput
  ): Promise<ApplyTranscriptRevisionResult> {
    return window.electronAPI.applyTranscriptRevision(input);
  },

  listTranscriptVersions(noteId: number): Promise<TranscriptStudioVersionMeta[]> {
    return window.electronAPI.listTranscriptVersions(noteId);
  },

  restoreTranscriptVersion(
    noteId: number,
    versionId: string,
    expectedVersion: number
  ): Promise<TranscriptStudioWorkspace> {
    return window.electronAPI.restoreTranscriptVersion(noteId, versionId, expectedVersion);
  },
};
