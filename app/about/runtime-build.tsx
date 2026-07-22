"use client";

import { useEffect, useState } from "react";
import { currentRelease } from "../../shared/release-metadata";

type RuntimeBuildPayload = {
  build?: {
    identifier?: unknown;
    revision?: unknown;
    version?: unknown;
  };
  runtime?: {
    pipelineVersion?: unknown;
    assignmentEnabled?: unknown;
    ownerCanaryEnabled?: unknown;
    productionEvidenceApproved?: unknown;
    factualFeasibilityApproved?: unknown;
    schemaVersion?: unknown;
    workerProtocol?: unknown;
    selectionPlanVersion?: unknown;
    queryPlanSchemaVersion?: unknown;
    queryPlanPolicyVersion?: unknown;
    semanticScopePolicyVersion?: unknown;
    musicConceptPolicyVersion?: unknown;
    pipelinePolicyVersion?: unknown;
    promptVersion?: unknown;
    baselineProviderModelId?: unknown;
    escalationProviderModelId?: unknown;
    modelResolutionMode?: unknown;
    modelCatalogValidatedAt?: unknown;
    graphSnapshot?: {
      id?: unknown;
      assertionCount?: unknown;
      catalogIdentityCount?: unknown;
      lockedAt?: unknown;
    } | null;
  };
};

type RuntimeBuildState =
  | { status: "checking" }
  | {
      status: "available";
      identifier: string;
      version: string;
      details: ReadonlyArray<readonly [string, string]>;
    }
  | { status: "unavailable" };

function safeBuildText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || !/^[0-9A-Za-z][0-9A-Za-z._+-]*$/u.test(normalized)) return null;
  return normalized;
}

function safeBuildTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? value : null;
}

function safeBuildRevision(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return /^[0-9a-f]{7,64}$/u.test(normalized) ? normalized : null;
}

export function RuntimeBuild() {
  const [runtime, setRuntime] = useState<RuntimeBuildState>({ status: "checking" });

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/health/live", {
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error("The API build endpoint is unavailable");
      const payload = await response.json() as RuntimeBuildPayload;
      const identifier = safeBuildText(payload.build?.identifier, 140);
      const version = safeBuildText(payload.build?.version, 64);
      if (!identifier || !version) throw new Error("The API build response is invalid");
      const revision = safeBuildRevision(payload.build?.revision);
      const contract = payload.runtime;
      const graph = contract?.graphSnapshot;
      const graphId = safeBuildText(graph?.id, 140);
      const graphLabel = graphId
        ? `${graphId.slice(0, 12)} · ${Number(graph?.assertionCount ?? 0)} ASSERTIONS`
        : "NOT BOOTSTRAPPED";
      const rollout = contract?.assignmentEnabled === true
        ? contract.ownerCanaryEnabled === true ? "OWNER CANARY" : "ACTIVE"
        : "DISABLED";
      const details: Array<readonly [string, string]> = [
        ["BUILD REVISION", revision?.slice(0, 12) ?? "UNAVAILABLE"],
        ["PIPELINE", safeBuildText(contract?.pipelineVersion, 64) ?? "UNKNOWN"],
        ["ROLLOUT", rollout],
        ["PRODUCTION EVIDENCE", contract?.productionEvidenceApproved === true ? "APPROVED" : "NOT APPROVED"],
        ["FACTUAL FEASIBILITY", contract?.factualFeasibilityApproved === true ? "APPROVED" : "NOT APPROVED"],
        ["DATABASE SCHEMA", safeBuildText(contract?.schemaVersion, 24) ?? "UNKNOWN"],
        ["WORKER PROTOCOL", safeBuildText(contract?.workerProtocol, 64) ?? "UNKNOWN"],
        ["SELECTION PLAN", safeBuildText(contract?.selectionPlanVersion, 80) ?? "UNKNOWN"],
        ["QUERY PLAN SCHEMA", safeBuildText(contract?.queryPlanSchemaVersion, 24) ?? "UNKNOWN"],
        ["QUERY POLICY", safeBuildText(contract?.queryPlanPolicyVersion, 80) ?? "UNKNOWN"],
        ["SEMANTIC SCOPE POLICY", safeBuildText(contract?.semanticScopePolicyVersion, 80) ?? "UNKNOWN"],
        ["MUSIC CONCEPT POLICY", safeBuildText(contract?.musicConceptPolicyVersion, 80) ?? "UNKNOWN"],
        ["PIPELINE POLICY", safeBuildText(contract?.pipelinePolicyVersion, 80) ?? "UNKNOWN"],
        ["PROMPT", safeBuildText(contract?.promptVersion, 80) ?? "UNKNOWN"],
        ["BASELINE PROVIDER MODEL", safeBuildText(contract?.baselineProviderModelId, 80) ?? "UNKNOWN"],
        ["ESCALATION PROVIDER MODEL", safeBuildText(contract?.escalationProviderModelId, 80) ?? "UNKNOWN"],
        ["MODEL RESOLUTION", safeBuildText(contract?.modelResolutionMode, 80) ?? "UNKNOWN"],
        ["MODEL CATALOG CHECKED", safeBuildTimestamp(contract?.modelCatalogValidatedAt) ?? "UNKNOWN"],
        ["GRAPH SNAPSHOT", graphLabel],
      ];
      setRuntime({ status: "available", identifier, version, details });
    }).catch((caught: unknown) => {
      if ((caught as { name?: string })?.name !== "AbortError") setRuntime({ status: "unavailable" });
    });
    return () => controller.abort();
  }, []);

  const apiBuild = runtime.status === "checking"
    ? "CHECKING…"
    : runtime.status === "unavailable"
      ? "UNAVAILABLE"
      : runtime.identifier;
  const deploymentState = runtime.status === "available"
    ? runtime.version === currentRelease.version ? "IN SYNC" : "VERSION MISMATCH"
    : runtime.status === "checking" ? "CHECKING" : "STATUS UNKNOWN";

  return (
    <section className="about-builds" aria-labelledby="about-builds-title">
      <div className="about-section-heading">
        <h2 id="about-builds-title">Running now</h2>
        <span className={deploymentState === "VERSION MISMATCH" ? "is-warning" : ""}>{deploymentState}</span>
      </div>
      <dl className="about-build-grid" aria-live="polite">
        <div>
          <dt>WEB RELEASE</dt>
          <dd>v{currentRelease.version}</dd>
        </div>
        <div>
          <dt>API BUILD</dt>
          <dd>{apiBuild}</dd>
        </div>
        {runtime.status === "available" && runtime.details.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value.replaceAll("_", " ")}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
