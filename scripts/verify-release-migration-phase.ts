import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { ReleaseDeploymentPhase } from "../server/release-deployment-phase.ts";

type MigrationVerificationPhase = Extract<
  ReleaseDeploymentPhase,
  "bridge" | "expand"
>;
type JsonRecord = Record<string, unknown>;

export interface ReleaseMigrationVerificationArgs {
  origin: string;
  expectedRevision: string;
  expectedVersion: string;
  expectedSchemaVersion: string;
  expectedDatabaseCapabilityVersion: "2" | null;
  expectedReleaseManifestCanaryGuardsVersion: "1" | null;
  expectedCanonicalExecutionHardeningVersion: "1" | null;
  phase: MigrationVerificationPhase;
  samples: number;
  intervalMs: number;
}

export interface ReleaseMigrationWorkerLaneObservation {
  status: string | null;
  protocolVersion: string | null;
  compatibleCapacity: number;
  eligibleWorkerCount: number;
  eligibleRevisions: string[];
  eligibleConfigurationHashes: string[];
  lastSeenAt: string | null;
}

export interface ReleaseMigrationObservation {
  observedAt: string;
  apiVersion: string | null;
  apiRevision: string | null;
  apiConfigurationHash: string | null;
  deploymentPhase: string | null;
  expectedDatabaseSchemaVersion: string | null;
  canonicalActivationConfigured: boolean;
  runtimeSchemaMinimum: string | null;
  runtimeSchemaMaximum: string | null;
  runtimeWorkerProtocol: string | null;
  runtimeBriefContractVersion: string | null;
  runtimeQueryPlanSchemaVersion: string | null;
  readyHttpStatus: number;
  ready: boolean;
  databaseSchemaVersion: string | null;
  databaseCapabilityVersion: string | null;
  releaseManifestCanaryGuardsVersion: string | null;
  canonicalExecutionHardeningVersion: string | null;
  systemHttpStatus: number;
  systemOk: boolean;
  activationReady: boolean;
  systemDatabaseSchemaVersion: string | null;
  workerLanes: {
    interactive: ReleaseMigrationWorkerLaneObservation;
    deep: ReleaseMigrationWorkerLaneObservation;
  };
}

export interface ReleaseMigrationPhaseEvidence {
  schemaVersion: "genio-release-migration-phase/v2";
  generatedAt: string;
  expiresAt: string;
  origin: string;
  expected: {
    revision: string;
    version: string;
    databaseSchemaVersion: string;
    databaseCapabilityVersion: "2" | null;
    releaseManifestCanaryGuardsVersion: "1" | null;
    canonicalExecutionHardeningVersion: "1" | null;
    phase: MigrationVerificationPhase;
    samples: number;
    minimumObservationSpanMs: 30_000;
  };
  observationSpanMs: number;
  passed: boolean;
  violations: string[];
  observations: ReleaseMigrationObservation[];
  evidenceHash: string;
}

const EVIDENCE_TTL_MS = 24 * 60 * 60 * 1_000;
const REQUIRED_WORKER_PROTOCOL = "playlist-pipeline-v11";
const REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function text(value: unknown, maximum = 160): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maximum ? normalized : null;
}

function nonnegative(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

function strings(value: unknown, pattern: RegExp): string[] {
  return Array.isArray(value)
    ? [...new Set(value
      .filter((item): item is string => typeof item === "string" && pattern.test(item))
      .map((item) => item.toLowerCase()))].sort()
    : [];
}

function lane(value: unknown): ReleaseMigrationWorkerLaneObservation {
  const input = record(value);
  return {
    status: text(input.status),
    protocolVersion: text(input.protocolVersion),
    compatibleCapacity: nonnegative(input.compatibleCapacity),
    eligibleWorkerCount: nonnegative(input.eligibleWorkerCount),
    eligibleRevisions: strings(input.eligibleRevisions, /^(?:[0-9a-f]{7,64})$/iu),
    eligibleConfigurationHashes: strings(input.eligibleConfigurationHashes, /^[0-9a-f]{64}$/iu),
    lastSeenAt: text(input.lastSeenAt),
  };
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as JsonRecord)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stable(item)]),
  );
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function integer(value: string | undefined, name: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return parsed;
}

