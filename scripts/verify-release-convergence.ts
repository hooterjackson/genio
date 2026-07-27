import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const DEFAULT_ORIGIN = "https://9enio.com";
const DEFAULT_SAMPLES = 2;
const DEFAULT_INTERVAL_SECONDS = 30;
const EVIDENCE_TTL_MS = 24 * 60 * 60 * 1_000;
const RUNTIME_EVIDENCE_KEYS = [
  "pipelineVersion",
  "releaseEnvironment",
  "deploymentPhase",
  "expectedDatabaseSchemaVersion",
  "canonicalActivationConfigured",
  "assignmentEnabled",
  "ownerCanaryEnabled",
  "productionEvidenceApproved",
  "curatedHostedEvidenceApproved",
  "genreSceneEvidenceApproved",
  "geographicScopeEvidenceApproved",
  "factualFeasibilityApproved",
  "publicRolloutEvidenceHash",
  "publicRolloutStage",
  "schemaVersion",
  "schemaMinimum",
  "schemaMaximum",
  "schemaPreferred",
  "workerProtocol",
  "minimumWorkerProtocol",
  "selectionPlanVersion",
  "queryPlanSchemaVersion",
  "briefContractVersion",
  "guidanceContractOwnerCanaryEnabled",
  "guidanceContractReggaetonCanaryEnabled",
  "guidancePolicyVersion",
  "evidencePolicyVersion",
  "queryPlanPolicyVersion",
  "semanticScopePolicyVersion",
  "musicConceptPolicyVersion",
  "pipelinePolicyVersion",
  "promptVersion",
  "briefProviderModelId",
  "baselineProviderModelId",
  "escalationProviderModelId",
  "modelResolutionMode",
  "modelCatalogValidatedAt",
] as const;
const REQUIRED_RUNTIME_RELEASE = Object.freeze({
  releaseEnvironment: "production",
  deploymentPhase: "activate",
  expectedDatabaseSchemaVersion: "18",
  canonicalActivationConfigured: "true",
  schemaVersion: "18",
  schemaMaximum: "18",
  schemaPreferred: "18",
  workerProtocol: "playlist-pipeline-v10",
  queryPlanSchemaVersion: "5",
  briefContractVersion: "3",
});

type JsonRecord = Record<string, unknown>;
export type ReleaseConvergenceScope = "backend" | "full";

export interface ReleaseConvergenceArgs {
  origin: string;
  scope: ReleaseConvergenceScope;
  expectedRevision: string;
  expectedVersion: string;
  expectedSitesRevision: string;
  expectedSitesVersion: string;
  samples: number;
  intervalMs: number;
  expectedConfigurationHashes?: {
    api: string;
    interactiveWorker: string;
    deepWorker: string;
  };
}

export interface ReleaseConvergenceWorkerLane {
  status: string | null;
  protocolVersion: string | null;
  compatibleCapacity: number;
  eligibleWorkerCount: number;
  eligibleIdentityCount: number;
  eligibleRevisions: string[];
  eligibleConfigurationHashes: string[];
  lastSeenAt: string | null;
}

export interface ReleaseConvergenceObservation {
  observedAt: string;
  sitesVersion: string | null;
  sitesRevision: string | null;
  api: {
    identifier: string | null;
    version: string | null;
    revision: string | null;
    configurationHash: string | null;
  };
  runtime: JsonRecord;
  runtimeContractHash: string;
  systemHttpStatus: number;
  system: {
    ok: boolean;
    activationReady: boolean;
    database: string | null;
    releaseManifestCanaryGuardsVersion: string | null;
    canonicalExecutionHardeningVersion: string | null;
    paused: boolean;
    workerProtocol: {
      expected: string | null;
      minimumAccepted: string | null;
      actual: string | null;
    };
    workerLanes: {
      interactive: ReleaseConvergenceWorkerLane;
      deep: ReleaseConvergenceWorkerLane;
    };
    queue: {
      queued: number;
      leased: number;
      expiredLeases: number;
      failed: number;
      oldestQueuedSeconds: number;
    };
  };
}

