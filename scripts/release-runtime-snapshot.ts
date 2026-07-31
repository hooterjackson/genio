import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  releaseEvidenceConfigurationHash,
  releaseEvidenceRuntimeHash,
  stableReleaseEvidenceJson,
  type ReleaseEvidencePayloadV1,
} from "./release-evidence.ts";

const SHA256 = /^[0-9a-f]{64}$/u;
const SOURCE_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const SAFE_SECRET_VERSION_NAME = /^[A-Za-z][0-9A-Za-z._-]{2,63}$/u;
const SAFE_RELEASE_LABEL = /^[0-9A-Za-z][0-9A-Za-z._:+/-]{0,159}$/u;

type JsonRecord = Record<string, unknown>;
type ReleaseConfiguration = ReleaseEvidencePayloadV1["configuration"];
type ReleaseRuntime = ReleaseEvidencePayloadV1["runtime"];
export type ReleaseRuntimeSnapshotScope = "backend" | "full";

export const REQUIRED_RELEASE_SECRET_VERSION_NAMES = [
  "appleDeveloperSigningKey",
  "applePublisherAuthorization",
  "appleQaVerifier",
  "appleTokenEncryption",
  "capabilitySession",
  "database",
  "gatewayCurrent",
  "gatewayPrevious",
  "ipHash",
  "notification",
  "providerProject",
  "releaseCanaryHmac",
] as const;

export interface ReleaseSecretVersionsV2 {
  schemaVersion: "genio-release-secret-versions/v2";
  environment: "staging" | "production";
  versions: Record<string, string>;
}

export interface ReleaseRuntimeSnapshotV1 {
  schemaVersion: "genio-release-runtime-snapshot/v3";
  generatedAt: string;
  origin: string;
  environment: "staging" | "production";
  scope: ReleaseRuntimeSnapshotScope;
  candidate: {
    version: string;
    sourceRevision: string;
  };
  sitesObservation: {
    version: string;
    sourceRevision: string;
    configurationHash: string;
    ownerAllowlistVersion: string;
    candidateMatched: boolean;
  };
  apiObservations: {
    liveReplicaIdentityHash: string;
    systemReplicaIdentityHash: string;
  };
  executorFencing: {
    version: "1";
    ready: true;
    incompleteJobs: 0;
    mismatchedActiveAttempts: 0;
    uncoveredJobs: 0;
    requirementsHash: string;
  };
  configuration: ReleaseConfiguration;
  runtime: ReleaseRuntime;
  publicRollout: {
    active: boolean;
    databaseAuthorized: boolean;
    evidenceHash: string | null;
    stage: string | null;
    targetConfigurationHash: string | null;
  };
  credentialVersionHashes: {
    provider: string;
    apple: string;
    appleQaVerifier: string;
  };
  configurationHash: string;
  runtimeHash: string;
  snapshotHash: string;
}

export interface ReleaseRuntimeSnapshotArgs {
  origin: string;
  environment: "staging" | "production";
  scope: ReleaseRuntimeSnapshotScope;
  expectedRevision: string;
  expectedVersion: string;
  secretVersionsPath: string;
  outputPath: string;
}