export function parseReleaseMigrationVerificationArgs(
  argv: readonly string[],
): ReleaseMigrationVerificationArgs {
  const acceptedOptions = new Set([
    "--origin",
    "--expected-revision",
    "--expected-version",
    "--expected-schema",
    "--expected-capability",
    "--expected-manifest-canary-guards",
    "--expected-canonical-hardening",
    "--phase",
    "--samples",
    "--interval-seconds",
  ]);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index] ?? "";
    const value = argv[index + 1] ?? "";
    if (
      !acceptedOptions.has(name)
      || !value
      || value.startsWith("--")
      || values.has(name)
    ) {
      throw new Error(`Invalid release migration verification argument: ${name || "(missing)"}`);
    }
    values.set(name, value);
  }
  const phase = values.get("--phase");
  if (phase !== "bridge" && phase !== "expand") {
    throw new Error("--phase must be bridge or expand");
  }
  const expectedSchemaVersion = values.get("--expected-schema") ?? "";
  if (!/^(?:1[3-9])$/u.test(expectedSchemaVersion)) {
    throw new Error("--expected-schema must be an integer from 13 through 19");
  }
  if (phase === "expand" && expectedSchemaVersion !== "19") {
    throw new Error("expand verification requires --expected-schema 19");
  }
  const expectedCapabilityValue = values.get("--expected-capability");
  if (
    expectedCapabilityValue !== "2"
    && expectedCapabilityValue !== "none"
  ) {
    throw new Error("--expected-capability must be 2 or none");
  }
  const expectedDatabaseCapabilityVersion =
    expectedCapabilityValue === "2" ? "2" : null;
  const expectedManifestCanaryGuardsValue =
    values.get("--expected-manifest-canary-guards");
  if (
    expectedManifestCanaryGuardsValue !== "1"
    && expectedManifestCanaryGuardsValue !== "none"
  ) {
    throw new Error("--expected-manifest-canary-guards must be 1 or none");
  }
  const expectedReleaseManifestCanaryGuardsVersion =
    expectedManifestCanaryGuardsValue === "1" ? "1" : null;
  const expectedCanonicalHardeningValue =
    values.get("--expected-canonical-hardening");
  if (
    expectedCanonicalHardeningValue !== "1"
    && expectedCanonicalHardeningValue !== "none"
  ) {
    throw new Error("--expected-canonical-hardening must be 1 or none");
  }
  const expectedCanonicalExecutionHardeningVersion =
    expectedCanonicalHardeningValue === "1" ? "1" : null;
  const schemaCapabilityActive = Number(expectedSchemaVersion) >= 18;
  if (
    (schemaCapabilityActive && (
      expectedDatabaseCapabilityVersion !== "2"
      || expectedReleaseManifestCanaryGuardsVersion !== "1"
      || expectedCanonicalExecutionHardeningVersion !== "1"
    ))
    || (!schemaCapabilityActive && (
      expectedDatabaseCapabilityVersion !== null
      || expectedReleaseManifestCanaryGuardsVersion !== null
      || expectedCanonicalExecutionHardeningVersion !== null
    ))
  ) {
    throw new Error(
      "schemas 18 and 19 require composite capability 2, manifest-canary marker 1, and canonical-hardening marker 1; schemas 13 through 17 require none",
    );
  }
  const expectedRevision = (values.get("--expected-revision") ?? "").toLowerCase();
  if (!REVISION.test(expectedRevision)) {
    throw new Error("--expected-revision must be a full hexadecimal Git revision");
  }
  const expectedVersion = values.get("--expected-version") ?? "";
  if (!VERSION.test(expectedVersion)) {
    throw new Error("--expected-version must be a stable semantic version");
  }
  const originValue = values.get("--origin") ?? "";
  let origin: URL;
  try {
    origin = new URL(originValue);
  } catch {
    throw new Error("--origin must be an HTTPS origin");
  }
  if (
    origin.protocol !== "https:"
    || origin.username
    || origin.password
    || origin.pathname !== "/"
    || origin.search
    || origin.hash
  ) {
    throw new Error("--origin must be an HTTPS origin");
  }
  return {
    origin: origin.origin,
    expectedRevision,
    expectedVersion,
    expectedSchemaVersion,
    expectedDatabaseCapabilityVersion,
    expectedReleaseManifestCanaryGuardsVersion,
    expectedCanonicalExecutionHardeningVersion,
    phase,
    samples: integer(values.get("--samples") ?? "2", "--samples", 2, 5),
    intervalMs: integer(
      values.get("--interval-seconds") ?? "30",
      "--interval-seconds",
      30,
      120,
    ) * 1_000,
  };
}

