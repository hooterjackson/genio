import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const DEFAULT_ORIGIN = "https://9enio.com";
const DEFAULT_SAMPLES = 2;
const DEFAULT_INTERVAL_SECONDS = 30;
const EVIDENCE_TTL_MS = 24 * 60 * 60 * 1_000;
const RUNTIME_EVIDENCE_KEYS = [
  "pipelineVersion",
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
  "baselineProviderModelId",
  "escalationProviderModelId",
  "modelResolutionMode",
  "modelCatalogValidatedAt",
] as const;
const REQUIRED_RUNTIME_RELEASE = Object.freeze({
  deploymentPhase: "activate",
  expectedDatabaseSchemaVersion: "18",
  canonicalActivationConfigured: "true",
  schemaVersion: "18",
  schemaMaximum: "18",
  schemaPreferred: "18",
  workerProtocol: "playlist-pipeline-v10",
  queryPlanSchemaVersion: "4",
  briefContractVersion: "3",
});

type JsonRecord = Record<string, unknown>;

export interface ReleaseConvergenceArgs {
  origin: string;
  expectedRevision: string;
  expectedVersion: string;
  samples: number;
  intervalMs: number;
}

export interface ReleaseConvergenceWorkerLane {
  status: string | null;
  protocolVersion: string | null;
  compatibleCapacity: number;
  eligibleWorkerCount: number;
  eligibleRevisions: string[];
  eligibleConfigurationHashes: string[];
  lastSeenAt: string | null;
}

export interface ReleaseConvergenceObservation {
  observedAt: string;
  sitesVersion: string | null;
  api: {
    identifier: string | null;
    version: string | null;
    revision: string | null;
  };
  runtime: JsonRecord;
  runtimeContractHash: string;
  systemHttpStatus: number;
  system: {
    ok: boolean;
    activationReady: boolean;
    database: string | null;
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
  schemaVersion: "genio-release-convergence/v1";
  generatedAt: string;
  expiresAt: string;
  origin: string;
  expected: {
    revision: string;
    version: string;
    samples: number;
  };
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
  let expectedRevision = "";
  let expectedVersion = "";
  let samples = DEFAULT_SAMPLES;
  let intervalMs = DEFAULT_INTERVAL_SECONDS * 1_000;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--origin") {
      if (!value) throw new Error("--origin requires a value");
      origin = value;
    } else if (argument === "--expected-revision") {
      if (!value) throw new Error("--expected-revision requires a value");
      expectedRevision = value.trim().toLowerCase();
    } else if (argument === "--expected-version") {
      if (!value) throw new Error("--expected-version requires a value");
      expectedVersion = value.trim();
    } else if (argument === "--samples") {
      samples = integerOption(value, "--samples", 2, 5);
    } else if (argument === "--interval-seconds") {
      intervalMs = integerOption(value, "--interval-seconds", 0, 120) * 1_000;
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
  if (!safeRevision(expectedRevision)) {
    throw new Error("--expected-revision must be a 7–64 character hexadecimal Git revision");
  }
  if (!safeText(expectedVersion, 64)) {
    throw new Error("--expected-version is invalid");
  }
  return {
    origin: parsedOrigin.origin,
    expectedRevision,
    expectedVersion,
    samples,
    intervalMs,
  };
}

export function sitesVersionFromHtml(html: string): string | null {
  const match = /<html\b[^>]*\bdata-build-version=(?:"([^"]+)"|'([^']+)'|([^\s>]+))/iu.exec(html);
  return safeText(match?.[1] ?? match?.[2] ?? match?.[3], 64);
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
    api: {
      identifier: safeText(build.identifier, 140),
      version: safeText(build.version, 64),
      revision: safeRevision(build.revision),
    },
    runtime,
    runtimeContractHash: sha256(runtime),
    systemHttpStatus: Number.isInteger(input.systemHttpStatus) ? input.systemHttpStatus : 0,
    system: {
      ok: system.ok === true,
      activationReady: system.activationReady === true,
      database: safeText(system.database, 40),
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
  expectedRevision: string;
  expectedVersion: string;
  expectedSamples: number;
  observations: readonly ReleaseConvergenceObservation[];
  generatedAt?: string;
}): ReleaseConvergenceEvidence {
  const generatedAt = safeTimestamp(input.generatedAt) ?? new Date().toISOString();
  const violations: string[] = [];
  if (input.expectedSamples < 2) {
    violations.push(`heartbeat_sample_requirement:${input.expectedSamples}/2`);
  }
  if (input.observations.length !== input.expectedSamples) {
    violations.push(`sample_count:${input.observations.length}/${input.expectedSamples}`);
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
    if (observation.sitesVersion !== input.expectedVersion) {
      violations.push(`${label}:sites_version:${observation.sitesVersion ?? "missing"}`);
    }
    if (observation.api.version !== input.expectedVersion) {
      violations.push(`${label}:api_version:${observation.api.version ?? "missing"}`);
    }
    if (!observation.api.revision || !revisionMatches(observation.api.revision, input.expectedRevision)) {
      violations.push(`${label}:api_revision:${observation.api.revision ?? "missing"}`);
    }
    if (observation.systemHttpStatus !== 200 || !observation.system.ok) {
      violations.push(`${label}:system_unhealthy:${observation.systemHttpStatus}`);
    }
    if (observation.system.database !== "ready") {
      violations.push(`${label}:database:${observation.system.database ?? "missing"}`);
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
      if (lane.status !== "healthy" || lane.compatibleCapacity < 1 || lane.eligibleWorkerCount < 1) {
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
  const unsigned = {
    schemaVersion: "genio-release-convergence/v1" as const,
    generatedAt,
    expiresAt: new Date(Date.parse(generatedAt) + EVIDENCE_TTL_MS).toISOString(),
    origin: input.origin,
    expected: {
      revision: input.expectedRevision,
      version: input.expectedVersion,
      samples: input.expectedSamples,
    },
    passed: violations.length === 0,
    violations,
    observations: [...input.observations],
  };
  return {
    ...unsigned,
    evidenceHash: sha256(unsigned),
  };
}

async function responseBody(url: string): Promise<{ status: number; text: string; json: unknown }> {
  const response = await fetch(url, {
    cache: "no-store",
    redirect: "error",
    headers: { "cache-control": "no-cache", pragma: "no-cache" },
    signal: AbortSignal.timeout(15_000),
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

async function main(): Promise<void> {
  const args = parseReleaseConvergenceArgs(process.argv.slice(2));
  const observations: ReleaseConvergenceObservation[] = [];
  for (let index = 0; index < args.samples; index += 1) {
    const nonce = randomUUID();
    const observedAt = new Date().toISOString();
    const [sites, live, system] = await Promise.all([
      responseBody(`${args.origin}/about?release-evidence=${nonce}`),
      responseBody(`${args.origin}/health/live?release-evidence=${nonce}`),
      responseBody(`${args.origin}/health/system?release-evidence=${nonce}`),
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
    if (index + 1 < args.samples && args.intervalMs > 0) await wait(args.intervalMs);
  }
  const evidence = buildReleaseConvergenceEvidence({
    origin: args.origin,
    expectedRevision: args.expectedRevision,
    expectedVersion: args.expectedVersion,
    expectedSamples: args.samples,
    observations,
  });
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
