import type { TranscriptStudioVersionMeta } from "../../../types/electron";

interface VersionHistoryProps {
  versions: TranscriptStudioVersionMeta[];
  selectedVersionId: string;
  currentText: string;
  comparedText: string;
  canRestore: boolean;
  onSelect: (versionId: string) => void;
  onRestore: () => void;
}

export function VersionHistory({
  versions,
  selectedVersionId,
  currentText,
  comparedText,
  canRestore,
  onSelect,
  onRestore,
}: VersionHistoryProps) {
  return (
    <section className="mb-4 rounded border p-3" aria-label="Transcript version history">
      <h2 className="mb-2 text-sm font-semibold">Version history</h2>
      <label className="mb-2 block text-sm">
        Compare with
        <select
          className="ml-2 rounded border bg-background p-1"
          value={selectedVersionId}
          onChange={(event) => onSelect(event.currentTarget.value)}
          aria-label="Compare transcript version"
        >
          {versions.map((version) => (
            <option key={version.versionId} value={version.versionId}>
              {version.version === 0 ? "Original transcript" : `Version ${version.version}`} —{" "}
              {version.description}
              {version.createdAt ? ` (${new Date(version.createdAt).toLocaleString()})` : ""}
            </option>
          ))}
        </select>
      </label>
      <div className="grid gap-3 md:grid-cols-2" aria-label="Read-only version comparison">
        <div>
          <h3 className="text-xs font-medium text-muted-foreground">Selected version</h3>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 text-xs">
            {comparedText}
          </pre>
        </div>
        <div>
          <h3 className="text-xs font-medium text-muted-foreground">Current version</h3>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 text-xs">
            {currentText}
          </pre>
        </div>
      </div>
      <button type="button" className="mt-2" disabled={!canRestore} onClick={onRestore}>
        Restore selected version…
      </button>
    </section>
  );
}