export function releaseMigrationObservation(input: {
  observedAt: string;
  livePayload: unknown;
  readyPayload: unknown;
  readyHttpStatus: number;
  systemPayload: unknown;
  systemHttpStatus: number;
}): ReleaseMigrationObservation {
  const live = record(input.livePayload);
  const build = record(live.build);
  const runtime = record(live.runtime);
  const ready = record(input.readyPayload);
  const system = record(input.systemPayload);
  const lanes = record(system.workerLanes);
  const releaseManifestCanaryGuardsVersion = text(
    ready.releaseManifestCanaryGuardsVersion,
  );
  const canonicalExecutionHardeningVersion = text(
    ready.canonicalExecutionHardeningVersion,
  );
  return {
    observedAt: input.observedAt,
    apiVersion: text(build.version ?? live.version, 64),
    apiRevision: text(build.revision ?? live.revision, 64)?.toLowerCase() ?? null,
    apiConfigurationHash: text(live.configurationHash, 64)?.toLowerCase() ?? null,
    deploymentPhase: text(runtime.deploymentPhase),
    expectedDatabaseSchemaVersion: text(runtime.expectedDatabaseSchemaVersion),
    canonicalActivationConfigured: runtime.canonicalActivationConfigured === true,
    runtimeSchemaMinimum: text(runtime.schemaMinimum),
    runtimeSchemaMaximum: text(runtime.schemaMaximum),
    runtimeWorkerProtocol: text(runtime.workerProtocol),
    runtimeBriefContractVersion: text(runtime.briefContractVersion),
    runtimeQueryPlanSchemaVersion: text(runtime.queryPlanSchemaVersion),
    readyHttpStatus: input.readyHttpStatus,
    ready: ready.ok === true && ready.database === true,
    databaseSchemaVersion: text(ready.schemaVersion),
    databaseCapabilityVersion:
      releaseManifestCanaryGuardsVersion === "1"
      && canonicalExecutionHardeningVersion === "1"
        ? "2"
        : null,
    releaseManifestCanaryGuardsVersion,
    canonicalExecutionHardeningVersion,
    systemHttpStatus: input.systemHttpStatus,
    systemOk: system.ok === true,
    activationReady: system.activationReady === true,
    systemDatabaseSchemaVersion: text(system.schemaVersion),
    workerLanes: {
      interactive: lane(lanes.interactive),
      deep: lane(lanes.deep),
    },
  };
}