function asRecord(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
    || actual.some((item, index) => item !== wanted[index])) {
    throw new Error(`${label} contains missing or unapproved fields`);
  }
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableReleaseEvidenceJson(value)).digest("hex");
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} must be a SHA-256 digest`);
  }
  return value;
}

function releaseLabel(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !SAFE_RELEASE_LABEL.test(value)
    || /(?:sk-|secret|token|password)/iu.test(value)
  ) {
    throw new Error(`${label} is not an approved release label`);
  }
  return value;
}

function revision(value: unknown, label: string): string {
  if (typeof value !== "string" || !SOURCE_REVISION.test(value.toLowerCase())) {
    throw new Error(`${label} must be a full Git revision`);
  }
  return value.toLowerCase();
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function apiRuntimeIdentity(input: {
  value: unknown;
  label: string;
  expectedRevision: string;
  expectedVersion: string;
  expectedConfigurationHash: string;
  expectedSemanticExecutionConfigurationHash: string;
}): {
  replicaIdentityHash: string;
  build: {
    identifier: string;
    version: string;
    revision: string;
  };
} {
  const identity = asRecord(input.value, input.label);
  exactKeys(identity, [
    "schemaVersion",
    "replicaIdentityHash",
    "build",
    "configurationHash",
    "semanticExecutionConfigurationHash",
  ], input.label);
  if (identity.schemaVersion !== "genio-api-runtime-identity/v1") {
    throw new Error(`${input.label} uses an unsupported schema`);
  }
  const build = asRecord(identity.build, `${input.label} build`);
  exactKeys(build, ["identifier", "version", "revision"], `${input.label} build`);
  const observedRevision = revision(
    build.revision,
    `${input.label} source revision`,
  );
  const observedIdentifier = releaseLabel(
    build.identifier,
    `${input.label} build identifier`,
  );
  if (
    build.version !== input.expectedVersion
    || observedRevision !== input.expectedRevision
    || identity.configurationHash !== input.expectedConfigurationHash
    || identity.semanticExecutionConfigurationHash
      !== input.expectedSemanticExecutionConfigurationHash
  ) {
    throw new Error(
      `${input.label} does not match the candidate API build and configuration`,
    );
  }
  return {
    replicaIdentityHash: digest(
      identity.replicaIdentityHash,
      `${input.label} replica identity hash`,
    ),
    build: {
      identifier: observedIdentifier,
      version: input.expectedVersion,
      revision: observedRevision,
    },
  };
}

function htmlAttribute(html: string, name: string): string | null {
  const match = new RegExp(
    `\\b${name}=(?:"([^"]+)"|'([^']+)'|([^\\s>]+))`,
    "iu",
  ).exec(html);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

export function sitesBuildIdentityFromHtml(html: string): {
  version: string;
  sourceRevision: string;
} {
  const versionValue = htmlAttribute(html, "data-build-version");
  const revisionValue = htmlAttribute(html, "data-build-revision");
  if (!versionValue || !VERSION.test(versionValue)) {
    throw new Error("Sites did not expose a valid data-build-version marker");
  }
  return {
    version: versionValue,
    sourceRevision: revision(
      revisionValue,
      "Sites data-build-revision marker",
    ),
  };
}

export function parseReleaseSecretVersions(
  value: unknown,
  expectedEnvironment?: "staging" | "production",
): ReleaseSecretVersionsV2 {
  const root = asRecord(value, "release secret versions");
  exactKeys(root, ["schemaVersion", "environment", "versions"], "release secret versions");
  if (root.schemaVersion !== "genio-release-secret-versions/v2") {
    throw new Error("release secret versions use an unsupported schema");
  }
  if (
    (root.environment !== "staging" && root.environment !== "production")
    || (expectedEnvironment !== undefined && root.environment !== expectedEnvironment)
  ) {
    throw new Error("release secret versions do not match the release environment");
  }
  const versions = asRecord(root.versions, "release secret versions.versions");
  exactKeys(
    versions,
    REQUIRED_RELEASE_SECRET_VERSION_NAMES,
    "release secret versions.versions",
  );
  const entries = Object.entries(versions);
  const normalized = Object.fromEntries(entries
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => {
      if (!SAFE_SECRET_VERSION_NAME.test(name)) {
        throw new Error("release secret version names must be safe labels");
      }
      return [name, digest(value, `release secret version ${name}`)];
    }));
  return {
    schemaVersion: "genio-release-secret-versions/v2",
    environment: root.environment,
    versions: normalized,
  };
}

