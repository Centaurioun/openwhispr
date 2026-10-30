import type { EditOperation, TranscriptEditWorkspace } from "../domain/editOperations";
import type { TranscriptEditEvent } from "../process/transcriptEditJob";
import { useState } from "react";

export type PendingTranscriptProposal = Extract<TranscriptEditEvent, { type: "chunkProposed" }> & {
  baseVersion: number;
  uncertain?: true;
};

interface ProposalReviewProps {
  proposals: PendingTranscriptProposal[];
  workspace: TranscriptEditWorkspace;
  currentVersion: number;
  canEdit: boolean;
  onAccept: (ids: string[], operations: EditOperation[]) => Promise<void>;
  onReject: (ids: string[]) => void;
  onRereview: (id: string, edits: EditOperation[]) => void;
}

export function ProposalReview({
  proposals,
  workspace,
  currentVersion,
  canEdit,
  onAccept,
  onReject,
  onRereview,
}: ProposalReviewProps) {
  const [filter, setFilter] = useState<"all" | "text" | "speaker">("all");
  const segmentById = new Map(workspace.segments.map((segment) => [segment.id, segment]));
  const operationsFor = (proposal: PendingTranscriptProposal) => proposal.validation.edits;
  const isStale = (proposal: PendingTranscriptProposal) => proposal.baseVersion !== currentVersion;
  const typeLabel = (proposal: PendingTranscriptProposal) =>
    proposal.uncertain === true ||
    proposal.validation.edits.some((edit) => edit.kind === "setSpeaker")
      ? "Speaker suggestion"
      : "Text correction";
  const visibleProposals = proposals.filter(
    (proposal) =>
      filter === "all" || (filter === "speaker") === (typeLabel(proposal) === "Speaker suggestion")
  );

  const accept = async (selected: PendingTranscriptProposal[]) => {
    const eligible = selected.filter(
      (proposal) =>
        proposal.validation.structurallyValid === true &&
        proposal.validation.safe &&
        !isStale(proposal)
    );
    if (!canEdit || eligible.length === 0) return;
    const speakerAssignmentCount = eligible.reduce(
      (count, proposal) =>
        count + proposal.validation.edits.filter((edit) => edit.kind === "setSpeaker").length,
      0
    );
    const uncertainProposalCount = eligible.filter(
      (proposal) =>
        proposal.uncertain === true ||
        proposal.validation.edits.some((edit) => edit.kind === "setSpeaker")
    ).length;
    if (uncertainProposalCount > 0) {
      const confirm = typeof window !== "undefined" ? window.confirm : undefined;
      const message =
        speakerAssignmentCount > 0
          ? `Confirm ${speakerAssignmentCount} uncertain speaker assignment${speakerAssignmentCount === 1 ? "" : "s"}? Accepting will lock these speaker assignments.`
          : `Confirm ${uncertainProposalCount} uncertain speaker suggestion${uncertainProposalCount === 1 ? "" : "s"}? This batch has no speaker assignment operations to lock.`;
      if (!confirm?.(message)) return;
    }
    const operations = eligible.flatMap(operationsFor);
    if (operations.length)
      await onAccept(
        eligible.map((item) => item.chunk.id),
        operations
      );
  };

  const acceptAfterManualReview = async (proposal: PendingTranscriptProposal) => {
    if (
      !canEdit ||
      isStale(proposal) ||
      proposal.validation.structurallyValid !== true ||
      proposal.validation.safe
    )
      return;
    const confirm = typeof window !== "undefined" ? window.confirm : undefined;
    if (
      !confirm?.(
        "This AI proposal may omit or change transcript content. Confirm that you manually reviewed this proposal against the source before accepting it."
      )
    )
      return;
    const operations = operationsFor(proposal);
    if (operations.length) await onAccept([proposal.chunk.id], operations);
  };

  return (
    <section
      aria-label="Pending AI transcript proposals"
      className="mb-4 border-y border-border py-3"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">Pending AI proposals ({proposals.length})</h3>
        <div role="group" aria-label="Filter proposal type" className="flex gap-1">
          {(["all", "text", "speaker"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {value === "all"
                ? "All types"
                : value === "text"
                  ? "Text changes"
                  : "Speaker suggestions"}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={
              !canEdit ||
              !proposals.some(
                (proposal) =>
                  proposal.validation.structurallyValid === true &&
                  proposal.validation.safe &&
                  !isStale(proposal)
              )
            }
            onClick={() => void accept(proposals)}
          >
            Accept all
          </button>
          <button
            type="button"
            disabled={!canEdit || proposals.length === 0}
            onClick={() => onReject(proposals.map((item) => item.chunk.id))}
          >
            Reject all
          </button>
        </div>
      </div>
      {visibleProposals.map((proposal) => {
        const stale = isStale(proposal);
        const speaker = typeLabel(proposal) === "Speaker suggestion";
        return (
          <article
            key={proposal.chunk.id}
            className="border-t border-border/60 py-3"
            data-proposal-chunk={proposal.chunk.id}
          >
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <strong>Chunk {proposal.chunk.index + 1}</strong>
              <span>{typeLabel(proposal)}</span>
            </div>
            {stale && (
              <p role="alert">
                Transcript changed since this proposal was generated. Review its changes against the
                current transcript before accepting.
              </p>
            )}
            {proposal.validation.warnings.map((warning) => (
              <p role="alert" key={warning}>
                {warning}
              </p>
            ))}
            {proposal.validation.edits.map((edit) => {
              if (edit.kind === "replaceText") {
                const current = segmentById.get(edit.segmentId)?.text;
                return (
                  <div key={edit.segmentId} className="my-2 text-sm">
                    <p>
                      Current: <del>{current ?? "Segment unavailable"}</del>
                    </p>
                    <p>
                      Proposed: <ins>{edit.after}</ins>
                    </p>
                  </div>
                );
              }
              if (edit.kind === "setSpeaker")
                return (
                  <p key={edit.segmentId}>
                    Speaker: {edit.speakerName ?? "Unassigned"}{" "}
                    <span>(uncertain suggestion; confirm explicitly)</span>
                  </p>
                );
              return null;
            })}
            {canEdit && (
              <div className="mt-2 flex flex-wrap gap-2">
                {stale && proposal.validation.structurallyValid ? (
                  <button
                    type="button"
                    onClick={() => {
                      const rebased = proposal.validation.edits.map((edit) =>
                        edit.kind === "replaceText" && segmentById.has(edit.segmentId)
                          ? { ...edit, before: segmentById.get(edit.segmentId)!.text }
                          : edit
                      );
                      onRereview(proposal.chunk.id, rebased);
                    }}
                  >
                    Review changes
                  </button>
                ) : !proposal.validation.structurallyValid ? (
                  <p role="alert">
                    This proposal is structurally invalid and cannot be accepted. Retry the AI edit
                    before reviewing its changes.
                  </p>
                ) : !proposal.validation.safe ? (
                  <button
                    type="button"
                    disabled={proposal.validation.edits.length === 0}
                    aria-label={`Accept proposal ${proposal.chunk.id} after manual review`}
                    onClick={() => void acceptAfterManualReview(proposal)}
                  >
                    Accept after manual review
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={proposal.validation.edits.length === 0}
                    aria-label={`Accept proposal ${proposal.chunk.id}`}
                    onClick={() => void accept([proposal])}
                  >
                    {speaker ? "Confirm speaker explicitly" : "Accept"}
                  </button>
                )}
                <button
                  type="button"
                  aria-label={`Reject proposal ${proposal.chunk.id}`}
                  onClick={() => onReject([proposal.chunk.id])}
                >
                  Reject
                </button>
              </div>
            )}
          </article>
        );
      })}
    </section>
  );
}