export function buildReleaseMigrationPhaseEvidence(input: {
  origin: string;
  expectedRevision: string;
  expectedVersion: string;
  expectedDatabaseSchemaVersion: string;
  expectedDatabaseCapabilityVersion: "2" | null;
  expectedReleaseManifestCanaryGuardsVersion: "1" | null;
  expectedCanonicalExecutionHardeningVersion: "1" | null;
  phase: MigrationVerificationPhase;
  expectedSamples: number;
  observations: readonly ReleaseMigrationObservation[];
  generatedAt?: string;
}): ReleaseMigrationPhaseEvidence {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const violations: string[] = [];
  if (input.expectedSamples < 2 || input.observations.length !== input.expectedSamples) {
    violations.push(`sample_count:${input.observations.length}/${input.expectedSamples}`);
  }
  const previousHeartbeat = {
    interactive: Number.NEGATIVE_INFINITY,
    deep: Number.NEGATIVE_INFINITY,
  };
  const observationTimes: number[] = [];
  let previousObservedAt = Number.NEGATIVE_INFINITY;
  for (const [index, observation] of input.observations.entries()) {
    const label = `sample_${index + 1}`;
    const observedAt = Date.parse(observation.observedAt);
    if (!Number.isFinite(observedAt) || observedAt <= previousObservedAt) {
      violations.push(`${label}:observation_timestamp_not_advanced`);
    }
    if (Number.isFinite(observedAt)) observationTimes.push(observedAt);
    previousObservedAt = observedAt;
    if (observation.apiVersion !== input.expectedVersion) {
      violations.push(`${label}:api_version:${observation.apiVersion ?? "missing"}`);
    }
    if (observation.apiRevision !== input.expectedRevision) {
      violations.push(`${label}:api_revision:${observation.apiRevision ?? "missing"}`);
    }
    if (!observation.apiConfigurationHash
      || !/^[0-9a-f]{64}$/u.test(observation.apiConfigurationHash)) {
      violations.push(`${label}:api_configuration_unproven`);
    }
    if (observation.deploymentPhase !== input.phase) {
      violations.push(`${label}:deployment_phase:${observation.deploymentPhase ?? "missing"}`);
    }
    if (observation.expectedDatabaseSchemaVersion !== input.expectedDatabaseSchemaVersion) {
      violations.push(
        `${label}:expected_database_schema:${observation.expectedDatabaseSchemaVersion ?? "missing"}`,
      );
    }
    if (observation.canonicalActivationConfigured) {
      violations.push(`${label}:canonical_activation_enabled_before_activate`);
    }
    if (observation.runtimeSchemaMinimum !== "13" || observation.runtimeSchemaMaximum !== "19") {
      violations.push(`${label}:schema_bridge_support_missing`);
    }
    if (observation.runtimeWorkerProtocol !== REQUIRED_WORKER_PROTOCOL) {
      violations.push(`${label}:runtime_worker_protocol:${observation.runtimeWorkerProtocol ?? "missing"}`);
    }
    if (
      observation.runtimeBriefContractVersion === "3"
      || observation.runtimeQueryPlanSchemaVersion === "4"
      || observation.runtimeQueryPlanSchemaVersion === "5"
      || observation.runtimeQueryPlanSchemaVersion === "6"
    ) {
      violations.push(`${label}:canonical_emission_not_disabled`);
    }
    if (
      observation.readyHttpStatus !== 200
      || !observation.ready
      || observation.databaseSchemaVersion !== input.expectedDatabaseSchemaVersion
      || observation.systemDatabaseSchemaVersion !== input.expectedDatabaseSchemaVersion
    ) {
      violations.push(`${label}:database_schema_not_ready`);
    }
    if (
      observation.databaseCapabilityVersion
        !== input.expectedDatabaseCapabilityVersion
    ) {
      violations.push(
        `${label}:database_capability:${observation.databaseCapabilityVersion ?? "missing"}`,
      );
    }
    if (
      observation.releaseManifestCanaryGuardsVersion
        !== input.expectedReleaseManifestCanaryGuardsVersion
    ) {
      violations.push(
        `${label}:manifest_canary_guards:${observation.releaseManifestCanaryGuardsVersion ?? "missing"}`,
      );
    }
    if (
      observation.canonicalExecutionHardeningVersion
        !== input.expectedCanonicalExecutionHardeningVersion
    ) {
      violations.push(
        `${label}:canonical_execution_hardening:${observation.canonicalExecutionHardeningVersion ?? "missing"}`,
      );
    }
    if (observation.systemHttpStatus !== 200 || !observation.systemOk || !observation.activationReady) {
      violations.push(`${label}:worker_lanes_not_ready`);
    }
    for (const laneName of ["interactive", "deep"] as const) {
      const current = observation.workerLanes[laneName];
      if (
        current.status !== "healthy"
        || current.protocolVersion !== REQUIRED_WORKER_PROTOCOL
        || current.compatibleCapacity < 1
        || current.eligibleWorkerCount < 1
      ) {
        violations.push(`${label}:${laneName}_lane_unhealthy`);
      }
      if (
        current.eligibleRevisions.length !== 1
        || current.eligibleRevisions[0] !== input.expectedRevision
      ) {
        violations.push(`${label}:${laneName}_revision_overlap`);
      }
      if (current.eligibleConfigurationHashes.length !== 1) {
        violations.push(`${label}:${laneName}_configuration_unproven`);
      }
      const lastSeenAt = current.lastSeenAt ? Date.parse(current.lastSeenAt) : Number.NaN;
      if (
        !Number.isFinite(lastSeenAt)
        || lastSeenAt > observedAt + 5_000
        || observedAt - lastSeenAt > 120_000
      ) {
        violations.push(`${label}:${laneName}_heartbeat_stale`);
      }
      if (index > 0 && lastSeenAt <= previousHeartbeat[laneName]) {
        violations.push(`${label}:${laneName}_heartbeat_not_advanced`);
      }
      previousHeartbeat[laneName] = lastSeenAt;
    }
  }
  const apiConfigurationHashes = new Set(
    input.observations.map(({ apiConfigurationHash }) => apiConfigurationHash),
  );
  if (apiConfigurationHashes.size !== 1) {
    violations.push("api_configuration_changed_during_observation");
  }
  for (const laneName of ["interactive", "deep"] as const) {
    const laneConfigurationHashes = new Set(input.observations.flatMap(
      (observation) => observation.workerLanes[laneName].eligibleConfigurationHashes,
    ));
    if (laneConfigurationHashes.size !== 1) {
      violations.push(`${laneName}_configuration_changed_during_observation`);
    }
  }
  const observationSpanMs = observationTimes.length < 2
    ? 0
    : Math.max(
      0,
      observationTimes[observationTimes.length - 1]!
        - observationTimes[0]!,
    );
  if (observationSpanMs < 30_000) {
    violations.push(`observation_span_too_short:${observationSpanMs}/30000`);
  }
  const unsigned = {
    schemaVersion: "genio-release-migration-phase/v2" as const,
    generatedAt,
    expiresAt: new Date(Date.parse(generatedAt) + EVIDENCE_TTL_MS).toISOString(),
    origin: input.origin,
    expected: {
      revision: input.expectedRevision,
      version: input.expectedVersion,
      databaseSchemaVersion: input.expectedDatabaseSchemaVersion,
      databaseCapabilityVersion: input.expectedDatabaseCapabilityVersion,
      releaseManifestCanaryGuardsVersion:
        input.expectedReleaseManifestCanaryGuardsVersion,
      canonicalExecutionHardeningVersion:
        input.expectedCanonicalExecutionHardeningVersion,
      phase: input.phase,
      samples: input.expectedSamples,
      minimumObservationSpanMs: 30_000 as const,
    },
    observationSpanMs,
    passed: violations.length === 0,
    violations,
    observations: [...input.observations],
  };
  return {
    ...unsigned,
    evidenceHash: sha256(unsigned),
  };
}