export interface ReleaseConvergenceEvidence {
  schemaVersion: "genio-release-convergence/v2";
  generatedAt: string;
  expiresAt: string;
  origin: string;
  scope: ReleaseConvergenceScope;
  expected: {
    backend: {
      revision: string;
      version: string;
    };
    sites: {
      revision: string;
      version: string;
      candidateMatched: boolean;
    };
    samples: number;
    minimumObservationSpanMs: 30_000;
    configurationHashes: {
      api: string;
      interactiveWorker: string;
      deepWorker: string;
    };
  };
  observationSpanMs: number;
  passed: boolean;
  violations: string[];
  observations: ReleaseConvergenceObservation[];
  evidenceHash: string;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function safeText(value: unknown, maximum = 160): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized
    && normalized.length <= maximum
    && /^[0-9A-Za-z][0-9A-Za-z._:+-]*$/u.test(normalized)
    ? normalized
    : null;
}

function safeRevision(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return /^[0-9a-f]{7,64}$/u.test(normalized) ? normalized : null;
}

function safeFullRevision(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(normalized)
    ? normalized
    : null;
}

function safeTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? value : null;
}

function count(value: unknown): number {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? Math.max(0, Math.floor(normalized)) : 0;
}

function sortedJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as JsonRecord)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortedJsonValue(item)]),
  );
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortedJsonValue(value));
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function integerOption(value: string | undefined, label: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

export function parseReleaseConvergenceArgs(argv: readonly string[]): ReleaseConvergenceArgs {
  let origin = DEFAULT_ORIGIN;
  let scope: ReleaseConvergenceScope = "full";
  let expectedRevision = "";
  let expectedVersion = "";
  let expectedSitesRevision = "";
  let expectedSitesVersion = "";
  let samples = DEFAULT_SAMPLES;
  let intervalMs = DEFAULT_INTERVAL_SECONDS * 1_000;
  const configurationHashes: Partial<
    NonNullable<ReleaseConvergenceArgs["expectedConfigurationHashes"]>
  > = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--origin") {
      if (!value) throw new Error("--origin requires a value");
      origin = value;
    } else if (argument === "--scope") {
      if (value !== "backend" && value !== "full") {
        throw new Error("--scope must be backend or full");
      }
      scope = value;
    } else if (argument === "--expected-revision") {
      if (!value) throw new Error("--expected-revision requires a value");
      expectedRevision = value.trim().toLowerCase();
    } else if (argument === "--expected-version") {
      if (!value) throw new Error("--expected-version requires a value");
      expectedVersion = value.trim();
    } else if (argument === "--expected-sites-revision") {
      if (!value) throw new Error("--expected-sites-revision requires a value");
      expectedSitesRevision = value.trim().toLowerCase();
    } else if (argument === "--expected-sites-version") {
      if (!value) throw new Error("--expected-sites-version requires a value");
      expectedSitesVersion = value.trim();
    } else if (argument === "--samples") {
      samples = integerOption(value, "--samples", 2, 5);
    } else if (argument === "--interval-seconds") {
      intervalMs = integerOption(value, "--interval-seconds", 30, 120) * 1_000;
    } else if (argument === "--expected-api-configuration-hash") {
      configurationHashes.api = value;
    } else if (argument === "--expected-interactive-configuration-hash") {
      configurationHashes.interactiveWorker = value;
    } else if (argument === "--expected-deep-configuration-hash") {
      configurationHashes.deepWorker = value;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
    index += 1;
  }
  const parsedOrigin = new URL(origin);
  if (
    parsedOrigin.protocol !== "https:"
    || parsedOrigin.username
    || parsedOrigin.password
    || parsedOrigin.pathname !== "/"
    || parsedOrigin.search
    || parsedOrigin.hash
  ) {
    throw new Error("--origin must be an HTTPS origin with no path, query, or credentials");
  }
  if (!safeFullRevision(expectedRevision)) {
    throw new Error("--expected-revision must be a full hexadecimal Git revision");
  }
  if (!safeText(expectedVersion, 64)) {
    throw new Error("--expected-version is invalid");
  }
  expectedSitesRevision ||= expectedRevision;
  expectedSitesVersion ||= expectedVersion;
  if (!safeFullRevision(expectedSitesRevision)) {
    throw new Error("--expected-sites-revision must be a full hexadecimal Git revision");
  }
  if (!safeText(expectedSitesVersion, 64)) {
    throw new Error("--expected-sites-version is invalid");
  }
  const sitesCandidateMatched = expectedSitesRevision === expectedRevision
    && expectedSitesVersion === expectedVersion;
  if (
    (scope === "full" && !sitesCandidateMatched)
    || (scope === "backend" && sitesCandidateMatched)
  ) {
    throw new Error(
      scope === "full"
        ? "full convergence requires the candidate Sites identity"
        : "backend convergence requires the exact prior Sites identity",
    );
  }
  const configuredHashes = Object.values(configurationHashes);
  if (configuredHashes.length !== 0 && (
    configuredHashes.length !== 3
    || configuredHashes.some((value) => (
      typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)
    ))
  )) {
    throw new Error("all three expected service configuration hashes are required");
  }
  return {
    origin: parsedOrigin.origin,
    scope,
    expectedRevision,
    expectedVersion,
    expectedSitesRevision,
    expectedSitesVersion,
    samples,
    intervalMs,
    ...(configuredHashes.length === 3
      ? {
        expectedConfigurationHashes: configurationHashes as
          NonNullable<ReleaseConvergenceArgs["expectedConfigurationHashes"]>,
      }
      : {}),
  };
}

