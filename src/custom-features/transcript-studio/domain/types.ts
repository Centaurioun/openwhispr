export interface SourceSegment {
  id: string;
  text: string;
  speakerId: string | null;
  speakerName: string | null;
  startSeconds: number | null;
  endSeconds: number | null;
  speakerLocked: boolean;
  sourceIndex: number;
  source?: "mic" | "system";
  suggestedName?: string | null;
  suggestedProfileId?: number | null;
  recorderName?: string | null;
}

export interface NormalizedTranscriptSource {
  sourceHash: string;
  kind: "plain" | "segments";
  segments: SourceSegment[];
}