async function response(
  url: string,
  deadlineAt: number,
): Promise<{ status: number; json: unknown }> {
  const timeoutMs = Math.min(15_000, deadlineAt - Date.now());
  if (timeoutMs <= 0) {
    throw new Error("release migration phase verification exceeded its deadline");
  }
  const value = await fetch(url, {
    cache: "no-store",
    redirect: "error",
    headers: { "cache-control": "no-cache", pragma: "no-cache" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await value.text();
  let json: unknown = {};
  try {
    json = body ? JSON.parse(body) : {};
  } catch {
    // Raw provider or application bodies are never retained in evidence.
  }
  return { status: value.status, json };
}

export async function collectReleaseMigrationPhaseEvidence(
  args: ReleaseMigrationVerificationArgs,
  deadlineAt = Date.now()
    + args.samples * 45_000
    + Math.max(0, args.samples - 1) * args.intervalMs,
): Promise<ReleaseMigrationPhaseEvidence> {
  const observations: ReleaseMigrationObservation[] = [];
  for (let index = 0; index < args.samples; index += 1) {
    if (Date.now() >= deadlineAt) {
      throw new Error("release migration phase verification exceeded its deadline");
    }
    const nonce = randomUUID();
    const observedAt = new Date().toISOString();
    const [live, ready, system] = await Promise.all([
      response(`${args.origin}/health/live?release-migration=${nonce}`, deadlineAt),
      response(`${args.origin}/health/ready?release-migration=${nonce}`, deadlineAt),
      response(`${args.origin}/health/system?release-migration=${nonce}`, deadlineAt),
    ]);
    if (live.status !== 200) throw new Error(`API liveness probe returned HTTP ${live.status}`);
    observations.push(releaseMigrationObservation({
      observedAt,
      livePayload: live.json,
      readyPayload: ready.json,
      readyHttpStatus: ready.status,
      systemPayload: system.json,
      systemHttpStatus: system.status,
    }));
    if (index + 1 < args.samples && args.intervalMs > 0) {
      const delay = Math.min(args.intervalMs, deadlineAt - Date.now());
      if (delay !== args.intervalMs) {
        throw new Error("release migration phase verification exceeded its deadline");
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  return buildReleaseMigrationPhaseEvidence({
    origin: args.origin,
    expectedRevision: args.expectedRevision,
    expectedVersion: args.expectedVersion,
    expectedDatabaseSchemaVersion: args.expectedSchemaVersion,
    expectedDatabaseCapabilityVersion:
      args.expectedDatabaseCapabilityVersion,
    expectedReleaseManifestCanaryGuardsVersion:
      args.expectedReleaseManifestCanaryGuardsVersion,
    expectedCanonicalExecutionHardeningVersion:
      args.expectedCanonicalExecutionHardeningVersion,
    phase: args.phase,
    expectedSamples: args.samples,
    observations,
  });
}

async function main(): Promise<void> {
  const args = parseReleaseMigrationVerificationArgs(process.argv.slice(2));
  const evidence = await collectReleaseMigrationPhaseEvidence(args);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  if (!evidence.passed) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: "release_migration_phase_verification_failed",
      message: error instanceof Error ? error.message : "Release migration verification failed",
    })}\n`);
    process.exitCode = 1;
  });
}
