"use client";

import { useEffect, useMemo, useState } from "react";
import type { RunProgressView } from "../shared/types.ts";
import type { PlaylistWorkMotion, PlaylistWorkStage } from "./playlist-waiting-state";

const stages: Array<{ id: PlaylistWorkStage; label: string }> = [
  { id: "plan", label: "PLAN" },
  { id: "discover", label: "DISCOVER" },
  { id: "verify", label: "VERIFY" },
  { id: "match", label: "MATCH" },
  { id: "sequence", label: "SEQUENCE" },
  { id: "publish", label: "PUBLISH" },
];

const candidateStageOrder = [
  "discovered",
  "identity_resolved",
  "scope_qualified",
  "claim_verified",
  "version_compatible",
  "playable",
  "canonicalized",
  "catalog_resolved",
  "eligible",
  "quota_eligible",
  "selected",
  "sequenced",
  "manifested",
  "published",
] as const;

type CandidateStageCounts = Partial<Record<string, number>>;

type WorkingFrontierItem = {
  sourceClass: string;
  strategy: string;
  status: "pending" | "complete" | "inaccessible" | "unresolved";
  discoveredCount: number;
  recoveredCount: number;
  note?: string;
};

type WorkingDetails = {
  relationship?: string;
  evidencePolicy?: string;
  versionPolicy?: string;
  intents?: string[];
  storefront?: string;
  pipelineVersion?: string;
};

type WorkingIndicatorProps = {
  stage: PlaylistWorkStage;
  motion: PlaylistWorkMotion;
  phaseLabel: string;
  sourceCount?: number;
  candidateCount?: number;
  unresolvedCount?: number;
  targetCount?: number | null;
  reserveCount?: number | null;
  candidateStageCounts?: CandidateStageCounts;
  frontier?: WorkingFrontierItem[];
  createdAt?: string;
  updatedAt?: string;
  progress?: RunProgressView;
  details?: WorkingDetails;
  compact?: boolean;
  note?: string;
};

function safeCount(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 0;
}

export function cumulativeCandidateCount(
  counts: CandidateStageCounts | undefined,
  startingAt: (typeof candidateStageOrder)[number],
): number | null {
  if (!counts || Object.keys(counts).length === 0) return null;
  const start = candidateStageOrder.indexOf(startingAt);
  if (start < 0) return null;
  return candidateStageOrder
    .slice(start)
    .reduce((total, candidateStage) => total + safeCount(counts[candidateStage]), 0);
}

function displayCount(value: number | null | undefined): string {
  if (typeof value !== "number") return "—";
  return value.toLocaleString("en-US");
}