function workerConfigurationHash(input: {
  lane: "interactive" | "deep";
  value: unknown;
  expectedRevision: string;
  expectedProtocol: string;
  expectedSemanticExecutionConfigurationHash: string;
}): string {
  const lane = asRecord(input.value, `${input.lane} worker lane`);
  if (lane.status !== "healthy"
    || lane.candidateExecutorIdentityReady !== true
    || Number(lane.compatibleCapacity ?? 0) < 1
    || Number(lane.eligibleWorkerCount ?? 0) < 1
    || Number(lane.eligibleIdentityCount ?? -1)
      !== Number(lane.eligibleWorkerCount ?? 0)) {
    throw new Error(`${input.lane} worker lane is not healthy`);
  }
  if (lane.protocolVersion !== input.expectedProtocol) {
    throw new Error(`${input.lane} worker protocol does not match the API runtime`);
  }
  const revisions = [...new Set(stringArray(lane.eligibleRevisions)
    .map((item) => item.toLowerCase()))];
  if (revisions.length !== 1 || revisions[0] !== input.expectedRevision) {
    throw new Error(`${input.lane} worker lane is not exclusively on the candidate revision`);
  }
  const hashes = [...new Set(stringArray(lane.eligibleConfigurationHashes)
    .filter((item) => SHA256.test(item)))];
  if (hashes.length !== 1) {
    throw new Error(`${input.lane} worker lane does not expose one authoritative configuration hash`);
  }
  const semanticHashes = [...new Set(
    stringArray(lane.eligibleSemanticExecutionConfigurationHashes)
      .filter((item) => SHA256.test(item)),
  )];
  if (
    semanticHashes.length !== 1
    || semanticHashes[0] !== input.expectedSemanticExecutionConfigurationHash
  ) {
    throw new Error(
      `${input.lane} worker lane semantic execution configuration does not match the API`,
    );
  }
  return hashes[0]!;
}

function runtimeSnapshot(input: {
  live: JsonRecord;
  system: JsonRecord;
  expectedEnvironment: "staging" | "production";
}): ReleaseRuntime {
  const runtime = asRecord(input.live.runtime, "API runtime");
  const policyVersions = {
    guidance: releaseLabel(runtime.guidancePolicyVersion, "guidance policy"),
    evidence: releaseLabel(runtime.evidencePolicyVersion, "evidence policy"),
    queryPlan: releaseLabel(runtime.queryPlanPolicyVersion, "query-plan policy"),
    selection: releaseLabel(runtime.selectionPlanVersion, "selection policy"),
    semanticScope: releaseLabel(runtime.semanticScopePolicyVersion, "semantic-scope policy"),
    musicConcept: releaseLabel(runtime.musicConceptPolicyVersion, "music-concept policy"),
    pipeline: releaseLabel(runtime.pipelinePolicyVersion, "pipeline policy"),
    prompt: releaseLabel(runtime.promptVersion, "prompt policy"),
  };
  const result: ReleaseRuntime = {
    semanticExecutionConfigurationHash: digest(
      runtime.semanticExecutionConfigurationHash,
      "semantic execution configuration hash",
    ),
    releaseEnvironment: releaseLabel(
      runtime.releaseEnvironment,
      "release environment",
    ) as "staging" | "production",
    deploymentPhase: releaseLabel(runtime.deploymentPhase, "deployment phase") as "activate",
    databaseSchemaVersion: releaseLabel(
      input.system.schemaVersion,
      "database schema version",
    ),
    databaseCapabilityVersion: (
      input.system.releaseManifestCanaryGuardsVersion === "1"
      && input.system.canonicalExecutionHardeningVersion === "1"
    )
      ? "2"
      : (() => {
          throw new Error(
            "database composite capability requires both authoritative marker-1 values",
          );
        })(),
    releaseManifestCanaryGuardsVersion: releaseLabel(
      input.system.releaseManifestCanaryGuardsVersion,
      "release manifest canary guards version",
    ) as "1",
    canonicalExecutionHardeningVersion: releaseLabel(
      input.system.canonicalExecutionHardeningVersion,
      "canonical execution hardening version",
    ) as "1",
    proofArchitectureMode: releaseLabel(
      runtime.proofArchitectureMode,
      "proof architecture mode",
    ) as "native",
    proofArchitectureVersion: releaseLabel(
      input.system.proofArchitectureVersion,
      "proof architecture version",
    ) as "1",
    proofArchitectureAuthority: releaseLabel(
      input.system.proofArchitectureAuthority,
      "proof architecture authority",
    ) as "native",
    workerProtocol: releaseLabel(runtime.workerProtocol, "worker protocol"),
    briefContractVersion: releaseLabel(runtime.briefContractVersion, "brief contract version"),
    queryPlanSchemaVersion: releaseLabel(
      runtime.queryPlanSchemaVersion,
      "query-plan schema version",
    ),
    modelIds: {
      brief: releaseLabel(runtime.briefProviderModelId, "brief provider model"),
      baseline: releaseLabel(runtime.baselineProviderModelId, "baseline provider model"),
      escalation: releaseLabel(runtime.escalationProviderModelId, "escalation provider model"),
    },
    policyVersions,
  };
  if (
    result.releaseEnvironment !== input.expectedEnvironment
    || result.deploymentPhase !== "activate"
    || result.databaseSchemaVersion !== "20"
    || result.databaseCapabilityVersion !== "2"
    || result.releaseManifestCanaryGuardsVersion !== "1"
    || result.canonicalExecutionHardeningVersion !== "1"
    || result.proofArchitectureMode !== "native"
    || result.proofArchitectureVersion !== "1"
    || result.proofArchitectureAuthority !== "native"
    || result.workerProtocol !== "playlist-pipeline-v12"
    || result.briefContractVersion !== "3"
    || result.queryPlanSchemaVersion !== "6"
    || result.policyVersions.guidance !== "adaptive_guidance_v4"
    || result.policyVersions.evidence !== "governed_evidence_v2"
  ) {
    throw new Error(
      "runtime does not satisfy the schema-20/protocol-12 native-proof release contract",
    );
  }
  return result;
}