export function sitesVersionFromHtml(html: string): string | null {
  const match = /<html\b[^>]*\bdata-build-version=(?:"([^"]+)"|'([^']+)'|([^\s>]+))/iu.exec(html);
  return safeText(match?.[1] ?? match?.[2] ?? match?.[3], 64);
}

export function sitesRevisionFromHtml(html: string): string | null {
  const match = /<html\b[^>]*\bdata-build-revision=(?:"([^"]+)"|'([^']+)'|([^\s>]+))/iu.exec(html);
  return safeFullRevision(match?.[1] ?? match?.[2] ?? match?.[3]);
}

function runtimeEvidence(value: unknown): JsonRecord {
  const source = asRecord(value);
  return Object.fromEntries(RUNTIME_EVIDENCE_KEYS.flatMap((key) => {
    const item = source[key];
    return typeof item === "string" || typeof item === "boolean" || typeof item === "number" || item === null
      ? [[key, item]]
      : [];
  }));
}

function workerLane(value: unknown): ReleaseConvergenceWorkerLane {
  const source = asRecord(value);
  const eligibleRevisions = Array.isArray(source.eligibleRevisions)
    ? [...new Set(source.eligibleRevisions
      .map((item) => safeRevision(item) ?? safeText(item, 128)?.toLowerCase() ?? null)
      .filter((item): item is string => Boolean(item)))]
      .sort()
    : [];
  const eligibleConfigurationHashes = Array.isArray(source.eligibleConfigurationHashes)
    ? [...new Set(source.eligibleConfigurationHashes
      .filter((item): item is string => typeof item === "string" && /^[0-9a-f]{64}$/u.test(item)))]
      .sort()
    : [];
  return {
    status: safeText(source.status, 40),
    protocolVersion: safeText(source.protocolVersion, 80),
    compatibleCapacity: count(source.compatibleCapacity),
    eligibleWorkerCount: count(source.eligibleWorkerCount),
    eligibleIdentityCount: count(source.eligibleIdentityCount),
    eligibleRevisions,
    eligibleConfigurationHashes,
    lastSeenAt: safeTimestamp(source.lastSeenAt),
  };
}

export function releaseConvergenceObservation(input: {
  observedAt: string;
  sitesHtml: string;
  livePayload: unknown;
  systemPayload: unknown;
  systemHttpStatus: number;
}): ReleaseConvergenceObservation {
  const live = asRecord(input.livePayload);
  const build = asRecord(live.build);
  const runtime = runtimeEvidence(live.runtime);
  const system = asRecord(input.systemPayload);
  const protocol = asRecord(system.workerProtocol);
  const lanes = asRecord(system.workerLanes);
  const queue = asRecord(system.queue);
  return {
    observedAt: safeTimestamp(input.observedAt) ?? new Date(0).toISOString(),
    sitesVersion: sitesVersionFromHtml(input.sitesHtml),
    sitesRevision: sitesRevisionFromHtml(input.sitesHtml),
    api: {
      identifier: safeText(build.identifier, 140),
      version: safeText(build.version, 64),
      revision: safeFullRevision(build.revision),
      configurationHash:
        typeof live.configurationHash === "string"
          && /^[0-9a-f]{64}$/u.test(live.configurationHash)
          ? live.configurationHash
          : null,
    },
    runtime,
    runtimeContractHash: sha256(runtime),
    systemHttpStatus: Number.isInteger(input.systemHttpStatus) ? input.systemHttpStatus : 0,
    system: {
      ok: system.ok === true,
      activationReady: system.activationReady === true,
      database: safeText(system.database, 40),
      releaseManifestCanaryGuardsVersion: safeText(
        system.releaseManifestCanaryGuardsVersion,
        40,
      ),
      canonicalExecutionHardeningVersion: safeText(
        system.canonicalExecutionHardeningVersion,
        40,
      ),
      paused: system.paused === true,
      workerProtocol: {
        expected: safeText(protocol.expected, 80),
        minimumAccepted: safeText(protocol.minimumAccepted, 80),
        actual: safeText(protocol.actual, 80),
      },
      workerLanes: {
        interactive: workerLane(lanes.interactive),
        deep: workerLane(lanes.deep),
      },
      queue: {
        queued: count(queue.queued),
        leased: count(queue.leased),
        expiredLeases: count(queue.expiredLeases),
        failed: count(queue.failed),
        oldestQueuedSeconds: count(queue.oldestQueuedSeconds),
      },
    },
  };
}

