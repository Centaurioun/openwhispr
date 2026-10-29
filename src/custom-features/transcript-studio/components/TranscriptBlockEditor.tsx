import { useEffect, useRef, useState } from "react";
import type { SourceSegment } from "../domain/types";

interface TranscriptBlockEditorProps {
  segment: SourceSegment;
  speakers: Array<{ id: string; name: string }>;
  speakerDisplayName: string;
  selected: boolean;
  canEdit: boolean;
  onToggleSelect: (segmentId: string) => void;
  onTextCommit: (segmentId: string, text: string) => void | Promise<void>;
  onSpeakerCommit: (segmentId: string, speakerName: string) => void | Promise<void>;
  onSpeakerReassign: (
    segmentId: string,
    speakerId: string | null,
    speakerName: string | null
  ) => void | Promise<void>;
  onConfirmSuggestion: (segmentId: string) => void | Promise<void>;
  onDismissSuggestion: (segmentId: string) => void | Promise<void>;
  onSplit: (segmentId: string, atOffset: number, text: string) => void | Promise<void>;
  onMergeNext?: (segmentId: string) => void | Promise<void>;
  onUndo?: () => void | Promise<void>;
  onRedo?: () => void | Promise<void>;
}

const formatTimestamp = (seconds: number): string => {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  return `${minutes}:${String(safeSeconds % 60).padStart(2, "0")}`;
};

export function TranscriptBlockEditor({
  segment,
  speakers,
  speakerDisplayName,
  selected,
  canEdit,
  onToggleSelect,
  onTextCommit,
  onSpeakerCommit,
  onSpeakerReassign,
  onConfirmSuggestion,
  onDismissSuggestion,
  onSplit,
  onMergeNext,
  onUndo,
  onRedo,
}: TranscriptBlockEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState(segment.text);
  const [speakerDraft, setSpeakerDraft] = useState(speakerDisplayName);

  useEffect(() => setDraft(segment.text), [segment.text]);
  useEffect(() => setSpeakerDraft(speakerDisplayName), [speakerDisplayName]);

  return (
    <section
      className="border-b border-border/60 py-3"
      data-transcript-segment={segment.id}
      data-source-index={segment.sourceIndex}
    >
      <div className="mb-2 flex items-center gap-3">
        <input
          type="checkbox"
          aria-label={`Select transcript segment ${segment.id}`}
          checked={selected}
          onChange={() => onToggleSelect(segment.id)}
        />
        {segment.startSeconds !== null && (
          <time
            className="text-xs tabular-nums text-muted-foreground"
            dateTime={`PT${segment.startSeconds}S`}
          >
            {formatTimestamp(segment.startSeconds)}
          </time>
        )}
        <input
          aria-label={`Speaker name for ${segment.id}`}
          className="min-w-0 rounded border border-border bg-background px-2 py-1 text-sm"
          value={speakerDraft}
          placeholder="Speaker"
          readOnly={!canEdit}
          onChange={(event) => setSpeakerDraft(event.currentTarget.value)}
          onBlur={(event) => {
            const nextName = event.currentTarget.value.trim();
            if (canEdit && nextName !== speakerDisplayName) {
              void onSpeakerCommit(segment.id, nextName);
            }
          }}
        />
      </div>
      <label className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        <span>Assign speaker</span>
        <select
          aria-label={`Reassign speaker for ${segment.id}`}
          className="rounded border border-border bg-background px-2 py-1 text-foreground"
          value={segment.speakerId ?? ""}
          disabled={!canEdit}
          onChange={(event) => {
            const speakerId = event.currentTarget.value || null;
            const speaker = speakers.find((candidate) => candidate.id === speakerId);
            void onSpeakerReassign(segment.id, speakerId, speaker?.name ?? null);
          }}
        >
          <option value="">Unassigned</option>
          {speakers.map((speaker) => (
            <option key={speaker.id} value={speaker.id}>
              {speaker.name}
            </option>
          ))}
        </select>
      </label>
      {segment.suggestedName && (
        <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
          <span>Suggested: {segment.suggestedName}</span>
          {canEdit && (
            <>
              <button
                type="button"
                aria-label={`Accept speaker suggestion ${segment.id}`}
                className="rounded border border-border px-2 py-1"
                onClick={() => void onConfirmSuggestion(segment.id)}
              >
                Accept
              </button>
              <button
                type="button"
                aria-label={`Dismiss speaker suggestion ${segment.id}`}
                className="rounded border border-border px-2 py-1"
                onClick={() => void onDismissSuggestion(segment.id)}
              >
                Dismiss
              </button>
            </>
          )}
        </div>
      )}
      <textarea
        ref={textareaRef}
        aria-label={`Transcript text ${segment.id}`}
        className="min-h-16 w-full resize-y rounded border border-border bg-background px-3 py-2 text-sm leading-relaxed"
        value={draft}
        readOnly={!canEdit}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (!canEdit || (!event.metaKey && !event.ctrlKey)) return;
          const key = event.key.toLowerCase();
          const draftIsPending = draft !== segment.text;
          if (key === "z" && !draftIsPending) {
            event.preventDefault();
            if (event.shiftKey) void onRedo?.();
            else void onUndo?.();
          } else if (key === "y" && !draftIsPending) {
            event.preventDefault();
            void onRedo?.();
          }
        }}
        onBlur={(event) => {
          if (canEdit && event.currentTarget.value !== segment.text) {
            void onTextCommit(segment.id, event.currentTarget.value);
          }
        }}
      />
      {canEdit && (
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            className="rounded border border-border px-2 py-1 text-xs"
            disabled={!draft || !textareaRef.current || textareaRef.current.selectionStart <= 0}
            onClick={() =>
              void onSplit(segment.id, textareaRef.current?.selectionStart ?? 0, draft)
            }
          >
            Split at cursor
          </button>
          {onMergeNext && (
            <button
              type="button"
              className="rounded border border-border px-2 py-1 text-xs"
              onClick={() => void onMergeNext(segment.id)}
            >
              Merge with next
            </button>
          )}
        </div>
      )}
    </section>
  );
}