function publicRolloutSnapshot(input: {
  live: JsonRecord;
  system: JsonRecord;
}): ReleaseRuntimeSnapshotV1["publicRollout"] {
  const runtime = asRecord(input.live.runtime, "API runtime");
  const authority = asRecord(
    input.system.publicRollout,
    "system public rollout authority",
  );
  exactKeys(authority, [
    "active",
    "databaseAuthorized",
    "evidenceHash",
    "stage",
    "targetConfigurationHash",
  ], "system public rollout authority");
  if (
    typeof authority.active !== "boolean"
    || authority.databaseAuthorized !== true
  ) {
    throw new Error(
      "system public rollout authority was not read from the database",
    );
  }
  const runtimeEvidenceHash = runtime.publicRolloutEvidenceHash;
  const runtimeStage = runtime.publicRolloutStage;
  const authorityEvidenceHash = authority.evidenceHash;
  const authorityStage = authority.stage;
  const authorityTargetConfigurationHash =
    authority.targetConfigurationHash;
  if (!authority.active) {
    if (
      runtimeEvidenceHash !== null
      || runtimeStage !== null
      || authorityEvidenceHash !== null
      || authorityStage !== null
      || authorityTargetConfigurationHash !== null
    ) {
      throw new Error(
        "inactive public rollout contains stale runtime or database markers",
      );
    }
    return {
      active: false,
      databaseAuthorized: true,
      evidenceHash: null,
      stage: null,
      targetConfigurationHash: null,
    };
  }
  const stagePattern =
    /^(?:genre_scene|mood_activity_theme|similarity|artist_catalogue|fixed_container|factual_relationship|exhaustive):(?:0|1|10|50|100)->(?:0|1|10|50|100)$/u;
  if (
    typeof authorityEvidenceHash !== "string"
    || !SHA256.test(authorityEvidenceHash)
    || typeof authorityStage !== "string"
    || !stagePattern.test(authorityStage)
    || typeof authorityTargetConfigurationHash !== "string"
    || !SHA256.test(authorityTargetConfigurationHash)
    || runtimeEvidenceHash !== authorityEvidenceHash
    || runtimeStage !== authorityStage
  ) {
    throw new Error(
      "active public rollout runtime identity does not match its database authority",
    );
  }
  return {
    active: true,
    databaseAuthorized: true,
    evidenceHash: authorityEvidenceHash,
    stage: authorityStage,
    targetConfigurationHash: authorityTargetConfigurationHash,
  };
}

function executorFencingSnapshot(
  system: JsonRecord,
): ReleaseRuntimeSnapshotV1["executorFencing"] {
  if (system.canonicalExecutorReleaseIdentityFencingVersion !== "1") {
    throw new Error(
      "canonical executor release identity fence marker is not active",
    );
  }
  const fencing = asRecord(
    system.executorFencing,
    "system executor release identity fencing",
  );
  exactKeys(fencing, [
    "ready",
    "incompleteJobs",
    "mismatchedActiveAttempts",
    "uncoveredJobs",
    "requirements",
  ], "system executor release identity fencing");
  if (
    fencing.ready !== true
    || fencing.incompleteJobs !== 0
    || fencing.mismatchedActiveAttempts !== 0
    || fencing.uncoveredJobs !== 0
    || !Array.isArray(fencing.requirements)
  ) {
    throw new Error(
      "system executor release identity fencing is not converged",
    );
  }
  return {
    version: "1",
    ready: true,
    incompleteJobs: 0,
    mismatchedActiveAttempts: 0,
    uncoveredJobs: 0,
    requirementsHash: sha256(fencing.requirements),
  };
}