function durationLabel(totalSeconds: number | null): string {
  if (totalSeconds === null) return "--:--";
  const seconds = Math.max(0, totalSeconds);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function relativeActivityLabel(now: number | null, updatedAt: string | undefined): string | null {
  if (now === null || !updatedAt) return null;
  const updated = Date.parse(updatedAt);
  if (!Number.isFinite(updated)) return null;
  const seconds = Math.max(0, Math.floor((now - updated) / 1000));
  if (seconds < 8) return "updated now";
  if (seconds < 60) return `updated ${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return `updated ${minutes}m ago`;
}

function litTraceCells(value: number | null | undefined): number {
  if (!value) return 0;
  return Math.min(18, Math.max(2, Math.ceil(Math.log2(value + 1) * 2)));
}

function activeTraceLane(stage: PlaylistWorkStage): "sources" | "evidence" | "apple" {
  if (stage === "discover" || stage === "plan") return "sources";
  if (stage === "verify") return "evidence";
  return "apple";
}

function useNow(active: boolean): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (!active) return;
    const startup = window.setTimeout(() => setNow(Date.now()), 0);
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.clearTimeout(startup);
      window.clearInterval(timer);
    };
  }, [active]);
  return now;
}

function TraceLane({
  id,
  label,
  value,
  active,
}: {
  id: string;
  label: string;
  value: number | null | undefined;
  active: boolean;
}) {
  const lit = litTraceCells(value);
  return (
    <div className={`working-trace-lane${active ? " is-active" : ""}`}>
      <span>{label}</span>
      <div className="working-trace-track">
        {Array.from({ length: 18 }, (_, index) => (
          <i key={`${id}-${index}`} className={index < lit ? "is-lit" : undefined} />
        ))}
        <b className="working-trace-pulse" />
      </div>
      <strong>{displayCount(value)}</strong>
    </div>
  );
}

export function WorkingIndicator({
  stage,
  motion,
  phaseLabel,
  sourceCount,
  candidateCount,
  unresolvedCount,
  targetCount,
  reserveCount,
  candidateStageCounts,
  frontier = [],
  createdAt,
  updatedAt,
  progress,
  details,
  compact = false,
  note,
}: WorkingIndicatorProps) {
  const currentIndex = stages.findIndex((item) => item.id === stage);
  const active = motion === "active";
  const stateLabel = motion === "action-required"
    ? "ACTION REQUIRED"
    : motion === "paused"
      ? "PAUSED"
      : motion === "idle"
        ? "STOPPED"
        : "LIVE";
  const now = useNow(active);
  const created = createdAt ? Date.parse(createdAt) : Number.NaN;
  const elapsedSeconds = now !== null && Number.isFinite(created)
    ? Math.floor((now - created) / 1000)
    : null;
  const qualifiedCount = cumulativeCandidateCount(candidateStageCounts, "scope_qualified");
  const playableCount = cumulativeCandidateCount(candidateStageCounts, "playable");
  const selectedCount = cumulativeCandidateCount(candidateStageCounts, "selected");
  const sourceTotal = progress?.sourceSummary.total ?? sourceCount;
  const appleReadyCount = playableCount === null && !progress
    ? null
    : Math.max(
      safeCount(playableCount),
      safeCount(progress?.matchSummary.accepted),
    );
  const readyForTarget = Math.max(
    safeCount(appleReadyCount),
    safeCount(selectedCount),
    safeCount(progress?.publicationSummary.appendedTracks),
  );
  const normalizedTarget = typeof targetCount === "number" && targetCount > 0
    ? Math.max(1, Math.floor(targetCount))
    : null;
  const targetCoverage = normalizedTarget !== null
    ? Math.min(100, Math.round((readyForTarget / normalizedTarget) * 100))
    : null;
  const recentSources = progress?.sourceSummary.recentSources ?? [];
  const latestActivityAt = progress?.latestActivityAt ?? updatedAt;
  const activeLane = activeTraceLane(stage);
  const frontierSummary = useMemo(() => ({
    complete: frontier.filter((item) => item.status === "complete").length,
    open: frontier.filter((item) => item.status !== "complete").length,
  }), [frontier]);
  const visibleFrontier = useMemo(() => [...frontier]
    .sort((left, right) => Number(left.status === "complete") - Number(right.status === "complete"))
    .slice(0, 4), [frontier]);
  const activityLabel = relativeActivityLabel(now, latestActivityAt ?? undefined);

  return (
    <div
      className={`working-indicator working-indicator-${motion}${compact ? " is-compact" : ""}`}
      data-testid="working-indicator"
      data-stage={stage}
      data-motion={motion}
    >
      <div className="working-indicator-header">
        <span>LIVE RESEARCH CONSOLE</span>
        <span className="working-live-state">
          <span className="working-live-dot" aria-hidden="true" />
          {stateLabel}
          {!compact && <time dateTime={createdAt}>{durationLabel(elapsedSeconds)}</time>}
        </span>
      </div>

      <div className="working-trace" aria-hidden="true">
        <TraceLane id="sources" label="SOURCES" value={sourceTotal} active={active && activeLane === "sources"} />
        <TraceLane id="evidence" label="EVIDENCE" value={qualifiedCount} active={active && activeLane === "evidence"} />
        <TraceLane id="apple" label="APPLE" value={appleReadyCount} active={active && activeLane === "apple"} />
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

      <div className="working-current-state">
        <span>CURRENT ACTION</span>
        <p className="working-phase" role="status" aria-live="polite" aria-atomic="true">
          <span className="sr-only">{active ? "Work in progress. " : ""}</span>
          {phaseLabel}
        </p>
        {!compact && activityLabel && <small>{activityLabel}</small>}
      </div>

      {!compact && normalizedTarget !== null && targetCoverage !== null && (
        <div
          className="working-target-progress"
          role="progressbar"
          aria-label="Catalog-ready tracks toward the playlist target"
          aria-valuemin={0}
          aria-valuemax={normalizedTarget}
          aria-valuenow={Math.min(normalizedTarget, readyForTarget)}
        >
          <div>
            <span>CATALOG-READY YIELD</span>
            <strong>{Math.min(normalizedTarget, readyForTarget).toLocaleString("en-US")} / {normalizedTarget.toLocaleString("en-US")}</strong>
          </div>
          <i aria-hidden="true"><b style={{ width: `${targetCoverage}%` }} /></i>
          <small>{Math.max(0, normalizedTarget - readyForTarget).toLocaleString("en-US")} still needed</small>
        </div>
      )}

      {!compact && (
        <div className="working-facts" aria-label="Current playlist research totals">
          <span><small>TARGET</small><strong>{typeof targetCount === "number" ? displayCount(targetCount) : "OPEN"}</strong></span>
          <span><small>DISCOVERED</small><strong>{displayCount(candidateCount)}</strong></span>
          <span><small>QUALIFIED</small><strong>{displayCount(qualifiedCount)}</strong></span>
          <span><small>APPLE READY</small><strong>{displayCount(appleReadyCount)}</strong></span>
          <span><small>SOURCES</small><strong>{displayCount(sourceTotal)}</strong></span>
          <span><small>OPEN GAPS</small><strong>{displayCount(unresolvedCount)}</strong></span>
        </div>
      )}

      {!compact && recentSources.length > 0 && (
        <section className="working-sources" aria-labelledby="working-sources-title">
          <div className="working-section-heading">
            <span id="working-sources-title">RECENT SOURCES</span>
            <small>latest documented activity</small>
          </div>
          <ul>
            {recentSources.map((source, index) => (
              <li key={`${source.domain}-${source.title}-${index}`}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <span>
                  <strong>{source.title}</strong>
                  <small>{source.domain}</small>
                </span>
                <b>{source.sourceClass.toUpperCase()}</b>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!compact && visibleFrontier.length > 0 && (
        <section className="working-frontier" aria-labelledby="working-frontier-title">
          <div className="working-section-heading">
            <span id="working-frontier-title">SOURCE FRONTIER</span>
            <small>{frontierSummary.complete} complete · {frontierSummary.open} open</small>
          </div>
          <ul>
            {visibleFrontier.map((item, index) => (
              <li key={`${item.sourceClass}-${item.strategy}-${index}`}>
                <span className={`working-frontier-state is-${item.status}`} aria-label={item.status} />
                <span>
                  <strong>{item.strategy}</strong>
                  <small>{item.sourceClass} · {safeCount(item.recoveredCount)} recovered</small>
                </span>
                <b>{item.status.toUpperCase()}</b>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!compact && details && (
        <details className="working-details">
          <summary>
            <span>RUN DETAILS</span>
            <small>scope, evidence, and policy</small>
          </summary>
          <dl>
            {details.intents && details.intents.length > 0 && <div><dt>INTENT</dt><dd>{details.intents.join(" · ")}</dd></div>}
            {details.relationship && <div><dt>SCOPE</dt><dd>{details.relationship}</dd></div>}
            {details.evidencePolicy && <div><dt>EVIDENCE</dt><dd>{details.evidencePolicy}</dd></div>}
            {details.versionPolicy && <div><dt>VERSIONS</dt><dd>{details.versionPolicy}</dd></div>}
            {details.storefront && <div><dt>CATALOG</dt><dd>{details.storefront.toUpperCase()} storefront</dd></div>}
            {details.pipelineVersion && <div><dt>PIPELINE</dt><dd>{details.pipelineVersion.replaceAll("_", " ")}</dd></div>}
            {typeof reserveCount === "number" && reserveCount > 0 && <div><dt>RESERVE</dt><dd>{reserveCount} qualified alternates sought</dd></div>}
            {typeof selectedCount === "number" && <div><dt>SELECTED</dt><dd>{selectedCount.toLocaleString("en-US")}</dd></div>}
            {progress && <div><dt>FRONTIER</dt><dd>{progress.frontierSummary.complete} of {progress.frontierSummary.total} strategies complete</dd></div>}
            {progress && <div><dt>CONTAINERS</dt><dd>{progress.containerSummary.complete} of {progress.containerSummary.total} enumerated</dd></div>}
            {progress && progress.matchSummary.attempted > 0 && <div><dt>APPLE MATCH</dt><dd>{progress.matchSummary.accepted} accepted · {progress.matchSummary.attempted} checked</dd></div>}
            {progress && progress.publicationSummary.totalTracks > 0 && <div><dt>PUBLISH</dt><dd>{progress.publicationSummary.appendedTracks} of {progress.publicationSummary.totalTracks} tracks appended</dd></div>}
          </dl>
        </details>
      )}

      {note && <p className="working-note">{note}</p>}
    </div>
  );
}
