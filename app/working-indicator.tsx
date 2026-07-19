import type { PlaylistWorkMotion, PlaylistWorkStage } from "./playlist-waiting-state";

const stages: Array<{ id: PlaylistWorkStage; label: string }> = [
  { id: "queue", label: "QUEUE" },
  { id: "research", label: "RESEARCH" },
  { id: "match", label: "MATCH" },
  { id: "build", label: "BUILD" },
];

type WorkingIndicatorProps = {
  stage: PlaylistWorkStage;
  motion: PlaylistWorkMotion;
  phaseLabel: string;
  sourceCount?: number;
  candidateCount?: number;
  compact?: boolean;
  note?: string;
};

function factValue(value: number | undefined, stage: PlaylistWorkStage): string {
  if (typeof value !== "number") return "—";
  if (value === 0 && (stage === "queue" || stage === "research")) return "—";
  return value.toLocaleString("en-US");
}

export function WorkingIndicator({
  stage,
  motion,
  phaseLabel,
  sourceCount,
  candidateCount,
  compact = false,
  note,
}: WorkingIndicatorProps) {
  const currentIndex = stages.findIndex((item) => item.id === stage);
  const active = motion === "active";
  const stateLabel = motion === "paused" ? "PAUSED" : motion === "idle" ? "STOPPED" : "LIVE";

  return (
    <div
      className={`working-indicator working-indicator-${motion}${compact ? " is-compact" : ""}`}
      data-testid="working-indicator"
    >
      <div className="working-indicator-header">
        <span>PROCESS SIGNAL</span>
        <span className="working-live-state">
          <span className="working-live-dot" aria-hidden="true" />
          {stateLabel}
        </span>
      </div>

      <div className="working-signal" aria-hidden="true">
        {Array.from({ length: 24 }, (_, index) => (
          <i
            className="working-signal-bar"
            key={index}
            style={{ animationDelay: `${index * -0.085}s` }}
          />
        ))}
        <span className="working-signal-sweep" />
      </div>

      {!compact && (
        <ol className="working-stage-rail" aria-label={`Playlist creation stage ${currentIndex + 1} of ${stages.length}`}>
          {stages.map((item, index) => {
            const state = index < currentIndex ? "complete" : index === currentIndex ? "current" : "upcoming";
            return (
              <li key={item.id} className={`is-${state}`} aria-current={state === "current" ? "step" : undefined}>
                <span aria-hidden="true">{state === "complete" ? "✓" : state === "current" ? "▶" : "·"}</span>
                {item.label}
              </li>
            );
          })}
        </ol>
      )}

      <p className="working-phase" role="status" aria-live="polite">
        <span className="sr-only">{active ? "Work in progress. " : ""}</span>
        {phaseLabel}
      </p>

      {!compact && (
        <div className="working-facts" aria-label="Current research totals">
          <span><small>SOURCES</small><strong>{factValue(sourceCount, stage)}</strong></span>
          <span><small>TRACKS FOUND</small><strong>{factValue(candidateCount, stage)}</strong></span>
        </div>
      )}

      {note && <p className="working-note">{note}</p>}
    </div>
  );
}