export function buildReleaseRuntimeSnapshot(input: {
  origin: string;
  environment: "staging" | "production";
  scope: ReleaseRuntimeSnapshotScope;
  expectedRevision: string;
  expectedVersion: string;
  sitesHtml: string;
  sitesConfigurationHashes: readonly unknown[];
  sitesOwnerAllowlistVersions: readonly unknown[];
  livePayload: unknown;
  systemPayload: unknown;
  systemHttpStatus: number;
  secretVersions: unknown;
  generatedAt?: string;
}): ReleaseRuntimeSnapshotV1 {
  const expectedRevision = revision(input.expectedRevision, "expected revision");
  if (input.scope !== "backend" && input.scope !== "full") {
    throw new Error("release runtime snapshot scope must be backend or full");
  }
  if (input.scope === "backend" && input.environment !== "production") {
    throw new Error("backend-scoped runtime snapshots are production-only");
  }
  if (!VERSION.test(input.expectedVersion)) {
    throw new Error("expected version must be a stable semantic version");
  }
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  if (new Date(generatedAt).toISOString() !== generatedAt) {
    throw new Error("generatedAt must be an ISO timestamp");
  }
  const sites = sitesBuildIdentityFromHtml(input.sitesHtml);
  const sitesCandidateMatched = sites.version === input.expectedVersion
    && sites.sourceRevision === expectedRevision;
  if (input.scope === "full" && !sitesCandidateMatched) {
    throw new Error("full-scope Sites build identity does not match the candidate");
  }
  if (input.scope === "backend" && sitesCandidateMatched) {
    throw new Error(
      "backend-scoped production snapshot requires the pre-candidate Sites deployment",
    );
  }
  if (input.sitesConfigurationHashes.length !== 3) {
    throw new Error("release probes must expose three Sites configuration hashes");
  }
  const sitesConfigurationHashes = input.sitesConfigurationHashes.map((value) => (
    digest(value, "Sites configuration hash")
  ));
  if (new Set(sitesConfigurationHashes).size !== 1) {
    throw new Error("Sites configuration changed across release probes");
  }
  const sitesConfigurationHash = sitesConfigurationHashes[0]!;
  const live = asRecord(input.livePayload, "API liveness response");
  const build = asRecord(live.build, "API build identity");
  if (
    live.ok !== true
    || build.version !== input.expectedVersion
    || revision(build.revision, "API source revision") !== expectedRevision
  ) {
    throw new Error("API build identity does not match the candidate");
  }
  const apiHash = digest(live.configurationHash, "API configuration hash");
  const system = asRecord(input.systemPayload, "system health response");
  if (
    input.systemHttpStatus !== 200
    || system.ok !== true
    || system.activationReady !== true
    || system.database !== "ready"
    || system.paused === true
  ) {
    throw new Error("system health is not activation-ready");
  }
  const runtime = runtimeSnapshot({
    live,
    system,
    expectedEnvironment: input.environment,
  });
  const liveApiIdentity = apiRuntimeIdentity({
    value: live.api,
    label: "API liveness runtime identity",
    expectedRevision,
    expectedVersion: input.expectedVersion,
    expectedConfigurationHash: apiHash,
    expectedSemanticExecutionConfigurationHash:
      runtime.semanticExecutionConfigurationHash,
  });
  if (
    liveApiIdentity.build.identifier !== build.identifier
    || liveApiIdentity.build.version !== build.version
    || liveApiIdentity.build.revision !== build.revision
  ) {
    throw new Error(
      "API liveness identity disagrees with its legacy build fields",
    );
  }
  const systemApiIdentity = apiRuntimeIdentity({
    value: system.api,
    label: "system health API runtime identity",
    expectedRevision,
    expectedVersion: input.expectedVersion,
    expectedConfigurationHash: apiHash,
    expectedSemanticExecutionConfigurationHash:
      runtime.semanticExecutionConfigurationHash,
  });
  const apiObservations = {
    liveReplicaIdentityHash: liveApiIdentity.replicaIdentityHash,
    systemReplicaIdentityHash: systemApiIdentity.replicaIdentityHash,
  };
  const executorFencing = executorFencingSnapshot(system);
  const publicRollout = publicRolloutSnapshot({ live, system });
  if (input.sitesOwnerAllowlistVersions.length !== 3) {
    throw new Error("release probes must expose three owner allowlist versions");
  }
  const runtimeOwnerAllowlistVersion = releaseLabel(
    asRecord(live.runtime, "API runtime").ownerAllowlistVersion,
    "owner allowlist version",
  );
  const sitesOwnerAllowlistVersions = input.sitesOwnerAllowlistVersions.map((value) => (
    releaseLabel(value, "Sites owner allowlist version")
  ));
  if (new Set(sitesOwnerAllowlistVersions).size !== 1) {
    throw new Error("Sites owner allowlist version changed across release probes");
  }
  const sitesOwnerAllowlistVersion = sitesOwnerAllowlistVersions[0]!;
  if (
    input.scope === "full"
    && sitesOwnerAllowlistVersion !== runtimeOwnerAllowlistVersion
  ) {
    throw new Error("full-scope Sites and API owner allowlist versions do not match");
  }
  const lanes = asRecord(system.workerLanes, "system worker lanes");
  const secretVersions = parseReleaseSecretVersions(
    input.secretVersions,
    input.environment,
  );
  const configuration: ReleaseConfiguration = {
    apiHash,
    interactiveWorkerHash: workerConfigurationHash({
      lane: "interactive",
      value: lanes.interactive,
      expectedRevision,
      expectedProtocol: runtime.workerProtocol,
      expectedSemanticExecutionConfigurationHash:
        runtime.semanticExecutionConfigurationHash,
    }),
    deepWorkerHash: workerConfigurationHash({
      lane: "deep",
      value: lanes.deep,
      expectedRevision,
      expectedProtocol: runtime.workerProtocol,
      expectedSemanticExecutionConfigurationHash:
        runtime.semanticExecutionConfigurationHash,
    }),
    sitesHash: sha256({
      buildIdentity: sites,
      gatewayConfigurationHash: sitesConfigurationHash,
    }),
    secretVersionsHash: sha256(secretVersions),
  };
  const credentialVersionHashes = {
    provider: secretVersions.versions.providerProject!,
    apple: sha256({
      appleDeveloperSigningKey: secretVersions.versions.appleDeveloperSigningKey,
      applePublisherAuthorization: secretVersions.versions.applePublisherAuthorization,
      appleTokenEncryption: secretVersions.versions.appleTokenEncryption,
    }),
    appleQaVerifier: secretVersions.versions.appleQaVerifier!,
  };
  const sitesObservation = {
    ...sites,
    configurationHash: sitesConfigurationHash,
    ownerAllowlistVersion: sitesOwnerAllowlistVersion,
    candidateMatched: sitesCandidateMatched,
  };
  const unsigned = {
    schemaVersion: "genio-release-runtime-snapshot/v3" as const,
    generatedAt,
    origin: input.origin,
    environment: input.environment,
    scope: input.scope,
    candidate: {
      version: input.expectedVersion,
      sourceRevision: expectedRevision,
    },
    sitesObservation,
    apiObservations,
    executorFencing,
    configuration,
    runtime,
    publicRollout,
    credentialVersionHashes,
    configurationHash: releaseEvidenceConfigurationHash({ configuration }),
    runtimeHash: releaseEvidenceRuntimeHash({ runtime }),
  };
  return {
    ...unsigned,
    snapshotHash: sha256(unsigned),
  };
}

