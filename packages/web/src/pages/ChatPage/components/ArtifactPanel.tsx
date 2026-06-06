import type {
  AgentArtifactPreview,
  AgentArtifactSelection,
} from "../hooks/useChat";
import "./ArtifactPanel.css";

interface ArtifactPanelProps {
  artifacts: AgentArtifactPreview[];
  selected: AgentArtifactSelection | null;
  onOpen: (artifactId: string) => void;
  onClose: () => void;
}

export function ArtifactPanel({
  artifacts,
  selected,
  onOpen,
  onClose,
}: ArtifactPanelProps) {
  if (artifacts.length === 0) return null;

  return (
    <section className="artifact-panel" aria-label="Artifacts">
      <div className="artifact-panel__list">
        {artifacts.map((artifact) => (
          <button
            className="artifact-panel__item"
            key={artifact.id}
            type="button"
            onClick={() => onOpen(artifact.id)}
          >
            <span className="artifact-panel__name">{artifact.name}</span>
            <span className="artifact-panel__meta">
              {artifact.type ?? "artifact"}
              {artifact.version ? ` v${artifact.version}` : ""}
            </span>
          </button>
        ))}
      </div>
      {selected && (
        <div className="artifact-panel__detail">
          <div className="artifact-panel__detail-head">
            <div>
              <div className="artifact-panel__title">
                {selected.artifact.name}
              </div>
              <div className="artifact-panel__meta">
                {selected.artifact.type}
                {selected.artifact.version
                  ? ` v${selected.artifact.version}`
                  : ""}
              </div>
            </div>
            <button
              className="artifact-panel__close"
              type="button"
              onClick={onClose}
              aria-label="Close artifact"
            >
              x
            </button>
          </div>
          <pre className="artifact-panel__content">{selected.content}</pre>
        </div>
      )}
    </section>
  );
}