function revisionMatches(value: string, expected: string): boolean {
  return value === expected;
}

export function buildReleaseConvergenceEvidence(input: {
  origin: string;
  scope?: ReleaseConvergenceScope;
  expectedRevision: string;
  expectedVersion: string;
  expectedSitesRevision?: string;
  expectedSitesVersion?: string;
  expectedSamples: number;
  expectedConfigurationHashes: {
    api: string;
    interactiveWorker: string;
    deepWorker: string;
  };
  observations: readonly ReleaseConvergenceObservation[];
  generatedAt?: string;
}): ReleaseConvergenceEvidence {
  const generatedAt = safeTimestamp(input.generatedAt) ?? new Date().toISOString();
  const scope = input.scope ?? "full";
  const expectedSitesRevision =
    input.expectedSitesRevision ?? input.expectedRevision;
  const expectedSitesVersion =
    input.expectedSitesVersion ?? input.expectedVersion;
  const violations: string[] = [];
  const sitesCandidateMatched =
    expectedSitesRevision === input.expectedRevision
    && expectedSitesVersion === input.expectedVersion;
  if (
    (scope === "full" && !sitesCandidateMatched)
    || (scope === "backend" && sitesCandidateMatched)
  ) {
    violations.push(
      scope === "full"
        ? "full_scope_sites_identity_not_candidate"
        : "backend_scope_sites_identity_not_prior",
    );
  }
  if (input.expectedSamples < 2) {
    violations.push(`heartbeat_sample_requirement:${input.expectedSamples}/2`);
  }
  if (input.observations.length !== input.expectedSamples) {
    violations.push(`sample_count:${input.observations.length}/${input.expectedSamples}`);
  }
  for (const [service, hash] of Object.entries(input.expectedConfigurationHashes)) {
    if (!/^[0-9a-f]{64}$/u.test(hash)) {
      violations.push(`expected_${service}_configuration_invalid`);
    }
  }
  const runtimeHashes = new Set<string>();
  const laneConfigurationHashes = {
    interactive: new Set<string>(),
    deep: new Set<string>(),
  };
  let previousObservedAt = Number.NEGATIVE_INFINITY;
  const previousLaneHeartbeat = {
    interactive: Number.NEGATIVE_INFINITY,
    deep: Number.NEGATIVE_INFINITY,
  };
  for (const [index, observation] of input.observations.entries()) {
    const label = `sample_${index + 1}`;
    const observedAt = Date.parse(observation.observedAt);
    if (!Number.isFinite(observedAt) || (index > 0 && observedAt <= previousObservedAt)) {
      violations.push(`${label}:observation_timestamp_not_advanced`);
    }
    if (Number.isFinite(observedAt)) previousObservedAt = observedAt;
    if (observation.sitesVersion !== expectedSitesVersion) {
      violations.push(`${label}:sites_version:${observation.sitesVersion ?? "missing"}`);
    }
    if (!observation.sitesRevision
      || !revisionMatches(observation.sitesRevision, expectedSitesRevision)) {
      violations.push(`${label}:sites_revision:${observation.sitesRevision ?? "missing"}`);
    }
    if (observation.api.version !== input.expectedVersion) {
      violations.push(`${label}:api_version:${observation.api.version ?? "missing"}`);
    }
    if (!observation.api.revision || !revisionMatches(observation.api.revision, input.expectedRevision)) {
      violations.push(`${label}:api_revision:${observation.api.revision ?? "missing"}`);
    }
    if (observation.api.configurationHash
      !== input.expectedConfigurationHashes.api) {
      violations.push(`${label}:api_configuration_mismatch`);
    }
    if (observation.systemHttpStatus !== 200 || !observation.system.ok) {
      violations.push(`${label}:system_unhealthy:${observation.systemHttpStatus}`);
    }
    if (observation.system.database !== "ready") {
      violations.push(`${label}:database:${observation.system.database ?? "missing"}`);
    }
    if (observation.system.releaseManifestCanaryGuardsVersion !== "1") {
      violations.push(
        `${label}:database_capability:${observation.system.releaseManifestCanaryGuardsVersion ?? "missing"}`,
      );
    }
    if (observation.system.canonicalExecutionHardeningVersion !== "1") {
      violations.push(
        `${label}:canonical_execution_hardening:${
          observation.system.canonicalExecutionHardeningVersion ?? "missing"
        }`,
      );
    }
    if (!observation.system.activationReady) violations.push(`${label}:activation_not_ready`);
    if (observation.system.paused) violations.push(`${label}:system_paused`);
    for (const [key, expected] of Object.entries(REQUIRED_RUNTIME_RELEASE)) {
      const actual = observation.runtime[key];
      if (String(actual ?? "") !== expected) {
        violations.push(`${label}:runtime_${key}:${String(actual ?? "missing")}`);
      }
    }
    const expectedProtocol = safeText(observation.runtime.workerProtocol, 80);
    if (!expectedProtocol || observation.system.workerProtocol.expected !== expectedProtocol) {
      violations.push(`${label}:protocol_contract_mismatch`);
    }
    if (expectedProtocol && observation.system.workerProtocol.actual !== expectedProtocol) {
      violations.push(`${label}:protocol_actual:${observation.system.workerProtocol.actual ?? "missing"}`);
    }
    for (const laneName of ["interactive", "deep"] as const) {
      const lane = observation.system.workerLanes[laneName];
      if (lane.status !== "healthy"
        || lane.compatibleCapacity < 1
        || lane.eligibleWorkerCount < 1
        || lane.eligibleIdentityCount !== lane.eligibleWorkerCount) {
        violations.push(`${label}:${laneName}_lane_unhealthy`);
      }
      if (expectedProtocol && lane.protocolVersion !== expectedProtocol) {
        violations.push(`${label}:${laneName}_protocol:${lane.protocolVersion ?? "missing"}`);
      }
      if (
        lane.eligibleRevisions.length !== 1
        || !revisionMatches(lane.eligibleRevisions[0] ?? "", input.expectedRevision)
      ) {
        violations.push(`${label}:${laneName}_revisions:${lane.eligibleRevisions.join(",") || "missing"}`);
      }
      if (lane.eligibleConfigurationHashes.length !== 1) {
        violations.push(
          `${label}:${laneName}_configuration_hashes:${lane.eligibleConfigurationHashes.join(",") || "missing"}`,
        );
      } else {
        laneConfigurationHashes[laneName].add(lane.eligibleConfigurationHashes[0]!);
        const expectedLaneHash = laneName === "interactive"
          ? input.expectedConfigurationHashes.interactiveWorker
          : input.expectedConfigurationHashes.deepWorker;
        if (lane.eligibleConfigurationHashes[0] !== expectedLaneHash) {
          violations.push(`${label}:${laneName}_configuration_mismatch`);
        }
      }
      const lastSeenAt = lane.lastSeenAt ? Date.parse(lane.lastSeenAt) : Number.NaN;
      if (!Number.isFinite(lastSeenAt) || !Number.isFinite(observedAt)
        || lastSeenAt > observedAt + 5_000 || observedAt - lastSeenAt > 120_000) {
        violations.push(`${label}:${laneName}_heartbeat_stale`);
      }
      if (index > 0 && (!Number.isFinite(lastSeenAt) || lastSeenAt <= previousLaneHeartbeat[laneName])) {
        violations.push(`${label}:${laneName}_heartbeat_not_advanced`);
      }
      if (Number.isFinite(lastSeenAt)) previousLaneHeartbeat[laneName] = lastSeenAt;
    }
    runtimeHashes.add(observation.runtimeContractHash);
  }
  if (runtimeHashes.size > 1) violations.push("runtime_contract_changed_between_samples");
  for (const laneName of ["interactive", "deep"] as const) {
    if (laneConfigurationHashes[laneName].size > 1) {
      violations.push(`${laneName}_configuration_changed_between_samples`);
    }
  }
  const observationTimes = input.observations
    .map(({ observedAt }) => Date.parse(observedAt))
    .filter(Number.isFinite);
  const observationSpanMs = observationTimes.length < 2
    ? 0
    : Math.max(...observationTimes) - Math.min(...observationTimes);
  if (observationSpanMs < 30_000) {
    violations.push(`observation_span_too_short:${observationSpanMs}/30000`);
  }
  const unsigned = {
    schemaVersion: "genio-release-convergence/v2" as const,
    generatedAt,
    expiresAt: new Date(Date.parse(generatedAt) + EVIDENCE_TTL_MS).toISOString(),
    origin: input.origin,
    scope,
    expected: {
      backend: {
        revision: input.expectedRevision,
        version: input.expectedVersion,
      },
      sites: {
        revision: expectedSitesRevision,
        version: expectedSitesVersion,
        candidateMatched: sitesCandidateMatched,
      },
      samples: input.expectedSamples,
      minimumObservationSpanMs: 30_000 as const,
      configurationHashes: input.expectedConfigurationHashes,
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

async function responseBody(
  url: string,
  deadlineAt = Number.POSITIVE_INFINITY,
): Promise<{ status: number; text: string; json: unknown }> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    throw new Error("release convergence producer exceeded its hard deadline");
  }
  const response = await fetch(url, {
    cache: "no-store",
    redirect: "error",
    headers: { "cache-control": "no-cache", pragma: "no-cache" },
    signal: AbortSignal.timeout(Math.max(1, Math.min(15_000, remainingMs))),
  });
  const text = await response.text();
  let json: unknown = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    // The caller validates the expected representation without retaining raw
    // response bodies in release evidence.
  }
  return { status: response.status, text, json };
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function collectReleaseConvergenceEvidence(
  args: ReleaseConvergenceArgs,
  deadlineAt = Date.now()
    + args.samples * (args.intervalMs + 45_000),
): Promise<ReleaseConvergenceEvidence> {
  if (!args.expectedConfigurationHashes) {
    throw new Error(
      "release convergence collection requires exact runtime snapshot configuration hashes",
    );
  }
  const observations: ReleaseConvergenceObservation[] = [];
  for (let index = 0; index < args.samples; index += 1) {
    if (Date.now() >= deadlineAt) {
      throw new Error("release convergence producer exceeded its hard deadline");
    }
    const nonce = randomUUID();
    const observedAt = new Date().toISOString();
    const [sites, live, system] = await Promise.all([
      responseBody(`${args.origin}/about?release-evidence=${nonce}`, deadlineAt),
      responseBody(`${args.origin}/health/live?release-evidence=${nonce}`, deadlineAt),
      responseBody(`${args.origin}/health/system?release-evidence=${nonce}`, deadlineAt),
    ]);
    if (sites.status !== 200) throw new Error(`Sites release probe returned HTTP ${sites.status}`);
    if (live.status !== 200) throw new Error(`API liveness probe returned HTTP ${live.status}`);
    observations.push(releaseConvergenceObservation({
      observedAt,
      sitesHtml: sites.text,
      livePayload: live.json,
      systemPayload: system.json,
      systemHttpStatus: system.status,
    }));
    if (index + 1 < args.samples && args.intervalMs > 0) {
      if (Date.now() + args.intervalMs >= deadlineAt) {
        throw new Error("release convergence producer exceeded its hard deadline");
      }
      await wait(args.intervalMs);
    }
  }
  return buildReleaseConvergenceEvidence({
    origin: args.origin,
    scope: args.scope,
    expectedRevision: args.expectedRevision,
    expectedVersion: args.expectedVersion,
    expectedSitesRevision: args.expectedSitesRevision,
    expectedSitesVersion: args.expectedSitesVersion,
    expectedSamples: args.samples,
    expectedConfigurationHashes: args.expectedConfigurationHashes,
    observations,
  });
}

async function main(): Promise<void> {
  const args = parseReleaseConvergenceArgs(process.argv.slice(2));
  const evidence = await collectReleaseConvergenceEvidence(args);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  if (!evidence.passed) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: "release_convergence_failed",
      message: error instanceof Error ? error.message : "Release convergence verification failed",
    })}\n`);
    process.exitCode = 1;
  });
}