function option(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : "";
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

export function parseReleaseRuntimeSnapshotArgs(
  argv: readonly string[],
): ReleaseRuntimeSnapshotArgs {
  const allowed = new Set([
    "--origin",
    "--environment",
    "--scope",
    "--expected-revision",
    "--expected-version",
    "--secret-versions",
    "--output",
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    if (!allowed.has(argv[index] ?? "")) {
      throw new Error(`Unknown argument: ${String(argv[index])}`);
    }
  }
  const originValue = option(argv, "--origin");
  const parsedOrigin = new URL(originValue);
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
  const environment = option(argv, "--environment");
  if (environment !== "staging" && environment !== "production") {
    throw new Error("--environment must be staging or production");
  }
  const scope = option(argv, "--scope");
  if (scope !== "backend" && scope !== "full") {
    throw new Error("--scope must be backend or full");
  }
  if (scope === "backend" && environment !== "production") {
    throw new Error("--scope backend is production-only");
  }
  const productionHost = parsedOrigin.hostname === "9enio.com"
    || parsedOrigin.hostname === "www.9enio.com";
  if (
    (environment === "staging" && productionHost)
    || (
      environment === "production"
      && parsedOrigin.origin !== "https://9enio.com"
    )
  ) {
    throw new Error(
      `--origin does not identify the requested ${environment} environment`,
    );
  }
  const expectedRevision = revision(
    option(argv, "--expected-revision").toLowerCase(),
    "--expected-revision",
  );
  const expectedVersion = option(argv, "--expected-version");
  if (!VERSION.test(expectedVersion)) {
    throw new Error("--expected-version must be a stable semantic version");
  }
  return {
    origin: parsedOrigin.origin,
    environment,
    scope,
    expectedRevision,
    expectedVersion,
    secretVersionsPath: option(argv, "--secret-versions"),
    outputPath: option(argv, "--output"),
  };
}

async function response(
  url: string,
): Promise<{
  status: number;
  text: string;
  json: unknown;
  sitesConfigurationHash: string | null;
  sitesOwnerAllowlistVersion: string | null;
}> {
  const result = await fetch(url, {
    cache: "no-store",
    redirect: "error",
    headers: { "cache-control": "no-cache", pragma: "no-cache" },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await result.text();
  let json: unknown = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    // The caller validates the representation and never persists raw bodies.
  }
  return {
    status: result.status,
    text,
    json,
    sitesConfigurationHash: result.headers.get(
      "x-genio-sites-configuration-hash",
    ),
    sitesOwnerAllowlistVersion: result.headers.get(
      "x-genio-owner-allowlist-version",
    ),
  };
}

async function main(): Promise<void> {
  const args = parseReleaseRuntimeSnapshotArgs(process.argv.slice(2));
  const nonce = randomUUID();
  const [sites, live, system, secretVersionsSource] = await Promise.all([
    response(`${args.origin}/about?release-snapshot=${nonce}`),
    response(`${args.origin}/health/live?release-snapshot=${nonce}`),
    response(`${args.origin}/health/system?release-snapshot=${nonce}`),
    readFile(args.secretVersionsPath, "utf8"),
  ]);
  if (sites.status !== 200) throw new Error(`Sites release probe returned HTTP ${sites.status}`);
  if (live.status !== 200) throw new Error(`API liveness probe returned HTTP ${live.status}`);
  const snapshot = buildReleaseRuntimeSnapshot({
    origin: args.origin,
    environment: args.environment,
    scope: args.scope,
    expectedRevision: args.expectedRevision,
    expectedVersion: args.expectedVersion,
    sitesHtml: sites.text,
    sitesConfigurationHashes: [
      sites.sitesConfigurationHash,
      live.sitesConfigurationHash,
      system.sitesConfigurationHash,
    ],
    sitesOwnerAllowlistVersions: [
      sites.sitesOwnerAllowlistVersion,
      live.sitesOwnerAllowlistVersion,
      system.sitesOwnerAllowlistVersion,
    ],
    livePayload: live.json,
    systemPayload: system.json,
    systemHttpStatus: system.status,
    secretVersions: JSON.parse(secretVersionsSource),
  });
  await writeFile(
    args.outputPath,
    `${JSON.stringify(snapshot, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  process.stdout.write(`${JSON.stringify({
    ok: true,
    output: args.outputPath,
    configurationHash: snapshot.configurationHash,
    runtimeHash: snapshot.runtimeHash,
    snapshotHash: snapshot.snapshotHash,
  })}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: "release_runtime_snapshot_failed",
      message: error instanceof Error ? error.message : "Release runtime snapshot failed",
    })}\n`);
    process.exitCode = 1;
  });
}
