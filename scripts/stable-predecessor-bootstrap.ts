import {
  createHash,
  createPrivateKey,
  createPublicKey,
  KeyObject,
} from "node:crypto";
import {
  readFile,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  deflateRawSync,
  inflateRawSync,
} from "node:zlib";
import {
  semanticRankingProtectedBaselineMetadataSha256,
  validateSemanticRankingProtectedBaselineMetadataV1,
} from "../lib/semantic-ranking-review.ts";
import {
  createStrictSignedEnvelope,
  exactObject,
  sha256Digest,
  signedArtifactSha256,
  stableSignedArtifactJson,
  verifyStrictSignedEnvelope,
  type JsonRecord,
} from "../shared/signed-artifact.ts";
import {
  validateSitesControlPlaneTrustPolicyV1,
  validateSitesControlPlaneVerificationKeyV1,
  verifySitesControlPlaneAttestation,
} from "../shared/sites-control-plane-attestation.ts";
import type {
  StableReleaseConsumerManifestV1,
} from "./authorize-stable-release.ts";
import {
  validateReleaseGateArtifact,
  verifyReleaseGateProducerAttestation,
  type ReleaseGateArtifactV1,
} from "./release-fixtures.ts";
import {
  releaseGateProducerKeyFingerprint,
  validateReleaseGateProducerTrustPolicyV1,
} from "./release-evidence.ts";

export const STABLE_PREDECESSOR_BOOTSTRAP_EVIDENCE_SCHEMA_V1 =
  "genio-stable-predecessor-bootstrap-evidence/v1" as const;
export const SIGNED_STABLE_PREDECESSOR_BOOTSTRAP_EVIDENCE_SCHEMA_V1 =
  "genio-signed-stable-predecessor-bootstrap-evidence/v1" as const;
export const STABLE_PREDECESSOR_BOOTSTRAP_AUTHORIZATION_SCHEMA_V1 =
  "genio-stable-predecessor-bootstrap-authorization/v1" as const;
export const SIGNED_STABLE_PREDECESSOR_BOOTSTRAP_AUTHORIZATION_SCHEMA_V1 =
  "genio-signed-stable-predecessor-bootstrap-authorization/v1" as const;
export const STABLE_PREDECESSOR_BOOTSTRAP_IMAGE_ATTESTATION_SCHEMA_V1 =
  "genio-stable-predecessor-bootstrap-image-attestation/v1" as const;
export const STABLE_PREDECESSOR_BOOTSTRAP_FIXTURE_REGISTRY_SCHEMA_V1 =
  "genio-stable-predecessor-bootstrap-fixture-registry/v1" as const;
export const STABLE_PREDECESSOR_BOOTSTRAP_INDEPENDENT_EVIDENCE_SCHEMA_V1 =
  "genio-stable-predecessor-bootstrap-independent-evidence/v1" as const;
export const STABLE_PREDECESSOR_BOOTSTRAP_COMPRESSED_EVIDENCE_SCHEMA_V1 =
  "genio-stable-predecessor-bootstrap-compressed-evidence/v1" as const;
export const STABLE_PREDECESSOR_RECOVERED_RAILWAY_OBSERVATION_SCHEMA_V1 =
  "genio-stable-predecessor-recovered-railway-observation/v1" as const;
export const STABLE_PREDECESSOR_ORIGINAL_RAILWAY_PROVENANCE_SCHEMA_V1 =
  "genio-stable-predecessor-original-railway-provenance/v1" as const;
export const SIGNED_STABLE_PREDECESSOR_ORIGINAL_RAILWAY_PROVENANCE_SCHEMA_V1 =
  "genio-signed-stable-predecessor-original-railway-provenance/v1" as const;

export const STABLE_PREDECESSOR_BOOTSTRAP_TAG = "v2.3.4" as const;
export const STABLE_PREDECESSOR_BOOTSTRAP_COMPATIBILITY_RC_TAG =
  "v2.3.4-rc.1" as const;
export const STABLE_PREDECESSOR_BOOTSTRAP_VERSION = "2.3.4" as const;
export const STABLE_PREDECESSOR_BOOTSTRAP_TAG_OBJECT =
  "0fb63ccc88b6f5ea675b3b43506fc112fa3fae58" as const;
export const STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_REVISION =
  "7dc877cfc1537a9936974f9699a4b8ba9740b5f5" as const;
export const STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_TREE =
  "91076c2f06de9d562532981c3a602f1c6366f057" as const;
export const STABLE_PREDECESSOR_BOOTSTRAP_SUCCESSOR_VERSION = "2.4.0" as const;
export const STABLE_PREDECESSOR_BOOTSTRAP_SUCCESSOR_RC_PATTERN =
  "^v2\\.4\\.0-rc\\.[1-9]\\d*$" as const;
export const STABLE_PREDECESSOR_BOOTSTRAP_WORKFLOW =
  ".github/workflows/bootstrap-stable-predecessor.yml" as const;
export const STABLE_PREDECESSOR_BOOTSTRAP_IMAGE_WORKFLOW =
  ".github/workflows/bootstrap-stable-predecessor-image.yml" as const;
export const STABLE_PREDECESSOR_BOOTSTRAP_PREDICATE_TYPE =
  "https://slsa.dev/provenance/v1" as const;
export const STABLE_PREDECESSOR_BOOTSTRAP_BUILDER_IDENTITY =
  "github-actions:docker-buildx" as const;
export const STABLE_PREDECESSOR_BOOTSTRAP_RECONSTRUCTION_MODE =
  "controller_recipe_wrapper_not_historical_railway_artifact" as const;
export const STABLE_PREDECESSOR_BOOTSTRAP_CONTROLLER_RECIPE_SHA256 =
  "67bef0595e27b3bfff80a6208b25c6da04de6535018f6c83a4e6dee4aeeabb08" as const;
export const STABLE_PREDECESSOR_HISTORICAL_BUILD_INTENT_SHA256 =
  "ae81d5d22a4ebbdb56f284e9c5cd673dfd690c87bb9f9d5b8195b11d8e74bb99" as const;
export const STABLE_PREDECESSOR_HISTORICAL_PACKAGE_SHA256 =
  "176f15dac5c6b9c43c3833396f4aae880750b2cfcb26ea4404576a282061a54d" as const;
export const STABLE_PREDECESSOR_HISTORICAL_LOCKFILE_SHA256 =
  "a153c35bd8eec4fa2134f1bdd16224a9f2464b67aaa4f71454f89635e44ec444" as const;
export const STABLE_PREDECESSOR_HISTORICAL_WORKSPACE_SHA256 =
  "204107ece0b6c76b579d0bf514e0cd4b675d751ff792fa1ffdfae6d1c360eb6d" as const;
export const STABLE_PREDECESSOR_RAILPACK_FRONTEND_REFERENCE =
  "ghcr.io/railwayapp/railpack-frontend:v0.32.0@sha256:2803d0ae5618948389c0d61a5d3eed6c796207cf4122cbe620c0de499c94dddf" as const;
export const STABLE_PREDECESSOR_BOOTSTRAP_TTL_MS = 24 * 60 * 60 * 1000;

const REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const IMAGE_REFERENCE =
  /^ghcr\.io\/[0-9a-z](?:[0-9a-z._/-]*[0-9a-z])?@sha256:[0-9a-f]{64}$/u;
const IMMUTABLE_OCI_REFERENCE =
  /^[0-9a-z](?:[0-9a-z.-]*[0-9a-z])?(?::[1-9][0-9]{0,4})?\/[0-9a-z](?:[0-9a-z._/-]*[0-9a-z])?@sha256:[0-9a-f]{64}$/u;
const KEY_ID = /^[0-9A-Za-z][0-9A-Za-z._:+/-]{2,159}$/u;
const SUCCESSOR_RC = /^v2\.4\.0-rc\.[1-9]\d*$/u;
const BOOTSTRAP_INDEPENDENT_GATES = Object.freeze([
  "staging_fixed_three_track",
  "staging_affected_regression",
  "staging_guided_constraint",
  "final_custom_domain_browser",
] as const);
const BOOTSTRAP_FIXTURE_GATES = BOOTSTRAP_INDEPENDENT_GATES.slice(0, 3);
const MAXIMUM_BOOTSTRAP_INDEPENDENT_EVIDENCE_BYTES = 512 * 1024;
const MAXIMUM_BOOTSTRAP_COMPRESSED_EVIDENCE_BYTES = 64 * 1024;

export const STABLE_PREDECESSOR_BOOTSTRAP_LIMITATIONS = Object.freeze([
  "wrapper_image_bytes_and_controller_recipe_are_not_claimed_to_equal_any_historical_railway_artifact",
  "railway_records_are_authenticated_platform_observations_not_supply_chain_attestations",
  "recovered_railway_observations_lacked_registry_and_manifest_bytes_and_require_a_separate_protected_provenance_attestation",
  "railway_meta_image_digests_and_buildkit_oci_digests_are_distinct_unproven_identifiers",
  "baseline_authority_is_limited_to_the_hash_bound_semantic_fixtures",
  "wrapper_fixture_evidence_does_not_prove_historical_production_output_equivalence",
  "bootstrap_is_consumable_only_by_the_first_v2_4_0_rc_lineage",
] as const);

const EXPECTED_RAILWAY_LANES = Object.freeze([
  {
    lane: "api",
    deploymentId: "2eb05839-4034-4645-b831-894d043051b7",
    railwayMetaImageDigest:
      "sha256:d686118896fd88dc401b3e74047d0cbd9cd83a2cd13052dd74ec651b567c6543",
    buildkitOciManifestDigest:
      "sha256:278eb2e1409803de3bf0dcbb1ef0dab168bdeff53630722b83bea3eb76269ed5",
    buildkitOciConfigDigest:
      "sha256:4c4df15d392fb2d7ed8264ebf5af078cf4b33555d4e8b614fce41eec2a68ed2a",
    railpackPlanLoadVertexDigest:
      "sha256:433d1a7923369eb0a1aa5279097ea851d7f08e0ae2a6505d2f69834231c09f99",
    canonicalDeploymentObservationSha256:
      "ed319e1354a31b8c0e33dd0e76c22776aad06247840d0c8d80c0249c7c5cb3d1",
    canonicalBuildLogObservationSha256:
      "b6a0b685e7282fffbd658ab0c875401d6cff10253e630dd8a93364f8a9c49079",
    buildLogRecordCount: 143,
  },
  {
    lane: "worker",
    deploymentId: "17071c95-24ba-4e8f-8cbb-dbdd5a22495d",
    railwayMetaImageDigest:
      "sha256:315d128f074a069e15fd2bf4af0e59445b98cb900d58fab397b36a50dc75db47",
    buildkitOciManifestDigest:
      "sha256:563d7168b5aa46fe0f5fb389505616f85690f87df7d3130274d54c588b9c0182",
    buildkitOciConfigDigest:
      "sha256:8c90c0383998622ead2ecbb289d9175d8e6b7f586a4963bf1ce9c3148704504a",
    railpackPlanLoadVertexDigest:
      "sha256:35935e77ae0514945cb70f8921e28e7799185de124269f2b1023f2b7019a0de3",
    canonicalDeploymentObservationSha256:
      "2e148c9f65c5d243aece743ee8a4624fbf1f486e9ba0a7be8718876538f06131",
    canonicalBuildLogObservationSha256:
      "67d4ae58e48ec4cbc7835a99438876bb656fae64abd0462ff395637d8b7f8d18",
    buildLogRecordCount: 170,
  },
  {
    lane: "deep",
    deploymentId: "0ac7683c-7dfb-4be3-9e9d-1563e75e92fd",
    railwayMetaImageDigest:
      "sha256:32b88fe5de5238cd6c4ad4b00389f231277d111ed73a037e6668a12293b71898",
    buildkitOciManifestDigest:
      "sha256:74bcb907500f0f79133c66ce335249154edb7e9c2e277b3cb5d269594386d752",
    buildkitOciConfigDigest:
      "sha256:6d3371aae82914acb4673665252d775ce5e0c186a2c199cd6d8da5d1c6a1e392",
    railpackPlanLoadVertexDigest:
      "sha256:5523887ddf219b5d76dbaecd3bf222851b34eec41dc60e1cc3ec66b9f38260b8",
    canonicalDeploymentObservationSha256:
      "07250ad8d2f2c4111a57f87a2a59d5038aa0b5c742e7dc866fb7d0558bf793e7",
    canonicalBuildLogObservationSha256:
      "dc7cf9d405d6725cc2a33ae419e3af9a3efa1d3fb5362b173dbaa617636b8038",
    buildLogRecordCount: 167,
  },
] as const);

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be an ISO timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  return value;
}

function revision(value: unknown, label: string): string {
  if (typeof value !== "string" || !REVISION.test(value)) {
    throw new Error(`${label} must be a full source revision`);
  }
  return value;
}

function imageDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !IMAGE_DIGEST.test(value)) {
    throw new Error(`${label} must be an immutable image digest`);
  }
  return value;
}

function privateKey(value: string | Buffer | KeyObject): KeyObject {
  const parsed = value instanceof KeyObject ? value : createPrivateKey(value);
  if (parsed.type !== "private" || parsed.asymmetricKeyType !== "ed25519") {
    throw new Error("bootstrap signing keys must be private Ed25519 keys");
  }
  return parsed;
}

function publicKey(value: string | Buffer | KeyObject): KeyObject {
  const parsed = value instanceof KeyObject ? value : createPublicKey(value);
  const key = parsed.type === "private" ? createPublicKey(parsed) : parsed;
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("bootstrap verification keys must be Ed25519 keys");
  }
  return key;
}

export function stablePredecessorBootstrapKeyFingerprint(
  value: string | Buffer | KeyObject,
): string {
  return createHash("sha256")
    .update(publicKey(value).export({ format: "der", type: "spki" }))
    .digest("hex");
}

function inputBytes(
  value: string | Buffer,
  label: string,
  maximumBytes = MAXIMUM_BOOTSTRAP_INDEPENDENT_EVIDENCE_BYTES,
): Buffer {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  if (bytes.length === 0 || bytes.length > maximumBytes) {
    throw new Error(`${label} is empty or oversized`);
  }
  return bytes;
}

function gitObjectSha1(
  kind: "tag" | "commit" | "tree",
  bytes: Buffer,
): string {
  return createHash("sha1")
    .update(Buffer.from(`${kind} ${bytes.length}\0`, "utf8"))
    .update(bytes)
    .digest("hex");
}

export interface StablePredecessorBootstrapSourceBytesV1 {
  controllerWorkflowBytes: string | Buffer;
  tagObjectBytes: string | Buffer;
  sourceCommitBytes: string | Buffer;
  sourceTreeObjectBytes: string | Buffer;
}

function deriveStablePredecessorBootstrapSourceBindings(
  input: StablePredecessorBootstrapSourceBytesV1,
): {
  anchor: JsonRecord;
  controllerWorkflowSha256: string;
} {
  const controllerWorkflowBytes = inputBytes(
    input.controllerWorkflowBytes,
    "bootstrap controller workflow bytes",
  );
  const tagObjectBytes = inputBytes(
    input.tagObjectBytes,
    "bootstrap tag object bytes",
  );
  const sourceCommitBytes = inputBytes(
    input.sourceCommitBytes,
    "bootstrap source commit bytes",
  );
  const sourceTreeObjectBytes = inputBytes(
    input.sourceTreeObjectBytes,
    "bootstrap source tree object bytes",
    4 * 1024 * 1024,
  );
  if (
    gitObjectSha1("tag", tagObjectBytes)
      !== STABLE_PREDECESSOR_BOOTSTRAP_TAG_OBJECT
    || gitObjectSha1("commit", sourceCommitBytes)
      !== STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_REVISION
    || gitObjectSha1("tree", sourceTreeObjectBytes)
      !== STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_TREE
  ) {
    throw new Error(
      "bootstrap Git object bytes do not reconstruct the exact v2.3.4 anchor",
    );
  }
  const tagText = tagObjectBytes.toString("utf8");
  const messageOffset = tagText.indexOf("\n\n");
  if (
    messageOffset < 0
    || !tagText.startsWith(
      `object ${STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_REVISION}\n`
        + "type commit\n"
        + `tag ${STABLE_PREDECESSOR_BOOTSTRAP_TAG}\n`,
    )
    || tagText.slice(messageOffset + 2) !== "Release v2.3.4\n"
    || !sourceCommitBytes.toString("utf8").startsWith(
      `tree ${STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_TREE}\n`,
    )
  ) {
    throw new Error(
      "bootstrap Git object bytes have an unexpected tag, message, or tree binding",
    );
  }
  return {
    anchor: {
      tagObject: STABLE_PREDECESSOR_BOOTSTRAP_TAG_OBJECT,
      tagObjectSha256: bytesSha256(tagObjectBytes),
      tagMessageSha256: bytesSha256(
        Buffer.from(tagText.slice(messageOffset + 2), "utf8"),
      ),
      sourceCommitSha256: bytesSha256(sourceCommitBytes),
      sourceTreeObjectSha256: bytesSha256(sourceTreeObjectBytes),
    },
    controllerWorkflowSha256: bytesSha256(controllerWorkflowBytes),
  };
}

function assertStablePredecessorBootstrapSourceBindings(
  payload: JsonRecord,
  input: StablePredecessorBootstrapSourceBytesV1,
): void {
  const derived = deriveStablePredecessorBootstrapSourceBindings(input);
  const anchor = fixedAnchor(
    payload.anchor,
    "bootstrap evidence anchor",
  );
  const controllerValue = controller(
    payload.controller,
    "bootstrap evidence controller",
  );
  if (
    stableSignedArtifactJson(anchor)
      !== stableSignedArtifactJson(derived.anchor)
    || controllerValue.workflowSha256
      !== derived.controllerWorkflowSha256
  ) {
    throw new Error(
      "bootstrap evidence anchor or workflow digest was not derived from the supplied exact bytes",
    );
  }
}

function sortedObservationValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedObservationValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value as JsonRecord)
      .sort()
      .map((key) => [
        key,
        sortedObservationValue((value as JsonRecord)[key]),
      ]),
  );
}

export function stablePredecessorRailwayObservationBytes(
  value: unknown,
): Buffer {
  return Buffer.from(
    `${JSON.stringify(sortedObservationValue(value), null, 2)}\n`,
    "utf8",
  );
}

function bytesSha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function railwayObservationLane(
  value: unknown,
  index: number,
): JsonRecord {
  const lane = exactObject(value, [
    "lane",
    "deploymentId",
    "railwayMetaImageDigest",
    "buildkitOciManifestDigest",
    "buildkitOciConfigDigest",
    "railpackPlanLoadVertexDigest",
    "canonicalDeploymentObservationSha256",
    "canonicalBuildLogObservationSha256",
    "buildLogRecordCount",
  ], `recovered Railway observation lanes[${index}]`);
  const expected = EXPECTED_RAILWAY_LANES[index];
  if (
    !expected
    || stableSignedArtifactJson(lane)
      !== stableSignedArtifactJson(expected)
  ) {
    throw new Error(
      `recovered Railway observation lane ${index} is not the exact v2.3.4 record`,
    );
  }
  return lane;
}

export function validateStablePredecessorRecoveredRailwayObservationV1(
  value: unknown,
): JsonRecord {
  const observation = exactObject(value, [
    "schemaVersion",
    "kind",
    "sourceRevision",
    "sourceTree",
    "sourceBuildIntentSha256",
    "sourcePackageSha256",
    "sourceLockfileSha256",
    "sourceWorkspaceSha256",
    "capture",
    "railpack",
    "lanes",
    "limitations",
  ], "recovered Railway observation");
  const capture = exactObject(observation.capture, [
    "method",
    "canonicalization",
    "railwaySigned",
    "registryReferenceRecovered",
    "manifestBytesRecovered",
    "configBytesRecovered",
    "generatedPlanBytesRecovered",
    "sbomRecovered",
    "supplyChainAttestationRecovered",
  ], "recovered Railway observation capture");
  const railpack = exactObject(observation.railpack, [
    "version",
    "frontendImageReference",
    "buildEnvironment",
    "buildCommand",
    "nodeVersion",
    "pnpmVersion",
    "builderTagObservation",
    "runtimeTagObservation",
    "builderAndRuntimeTagsAreImmutable",
  ], "recovered Railway observation railpack");
  if (
    observation.schemaVersion
      !== STABLE_PREDECESSOR_RECOVERED_RAILWAY_OBSERVATION_SCHEMA_V1
    || observation.kind
      !== "authenticated_platform_observation_not_supply_chain_attestation"
    || observation.sourceRevision
      !== STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_REVISION
    || observation.sourceTree !== STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_TREE
    || observation.sourceBuildIntentSha256
      !== STABLE_PREDECESSOR_HISTORICAL_BUILD_INTENT_SHA256
    || observation.sourcePackageSha256
      !== STABLE_PREDECESSOR_HISTORICAL_PACKAGE_SHA256
    || observation.sourceLockfileSha256
      !== STABLE_PREDECESSOR_HISTORICAL_LOCKFILE_SHA256
    || observation.sourceWorkspaceSha256
      !== STABLE_PREDECESSOR_HISTORICAL_WORKSPACE_SHA256
    || capture.method !== "authenticated_railway_api_and_cli"
    || capture.canonicalization
      !== "recursive_lexicographic_key_sort_pretty_json_two_spaces_trailing_lf_v1"
    || capture.railwaySigned !== false
    || capture.registryReferenceRecovered !== false
    || capture.manifestBytesRecovered !== false
    || capture.configBytesRecovered !== false
    || capture.generatedPlanBytesRecovered !== false
    || capture.sbomRecovered !== false
    || capture.supplyChainAttestationRecovered !== false
    || railpack.version !== "0.32.0"
    || railpack.frontendImageReference
      !== STABLE_PREDECESSOR_RAILPACK_FRONTEND_REFERENCE
    || railpack.buildEnvironment !== "V3"
    || railpack.buildCommand !== "pnpm run build:server"
    || railpack.nodeVersion !== "22.23.1"
    || railpack.pnpmVersion !== "11.7.0"
    || railpack.builderTagObservation
      !== "ghcr.io/railwayapp/railpack-builder:mise-2026.7.11"
    || railpack.runtimeTagObservation
      !== "ghcr.io/railwayapp/railpack-runtime:mise-2026.7.11"
    || railpack.builderAndRuntimeTagsAreImmutable !== false
    || JSON.stringify(observation.limitations)
      !== JSON.stringify([
        "observed_digests_have_no_recovered_registry_reference_or_manifest_bytes",
        "railway_meta_image_digest_is_not_proven_equivalent_to_buildkit_oci_manifest_digest",
        "railpack_plan_load_vertex_digest_does_not_recover_generated_plan_bytes",
      ])
    || !Array.isArray(observation.lanes)
    || observation.lanes.length !== EXPECTED_RAILWAY_LANES.length
  ) {
    throw new Error(
      "recovered Railway observation is not the exact limited v2.3.4 record",
    );
  }
  observation.lanes.forEach(railwayObservationLane);
  return observation;
}

export function stablePredecessorRecoveredRailwayObservationV1(): JsonRecord {
  return validateStablePredecessorRecoveredRailwayObservationV1({
    schemaVersion:
      STABLE_PREDECESSOR_RECOVERED_RAILWAY_OBSERVATION_SCHEMA_V1,
    kind: "authenticated_platform_observation_not_supply_chain_attestation",
    sourceRevision: STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_REVISION,
    sourceTree: STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_TREE,
    sourceBuildIntentSha256:
      STABLE_PREDECESSOR_HISTORICAL_BUILD_INTENT_SHA256,
    sourcePackageSha256: STABLE_PREDECESSOR_HISTORICAL_PACKAGE_SHA256,
    sourceLockfileSha256: STABLE_PREDECESSOR_HISTORICAL_LOCKFILE_SHA256,
    sourceWorkspaceSha256: STABLE_PREDECESSOR_HISTORICAL_WORKSPACE_SHA256,
    capture: {
      method: "authenticated_railway_api_and_cli",
      canonicalization:
        "recursive_lexicographic_key_sort_pretty_json_two_spaces_trailing_lf_v1",
      railwaySigned: false,
      registryReferenceRecovered: false,
      manifestBytesRecovered: false,
      configBytesRecovered: false,
      generatedPlanBytesRecovered: false,
      sbomRecovered: false,
      supplyChainAttestationRecovered: false,
    },
    railpack: {
      version: "0.32.0",
      frontendImageReference:
        STABLE_PREDECESSOR_RAILPACK_FRONTEND_REFERENCE,
      buildEnvironment: "V3",
      buildCommand: "pnpm run build:server",
      nodeVersion: "22.23.1",
      pnpmVersion: "11.7.0",
      builderTagObservation:
        "ghcr.io/railwayapp/railpack-builder:mise-2026.7.11",
      runtimeTagObservation:
        "ghcr.io/railwayapp/railpack-runtime:mise-2026.7.11",
      builderAndRuntimeTagsAreImmutable: false,
    },
    lanes: EXPECTED_RAILWAY_LANES.map((lane) => ({ ...lane })),
    limitations: [
      "observed_digests_have_no_recovered_registry_reference_or_manifest_bytes",
      "railway_meta_image_digest_is_not_proven_equivalent_to_buildkit_oci_manifest_digest",
      "railpack_plan_load_vertex_digest_does_not_recover_generated_plan_bytes",
    ],
  });
}

function validateOriginalRailwayProvenancePayloadV1(
  value: unknown,
  expectedRepository: string,
): JsonRecord {
  const payload = exactObject(value, [
    "schemaVersion",
    "issuer",
    "generatedAt",
    "expiresAt",
    "operation",
    "repository",
    "sourceRevision",
    "sourceTree",
    "recoveredRailwayObservationHash",
    "deploymentIds",
    "originalImageReference",
    "originalImageDigest",
    "verificationMethod",
    "verifiedClaims",
  ], "original Railway provenance");
  const generatedAt = timestamp(
    payload.generatedAt,
    "original Railway provenance.generatedAt",
  );
  const expiresAt = timestamp(
    payload.expiresAt,
    "original Railway provenance.expiresAt",
  );
  const claims = exactObject(payload.verifiedClaims, [
    "sourceRevisionBound",
    "deploymentSetBound",
    "registryReferenceResolved",
    "manifestBytesVerified",
  ], "original Railway provenance verifiedClaims");
  const originalImageReference = String(payload.originalImageReference ?? "");
  const originalImageDigest = imageDigest(
    payload.originalImageDigest,
    "original Railway provenance image digest",
  );
  if (
    payload.schemaVersion
      !== STABLE_PREDECESSOR_ORIGINAL_RAILWAY_PROVENANCE_SCHEMA_V1
    || payload.issuer !== "genio-independent-railway-provenance-verifier"
    || payload.operation !== "verify_original_v2_3_4_production_image"
    || payload.repository !== expectedRepository
    || payload.sourceRevision !== STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_REVISION
    || payload.sourceTree !== STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_TREE
    || Date.parse(expiresAt) <= Date.parse(generatedAt)
    || Date.parse(expiresAt) - Date.parse(generatedAt)
      > STABLE_PREDECESSOR_BOOTSTRAP_TTL_MS
    || !IMMUTABLE_OCI_REFERENCE.test(originalImageReference)
    || !originalImageReference.endsWith(`@${originalImageDigest}`)
    || payload.verificationMethod
      !== "independent_railway_control_plane_and_registry_manifest"
    || claims.sourceRevisionBound !== true
    || claims.deploymentSetBound !== true
    || claims.registryReferenceResolved !== true
    || claims.manifestBytesVerified !== true
    || JSON.stringify(payload.deploymentIds)
      !== JSON.stringify(EXPECTED_RAILWAY_LANES.map(({ deploymentId }) =>
        deploymentId
      ))
  ) {
    throw new Error(
      "original Railway provenance does not prove the exact v2.3.4 production artifact",
    );
  }
  sha256Digest(
    payload.recoveredRailwayObservationHash,
    "original Railway provenance observation hash",
  );
  return payload;
}

export function createStablePredecessorOriginalRailwayProvenanceV1(input: {
  repository: string;
  originalImageReference: string;
  recoveredRailwayObservation: unknown;
  signingKey: string | Buffer | KeyObject;
  keyId: string;
  generatedAt?: string;
}): ReturnType<typeof createStrictSignedEnvelope> {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const recovered = validateStablePredecessorRecoveredRailwayObservationV1(
    input.recoveredRailwayObservation,
  );
  const payload = validateOriginalRailwayProvenancePayloadV1({
    schemaVersion:
      STABLE_PREDECESSOR_ORIGINAL_RAILWAY_PROVENANCE_SCHEMA_V1,
    issuer: "genio-independent-railway-provenance-verifier",
    generatedAt,
    expiresAt: new Date(
      Date.parse(generatedAt) + STABLE_PREDECESSOR_BOOTSTRAP_TTL_MS,
    ).toISOString(),
    operation: "verify_original_v2_3_4_production_image",
    repository: input.repository,
    sourceRevision: STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_REVISION,
    sourceTree: STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_TREE,
    recoveredRailwayObservationHash: signedArtifactSha256(recovered),
    deploymentIds: EXPECTED_RAILWAY_LANES.map(({ deploymentId }) =>
      deploymentId
    ),
    originalImageReference: input.originalImageReference,
    originalImageDigest: input.originalImageReference.split("@").at(-1),
    verificationMethod:
      "independent_railway_control_plane_and_registry_manifest",
    verifiedClaims: {
      sourceRevisionBound: true,
      deploymentSetBound: true,
      registryReferenceResolved: true,
      manifestBytesVerified: true,
    },
  }, input.repository);
  return createStrictSignedEnvelope({
    envelopeSchemaVersion:
      SIGNED_STABLE_PREDECESSOR_ORIGINAL_RAILWAY_PROVENANCE_SCHEMA_V1,
    payload,
    signingKey: privateKey(input.signingKey),
    keyId: input.keyId,
  });
}

export function verifyStablePredecessorOriginalRailwayProvenanceV1(input: {
  value: unknown;
  verificationKey: string | Buffer | KeyObject;
  approvedKeyId: string;
  approvedKeySha256: string;
  recoveredRailwayObservation: unknown;
  expectedRepository: string;
  now?: string;
}): ReturnType<typeof verifyStrictSignedEnvelope> {
  const fingerprint =
    stablePredecessorBootstrapKeyFingerprint(input.verificationKey);
  if (
    !KEY_ID.test(input.approvedKeyId)
    || fingerprint !== sha256Digest(
      input.approvedKeySha256,
      "approved original Railway provenance key fingerprint",
    )
  ) {
    throw new Error(
      "original Railway provenance does not use the protected verifier key",
    );
  }
  const verified = verifyStrictSignedEnvelope({
    value: input.value,
    verificationKey: publicKey(input.verificationKey),
    envelopeSchemaVersion:
      SIGNED_STABLE_PREDECESSOR_ORIGINAL_RAILWAY_PROVENANCE_SCHEMA_V1,
    payloadLabel: "original Railway provenance",
    validatePayload: (value) => validateOriginalRailwayProvenancePayloadV1(
      value,
      input.expectedRepository,
    ),
  });
  const recovered = validateStablePredecessorRecoveredRailwayObservationV1(
    input.recoveredRailwayObservation,
  );
  const now = input.now
    ? timestamp(input.now, "original Railway provenance verification time")
    : new Date().toISOString();
  if (
    verified.keyId !== input.approvedKeyId
    || verified.payload.recoveredRailwayObservationHash
      !== signedArtifactSha256(recovered)
    || Date.parse(now) < Date.parse(String(verified.payload.generatedAt))
    || Date.parse(now) >= Date.parse(String(verified.payload.expiresAt))
  ) {
    throw new Error(
      "original Railway provenance signature, observation binding, or validity window is invalid",
    );
  }
  return verified;
}

export async function captureStablePredecessorRecoveredRailwayObservation(
  input: {
    apiDeploymentPath: string;
    apiBuildLogPath: string;
    workerDeploymentPath: string;
    workerBuildLogPath: string;
    deepDeploymentPath: string;
    deepBuildLogPath: string;
  },
): Promise<JsonRecord> {
  const paths = [
    input.apiDeploymentPath,
    input.apiBuildLogPath,
    input.workerDeploymentPath,
    input.workerBuildLogPath,
    input.deepDeploymentPath,
    input.deepBuildLogPath,
  ];
  if (new Set(paths).size !== paths.length) {
    throw new Error("Railway capture inputs must be six distinct files");
  }
  const lanePaths = [
    [input.apiDeploymentPath, input.apiBuildLogPath],
    [input.workerDeploymentPath, input.workerBuildLogPath],
    [input.deepDeploymentPath, input.deepBuildLogPath],
  ] as const;
  for (const [index, [deploymentPath, logPath]] of lanePaths.entries()) {
    const [deploymentBytes, logBytes] = await Promise.all([
      readFile(deploymentPath),
      readFile(logPath),
    ]);
    if (
      deploymentBytes.length === 0
      || deploymentBytes.length > 128 * 1024
      || logBytes.length === 0
      || logBytes.length > 2 * 1024 * 1024
    ) {
      throw new Error(`Railway capture lane ${index} is empty or oversized`);
    }
    let deployment: unknown;
    let logs: unknown;
    try {
      deployment = JSON.parse(deploymentBytes.toString("utf8"));
      logs = JSON.parse(logBytes.toString("utf8"));
    } catch {
      throw new Error(`Railway capture lane ${index} is not readable JSON`);
    }
    const expected = EXPECTED_RAILWAY_LANES[index]!;
    const deploymentRecord = exactObject(
      deployment,
      Object.keys(deployment as JsonRecord),
      `Railway deployment capture lane ${index}`,
    );
    const metadata = exactObject(
      deploymentRecord.meta,
      Object.keys(deploymentRecord.meta as JsonRecord),
      `Railway deployment capture lane ${index}.meta`,
    );
    if (
      deploymentRecord.id !== expected.deploymentId
      || metadata.commitHash !== STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_REVISION
      || metadata.imageDigest !== expected.railwayMetaImageDigest
      || bytesSha256(stablePredecessorRailwayObservationBytes(deployment))
        !== expected.canonicalDeploymentObservationSha256
      || !Array.isArray(logs)
      || logs.length !== expected.buildLogRecordCount
      || bytesSha256(stablePredecessorRailwayObservationBytes(logs))
        !== expected.canonicalBuildLogObservationSha256
    ) {
      throw new Error(
        `Railway capture lane ${index} does not match the exact v2.3.4 observation`,
      );
    }
    const messages = logs.map((entry) =>
      String((entry as JsonRecord)?.message ?? "")
    );
    for (const required of [
      `docker-image://${STABLE_PREDECESSOR_RAILPACK_FRONTEND_REFERENCE}`,
      `load build definition from ./railpack-plan.json`,
      `containerimage.digest: ${expected.buildkitOciManifestDigest}`,
      `containerimage.config.digest: ${expected.buildkitOciConfigDigest}`,
    ]) {
      if (!messages.includes(required)) {
        throw new Error(
          `Railway capture lane ${index} is missing ${required}`,
        );
      }
    }
    if (!logs.some((entry) =>
      (entry as JsonRecord)?.message
        === "load build definition from ./railpack-plan.json"
      && (entry as JsonRecord)?.digest
        === expected.railpackPlanLoadVertexDigest
    )) {
      throw new Error(
        `Railway capture lane ${index} has the wrong plan-load observation`,
      );
    }
  }
  return stablePredecessorRecoveredRailwayObservationV1();
}

function fixedCandidate(value: unknown, label: string): JsonRecord {
  const candidate = exactObject(value, [
    "compatibilityRcTag",
    "compatibilityRcTagIsSynthetic",
    "stableTag",
    "version",
    "sourceRevision",
    "sourceTree",
    "imageDigest",
    "imageReference",
  ], label);
  const digest = imageDigest(candidate.imageDigest, `${label}.imageDigest`);
  if (
    candidate.compatibilityRcTag
      !== STABLE_PREDECESSOR_BOOTSTRAP_COMPATIBILITY_RC_TAG
    || candidate.compatibilityRcTagIsSynthetic !== true
    || candidate.stableTag !== STABLE_PREDECESSOR_BOOTSTRAP_TAG
    || candidate.version !== STABLE_PREDECESSOR_BOOTSTRAP_VERSION
    || candidate.sourceRevision
      !== STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_REVISION
    || candidate.sourceTree !== STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_TREE
    || typeof candidate.imageReference !== "string"
    || !IMAGE_REFERENCE.test(candidate.imageReference)
    || !candidate.imageReference.endsWith(`@${digest}`)
  ) {
    throw new Error(`${label} is not the exact v2.3.4 bootstrap target`);
  }
  return candidate;
}

function fixedAnchor(value: unknown, label: string): JsonRecord {
  const anchor = exactObject(value, [
    "tagObject",
    "tagObjectSha256",
    "tagMessageSha256",
    "sourceCommitSha256",
    "sourceTreeObjectSha256",
  ], label);
  if (anchor.tagObject !== STABLE_PREDECESSOR_BOOTSTRAP_TAG_OBJECT) {
    throw new Error(`${label} does not bind the original v2.3.4 tag object`);
  }
  for (const name of [
    "tagObjectSha256",
    "tagMessageSha256",
    "sourceCommitSha256",
    "sourceTreeObjectSha256",
  ]) {
    sha256Digest(anchor[name], `${label}.${name}`);
  }
  return anchor;
}

function fixedSuccessorPolicy(value: unknown, label: string): JsonRecord {
  const policy = exactObject(value, [
    "version",
    "rcTagPattern",
    "requiresGreatestLowerStable",
    "requiresControllerAncestry",
    "forbidsPublishedStableVersion",
  ], label);
  if (
    policy.version !== STABLE_PREDECESSOR_BOOTSTRAP_SUCCESSOR_VERSION
    || policy.rcTagPattern
      !== STABLE_PREDECESSOR_BOOTSTRAP_SUCCESSOR_RC_PATTERN
    || policy.requiresGreatestLowerStable !== true
    || policy.requiresControllerAncestry !== true
    || policy.forbidsPublishedStableVersion !== true
  ) {
    throw new Error(`${label} is not the one-time v2.4.0 successor policy`);
  }
  return policy;
}

function controller(
  value: unknown,
  label: string,
  expectedRepository?: string,
  expectedDefaultBranch?: string,
): JsonRecord {
  const source = exactObject(value, [
    "repository",
    "defaultBranch",
    "sourceRevision",
    "workflow",
    "workflowSha256",
  ], label);
  if (
    typeof source.repository !== "string"
    || !/^[^/\s]+\/[^/\s]+$/u.test(source.repository)
    || typeof source.defaultBranch !== "string"
    || !/^[0-9A-Za-z._/-]{1,255}$/u.test(source.defaultBranch)
    || source.workflow
      !== `${source.repository}/${STABLE_PREDECESSOR_BOOTSTRAP_WORKFLOW}`
    || (expectedRepository && source.repository !== expectedRepository)
    || (expectedDefaultBranch && source.defaultBranch !== expectedDefaultBranch)
  ) {
    throw new Error(`${label} is not the protected repository controller`);
  }
  revision(source.sourceRevision, `${label}.sourceRevision`);
  sha256Digest(source.workflowSha256, `${label}.workflowSha256`);
  return source;
}

function fixtures(value: unknown, label: string): JsonRecord[] {
  if (!Array.isArray(value) || value.length < 3) {
    throw new Error(`${label} must contain at least three protected fixtures`);
  }
  const ids = new Set<string>();
  return value.map((item, index) => {
    const fixture = exactObject(item, [
      "fixtureId",
      "orderedManifestHash",
      "outputHash",
    ], `${label}[${index}]`);
    if (
      typeof fixture.fixtureId !== "string"
      || !/^[0-9A-Za-z][0-9A-Za-z._:-]{2,159}$/u.test(fixture.fixtureId)
      || ids.has(fixture.fixtureId)
    ) {
      throw new Error(`${label}[${index}] has an invalid or duplicate fixture`);
    }
    ids.add(fixture.fixtureId);
    sha256Digest(
      fixture.orderedManifestHash,
      `${label}[${index}].orderedManifestHash`,
    );
    sha256Digest(fixture.outputHash, `${label}[${index}].outputHash`);
    return fixture;
  });
}

export function stablePredecessorBootstrapFixtureRegistryHash(
  value: unknown,
): string {
  const parsed = fixtures(value, "stable predecessor bootstrap fixture registry");
  return signedArtifactSha256({
    schemaVersion: STABLE_PREDECESSOR_BOOTSTRAP_FIXTURE_REGISTRY_SCHEMA_V1,
    fixtures: parsed,
  });
}

function gates(value: unknown, label: string): JsonRecord[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const parsed = value.map((item, index) => {
    const gate = exactObject(item, [
      "name",
      "environment",
      "passed",
      "evidenceHash",
    ], `${label}[${index}]`);
    if (
      typeof gate.name !== "string"
      || typeof gate.environment !== "string"
      || gate.passed !== true
    ) {
      throw new Error(`${label}[${index}] is not an exact passing gate`);
    }
    sha256Digest(gate.evidenceHash, `${label}[${index}].evidenceHash`);
    return gate;
  });
  const finalBrowser = parsed.filter(({ name }) =>
    name === "final_custom_domain_browser"
  );
  if (
    finalBrowser.length !== 1
    || finalBrowser[0]!.environment !== "production"
  ) {
    throw new Error(`${label} must contain one production final browser gate`);
  }
  return parsed;
}

function bootstrapProducerVerificationKey(value: unknown): {
  descriptor: JsonRecord;
  key: KeyObject;
  fingerprint: string;
} {
  const descriptor = exactObject(value, [
    "schemaVersion",
    "algorithm",
    "keyId",
    "publicKeyPem",
    "publicKeySha256",
  ], "bootstrap independent evidence producer verification key");
  if (
    descriptor.schemaVersion
      !== "genio-stable-predecessor-bootstrap-producer-verification-key/v1"
    || descriptor.algorithm !== "Ed25519"
    || typeof descriptor.keyId !== "string"
    || !KEY_ID.test(descriptor.keyId)
    || typeof descriptor.publicKeyPem !== "string"
  ) {
    throw new Error(
      "bootstrap independent evidence producer verification key is invalid",
    );
  }
  let key: KeyObject;
  try {
    key = publicKey(descriptor.publicKeyPem);
  } catch {
    throw new Error(
      "bootstrap independent evidence producer verification key cannot be parsed",
    );
  }
  const canonicalPem = key.export({
    format: "pem",
    type: "spki",
  }).toString();
  const fingerprint = releaseGateProducerKeyFingerprint(key);
  if (
    descriptor.publicKeyPem !== canonicalPem
    || sha256Digest(
      descriptor.publicKeySha256,
      "bootstrap independent evidence producer key fingerprint",
    ) !== fingerprint
  ) {
    throw new Error(
      "bootstrap independent evidence producer verification key is not canonical",
    );
  }
  return { descriptor, key, fingerprint };
}

function bootstrapArtifactCandidate(
  artifact: ReleaseGateArtifactV1,
  candidate: JsonRecord,
  label: string,
): void {
  const artifactCandidate = exactObject(artifact.candidate, [
    "tag",
    "version",
    "sourceRevision",
    "imageDigest",
    "sitesSourceRevision",
  ], `${label}.candidate`);
  if (
    artifactCandidate.tag
      !== STABLE_PREDECESSOR_BOOTSTRAP_COMPATIBILITY_RC_TAG
    || artifactCandidate.version !== STABLE_PREDECESSOR_BOOTSTRAP_VERSION
    || artifactCandidate.sourceRevision
      !== STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_REVISION
    || artifactCandidate.sitesSourceRevision
      !== STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_REVISION
    || artifactCandidate.imageDigest !== candidate.imageDigest
  ) {
    throw new Error(`${label} does not bind the exact bootstrap candidate`);
  }
}

function bootstrapFixtureFromArtifact(
  artifact: ReleaseGateArtifactV1,
  label: string,
): JsonRecord {
  if (artifact.fixtures.length !== 1) {
    throw new Error(`${label} must bind exactly one code-owned fixture`);
  }
  const fixture = exactObject(artifact.fixtures[0], [
    "fixtureId",
    "fixtureHash",
    "promptHash",
    "targetTrackCount",
    "guidanceMode",
    "guidanceSemanticsHash",
    "guidanceLineageHash",
  ], `${label}.fixture`);
  const sources = exactObject(artifact.sources, [
    "hostedPublication",
    "independentApple",
    "fixtureExecution",
  ], `${label}.sources`);
  const hosted = exactObject(sources.hostedPublication, [
    "schemaVersion",
    "canaryId",
    "cacheMode",
    "targetTrackCount",
    "manifestContentHash",
    "contractHash",
    "answerLineageHash",
    "queryPlanRevisionHash",
    "guidanceLineageHash",
    "guidanceRevisionCount",
    "executorRevisions",
    "executorIdentityHashes",
    "configurationHashes",
    "completedAttemptCount",
    "allAttemptsComplete",
    "serverReportedOrderedAppleReconciliation",
    "orderedAppleIdsHash",
    "independentAppleEvidenceHash",
    "volumes",
    "evidenceHash",
  ], `${label}.hostedPublication`);
  return {
    fixtureId: fixture.fixtureId,
    orderedManifestHash: sha256Digest(
      hosted.manifestContentHash,
      `${label}.manifestContentHash`,
    ),
    outputHash: sha256Digest(
      hosted.orderedAppleIdsHash,
      `${label}.orderedAppleIdsHash`,
    ),
  };
}

function validateStablePredecessorBootstrapIndependentEvidence(
  value: unknown,
  candidateValue: unknown,
): {
  bundle: JsonRecord;
  producerKeyId: string;
  producerKeySha256: string;
  sitesKeyId: string;
  sitesKeySha256: string;
  fixtures: JsonRecord[];
  gates: JsonRecord[];
  wrapperFixtureEvidenceHash: string;
  independentEvidenceHash: string;
} {
  const candidate = fixedCandidate(
    candidateValue,
    "bootstrap independent evidence candidate",
  );
  const bundle = exactObject(value, [
    "schemaVersion",
    "producerVerificationKey",
    "producerTrustPolicy",
    "sources",
  ], "bootstrap independent evidence bundle");
  if (
    bundle.schemaVersion
      !== STABLE_PREDECESSOR_BOOTSTRAP_INDEPENDENT_EVIDENCE_SCHEMA_V1
  ) {
    throw new Error(
      "bootstrap independent evidence bundle uses an unsupported schema",
    );
  }
  const producer = bootstrapProducerVerificationKey(
    bundle.producerVerificationKey,
  );
  const trust = validateReleaseGateProducerTrustPolicyV1(
    bundle.producerTrustPolicy,
  );
  if (
    trust.approvedKeyId !== producer.descriptor.keyId
    || trust.approvedKeySha256 !== producer.fingerprint
  ) {
    throw new Error(
      "bootstrap independent evidence producer is not protected by its exact trust policy",
    );
  }
  if (
    !Array.isArray(bundle.sources)
    || bundle.sources.length !== BOOTSTRAP_INDEPENDENT_GATES.length
  ) {
    throw new Error(
      "bootstrap independent evidence must contain the exact four source gates",
    );
  }
  const parsedFixtures: JsonRecord[] = [];
  const parsedGates: JsonRecord[] = [];
  const evidenceHashes = new Set<string>();
  let sitesKeySha256 = "";
  let sitesKeyId = "";
  for (const [index, sourceValue] of bundle.sources.entries()) {
    const expectedGate = BOOTSTRAP_INDEPENDENT_GATES[index]!;
    const source = exactObject(sourceValue, [
      "gate",
      "artifact",
      "attestation",
    ], `bootstrap independent evidence source[${index}]`);
    if (source.gate !== expectedGate) {
      throw new Error(
        "bootstrap independent evidence source gates are missing, reordered, or duplicated",
      );
    }
    const artifact = validateReleaseGateArtifact(source.artifact);
    if (artifact.gate !== expectedGate) {
      throw new Error(
        `bootstrap independent evidence source ${expectedGate} has the wrong artifact`,
      );
    }
    bootstrapArtifactCandidate(
      artifact,
      candidate,
      `bootstrap independent evidence source ${expectedGate}`,
    );
    const attestation = verifyReleaseGateProducerAttestation(
      source.attestation,
      artifact,
      producer.key,
    );
    if (attestation.signature.keyId !== producer.descriptor.keyId) {
      throw new Error(
        `bootstrap independent evidence source ${expectedGate} used an unapproved producer key`,
      );
    }
    if (evidenceHashes.has(artifact.evidenceHash)) {
      throw new Error(
        "bootstrap independent evidence source artifacts must have distinct evidence hashes",
      );
    }
    evidenceHashes.add(artifact.evidenceHash);
    parsedGates.push({
      name: artifact.gate,
      environment: artifact.environment,
      passed: true,
      evidenceHash: artifact.evidenceHash,
    });
    if (
      (BOOTSTRAP_FIXTURE_GATES as readonly string[]).includes(expectedGate)
    ) {
      parsedFixtures.push(
        bootstrapFixtureFromArtifact(
          artifact,
          `bootstrap independent evidence source ${expectedGate}`,
        ),
      );
    } else {
      const sources = exactObject(artifact.sources, [
        "browser",
        "sitesControlPlane",
        "sitesControlPlaneAttestation",
        "sitesControlPlaneTrust",
        "sitesControlPlaneVerificationKey",
        "sitesControlPlaneTrustPolicy",
      ], "bootstrap final browser sources");
      const sitesTrust = validateSitesControlPlaneTrustPolicyV1(
        sources.sitesControlPlaneTrustPolicy,
      );
      sitesKeyId = sitesTrust.approvedKeyId;
      sitesKeySha256 = sitesTrust.approvedKeySha256;
      if (sitesKeySha256 === producer.fingerprint) {
        throw new Error(
          "bootstrap browser producer and Sites control-plane keys must be distinct",
        );
      }
    }
  }
  const fixtureIds = parsedFixtures.map(({ fixtureId }) => fixtureId);
  if (
    stableSignedArtifactJson(fixtureIds)
      !== stableSignedArtifactJson([
        "fixed-three-track-control-v1",
        "smooth-reggaeton-heat-50-v1",
        "french-jazz-guided-constraint-25-v1",
      ])
  ) {
    throw new Error(
      "bootstrap independent fixture evidence does not bind the exact code-owned fixture set",
    );
  }
  const fixtureHashes = parsedFixtures.flatMap((fixture) => [
    String(fixture.orderedManifestHash),
    String(fixture.outputHash),
  ]);
  if (new Set(fixtureHashes).size !== fixtureHashes.length) {
    throw new Error(
      "bootstrap independent fixture evidence contains repeated manifest or output hashes",
    );
  }
  if (!sitesKeySha256) {
    throw new Error(
      "bootstrap independent evidence has no verified Sites authority",
    );
  }
  const independentEvidenceHash = signedArtifactSha256(bundle);
  const wrapperFixtureEvidenceHash = signedArtifactSha256({
    schemaVersion:
      "genio-stable-predecessor-bootstrap-wrapper-fixture-evidence/v1",
    independentEvidenceHash,
    fixtures: parsedFixtures,
    sourceGateEvidenceHashes: parsedGates
      .filter(({ name }) => name !== "final_custom_domain_browser")
      .map(({ evidenceHash }) => evidenceHash),
  });
  return {
    bundle,
    producerKeyId: String(producer.descriptor.keyId),
    producerKeySha256: producer.fingerprint,
    sitesKeyId,
    sitesKeySha256,
    fixtures: parsedFixtures,
    gates: parsedGates,
    wrapperFixtureEvidenceHash,
    independentEvidenceHash,
  };
}

function verifyProtectedBootstrapSitesAuthority(input: {
  independentEvidence: ReturnType<
    typeof validateStablePredecessorBootstrapIndependentEvidence
  >;
  verificationKey: unknown;
  trustPolicy: unknown;
}): {
  approvedKeyId: string;
  approvedKeySha256: string;
  attestationExpiresAt: string;
} {
  const protectedPolicy = validateSitesControlPlaneTrustPolicyV1(
    input.trustPolicy,
  );
  const protectedKey = validateSitesControlPlaneVerificationKeyV1(
    input.verificationKey,
  );
  if (
    protectedKey.source.sha256 !== protectedPolicy.approvedKeySha256
    || input.independentEvidence.sitesKeySha256
      !== protectedPolicy.approvedKeySha256
  ) {
    throw new Error(
      "bootstrap Sites evidence does not use the externally protected key",
    );
  }
  const sources = input.independentEvidence.bundle.sources as unknown[];
  const finalSource = exactObject(
    sources.at(-1),
    ["gate", "artifact", "attestation"],
    "bootstrap protected Sites source",
  );
  if (finalSource.gate !== "final_custom_domain_browser") {
    throw new Error("bootstrap protected Sites source is missing");
  }
  const artifact = validateReleaseGateArtifact(finalSource.artifact);
  const artifactSources = exactObject(artifact.sources, [
    "browser",
    "sitesControlPlane",
    "sitesControlPlaneAttestation",
    "sitesControlPlaneTrust",
    "sitesControlPlaneVerificationKey",
    "sitesControlPlaneTrustPolicy",
  ], "bootstrap protected Sites evidence");
  const embeddedPolicy = validateSitesControlPlaneTrustPolicyV1(
    artifactSources.sitesControlPlaneTrustPolicy,
  );
  const embeddedKey = validateSitesControlPlaneVerificationKeyV1(
    artifactSources.sitesControlPlaneVerificationKey,
  );
  if (
    stableSignedArtifactJson(embeddedPolicy)
      !== stableSignedArtifactJson(protectedPolicy)
    || embeddedKey.source.sha256 !== protectedPolicy.approvedKeySha256
    || embeddedKey.source.value !== protectedKey.source.value
  ) {
    throw new Error(
      "bootstrap embedded Sites key or trust policy was substituted",
    );
  }
  const receipt = exactObject(
    artifactSources.sitesControlPlane,
    Object.keys(artifactSources.sitesControlPlane as JsonRecord),
    "bootstrap Sites deployment receipt",
  );
  const verified = verifySitesControlPlaneAttestation({
    value: artifactSources.sitesControlPlaneAttestation,
    verificationKey: protectedKey.key,
    expectedReceiptHash: String(receipt.evidenceHash),
    expectedKeyId: protectedPolicy.approvedKeyId,
    expectedKeyFingerprint: protectedPolicy.approvedKeySha256,
    now: artifact.completedAt,
  });
  return {
    ...protectedPolicy,
    attestationExpiresAt: String(verified.payload.expiresAt),
  };
}

export function compressStablePredecessorBootstrapIndependentEvidenceV1(
  value: unknown,
): JsonRecord {
  const canonicalBytes = Buffer.from(
    JSON.stringify(value),
    "utf8",
  );
  if (
    canonicalBytes.length === 0
    || canonicalBytes.length > MAXIMUM_BOOTSTRAP_INDEPENDENT_EVIDENCE_BYTES
  ) {
    throw new Error("bootstrap independent evidence is empty or oversized");
  }
  const compressed = deflateRawSync(canonicalBytes, { level: 9 });
  if (
    compressed.length === 0
    || compressed.length > MAXIMUM_BOOTSTRAP_COMPRESSED_EVIDENCE_BYTES
  ) {
    throw new Error(
      "compressed bootstrap independent evidence is empty or oversized",
    );
  }
  return {
    schemaVersion:
      STABLE_PREDECESSOR_BOOTSTRAP_COMPRESSED_EVIDENCE_SCHEMA_V1,
    compression: "deflate-raw-level-9",
    uncompressedBytes: canonicalBytes.length,
    uncompressedSha256: bytesSha256(canonicalBytes),
    compressedBytes: compressed.length,
    compressedSha256: bytesSha256(compressed),
    encoded: compressed.toString("base64url"),
  };
}

function validateCompressedStablePredecessorBootstrapIndependentEvidence(
  value: unknown,
  candidate: unknown,
): ReturnType<
  typeof validateStablePredecessorBootstrapIndependentEvidence
> & { compressed: JsonRecord } {
  const compressed = exactObject(value, [
    "schemaVersion",
    "compression",
    "uncompressedBytes",
    "uncompressedSha256",
    "compressedBytes",
    "compressedSha256",
    "encoded",
  ], "compressed bootstrap independent evidence");
  if (
    compressed.schemaVersion
      !== STABLE_PREDECESSOR_BOOTSTRAP_COMPRESSED_EVIDENCE_SCHEMA_V1
    || compressed.compression !== "deflate-raw-level-9"
    || !Number.isSafeInteger(compressed.uncompressedBytes)
    || Number(compressed.uncompressedBytes) < 1
    || Number(compressed.uncompressedBytes)
      > MAXIMUM_BOOTSTRAP_INDEPENDENT_EVIDENCE_BYTES
    || !Number.isSafeInteger(compressed.compressedBytes)
    || Number(compressed.compressedBytes) < 1
    || Number(compressed.compressedBytes)
      > MAXIMUM_BOOTSTRAP_COMPRESSED_EVIDENCE_BYTES
    || typeof compressed.encoded !== "string"
    || !/^[0-9A-Za-z_-]+$/u.test(compressed.encoded)
  ) {
    throw new Error(
      "compressed bootstrap independent evidence envelope is invalid",
    );
  }
  const compressedBytes = Buffer.from(compressed.encoded, "base64url");
  if (
    compressedBytes.toString("base64url") !== compressed.encoded
    || compressedBytes.length !== compressed.compressedBytes
    || bytesSha256(compressedBytes) !== sha256Digest(
      compressed.compressedSha256,
      "compressed bootstrap independent evidence hash",
    )
  ) {
    throw new Error(
      "compressed bootstrap independent evidence bytes do not match their commitment",
    );
  }
  let canonicalBytes: Buffer;
  try {
    canonicalBytes = inflateRawSync(compressedBytes, {
      maxOutputLength: MAXIMUM_BOOTSTRAP_INDEPENDENT_EVIDENCE_BYTES,
    });
  } catch {
    throw new Error(
      "compressed bootstrap independent evidence cannot be decoded safely",
    );
  }
  if (
    canonicalBytes.length !== compressed.uncompressedBytes
    || bytesSha256(canonicalBytes) !== sha256Digest(
      compressed.uncompressedSha256,
      "bootstrap independent evidence hash",
    )
  ) {
    throw new Error(
      "bootstrap independent evidence bytes do not match their commitment",
    );
  }
  let bundle: unknown;
  try {
    bundle = JSON.parse(canonicalBytes.toString("utf8"));
  } catch {
    throw new Error("bootstrap independent evidence is not canonical JSON");
  }
  if (
    canonicalBytes.toString("utf8") !== JSON.stringify(bundle)
    || deflateRawSync(canonicalBytes, { level: 9 }).toString("base64url")
      !== compressed.encoded
  ) {
    throw new Error(
      "bootstrap independent evidence encoding is not canonical",
    );
  }
  return {
    compressed,
    ...validateStablePredecessorBootstrapIndependentEvidence(
      bundle,
      candidate,
    ),
  };
}

function validateEvidencePayload(
  value: unknown,
  expectedRepository?: string,
  expectedDefaultBranch?: string,
): JsonRecord {
  const payload = exactObject(value, [
    "schemaVersion",
    "issuer",
    "generatedAt",
    "expiresAt",
    "kind",
    "mode",
    "candidate",
    "anchor",
    "successorPolicy",
    "controller",
    "provenance",
    "independentEvidence",
    "productionObservation",
    "fixtures",
    "fixtureRegistryHash",
    "gates",
    "limitations",
  ], "stable predecessor bootstrap evidence");
  const generatedAt = timestamp(
    payload.generatedAt,
    "stable predecessor bootstrap evidence.generatedAt",
  );
  const expiresAt = timestamp(
    payload.expiresAt,
    "stable predecessor bootstrap evidence.expiresAt",
  );
  if (
    payload.schemaVersion !== STABLE_PREDECESSOR_BOOTSTRAP_EVIDENCE_SCHEMA_V1
    || payload.issuer !== "genio-protected-stable-predecessor-bootstrap-producer"
    || payload.kind !== "stable_predecessor_bootstrap"
    || payload.mode
      !== "recovered_observation_with_separate_reconstruction_wrapper"
    || Date.parse(expiresAt) <= Date.parse(generatedAt)
    || Date.parse(expiresAt) - Date.parse(generatedAt)
      > STABLE_PREDECESSOR_BOOTSTRAP_TTL_MS
  ) {
    throw new Error("stable predecessor bootstrap evidence provenance is invalid");
  }
  const candidate = fixedCandidate(
    payload.candidate,
    "bootstrap evidence candidate",
  );
  fixedAnchor(payload.anchor, "bootstrap evidence anchor");
  fixedSuccessorPolicy(
    payload.successorPolicy,
    "bootstrap evidence successor policy",
  );
  controller(
    payload.controller,
    "bootstrap evidence controller",
    expectedRepository,
    expectedDefaultBranch,
  );
  const provenance = exactObject(payload.provenance, [
    "imageAttestationHash",
    "recoveredRailwayObservationHash",
    "independentEvidenceHash",
    "fixtureRegistryHash",
  ], "bootstrap evidence provenance");
  sha256Digest(
    provenance.imageAttestationHash,
    "bootstrap evidence provenance.imageAttestationHash",
  );
  sha256Digest(
    provenance.recoveredRailwayObservationHash,
    "bootstrap evidence provenance.recoveredRailwayObservationHash",
  );
  const independent =
    validateCompressedStablePredecessorBootstrapIndependentEvidence(
      payload.independentEvidence,
      candidate,
    );
  if (
    provenance.independentEvidenceHash !== independent.independentEvidenceHash
  ) {
    throw new Error(
      "bootstrap evidence provenance does not bind its independent source bundle",
    );
  }
  sha256Digest(
    provenance.independentEvidenceHash,
    "bootstrap evidence provenance.independentEvidenceHash",
  );
  const registryHash = sha256Digest(
    payload.fixtureRegistryHash,
    "bootstrap evidence fixtureRegistryHash",
  );
  if (
    sha256Digest(
      provenance.fixtureRegistryHash,
      "bootstrap evidence provenance.fixtureRegistryHash",
    ) !== registryHash
  ) {
    throw new Error("bootstrap evidence fixture registry bindings differ");
  }
  const observation = exactObject(payload.productionObservation, [
    "sourceRevision",
    "kind",
    "recoveredRailwayObservationHash",
    "semanticBaselineScope",
    "wrapperFixtureEvidenceHash",
  ], "bootstrap evidence production observation");
  if (
    observation.sourceRevision
      !== STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_REVISION
    || observation.kind
      !== "authenticated_platform_observation_not_supply_chain_attestation"
    || observation.semanticBaselineScope
      !== "reconstruction_wrapper_only_not_historical_production_equivalence"
    || observation.recoveredRailwayObservationHash
      !== provenance.recoveredRailwayObservationHash
  ) {
    throw new Error("bootstrap production observation targets the wrong revision");
  }
  sha256Digest(
    observation.recoveredRailwayObservationHash,
    "bootstrap production observation.recoveredRailwayObservationHash",
  );
  sha256Digest(
    observation.wrapperFixtureEvidenceHash,
    "bootstrap production observation.wrapperFixtureEvidenceHash",
  );
  const parsedFixtures = fixtures(
    payload.fixtures,
    "bootstrap evidence fixtures",
  );
  if (
    stablePredecessorBootstrapFixtureRegistryHash(parsedFixtures)
      !== registryHash
    || stableSignedArtifactJson(parsedFixtures)
      !== stableSignedArtifactJson(independent.fixtures)
    || observation.wrapperFixtureEvidenceHash
      !== independent.wrapperFixtureEvidenceHash
  ) {
    throw new Error(
      "bootstrap evidence fixtures were not derived from the independent source bundle",
    );
  }
  const parsedGates = gates(payload.gates, "bootstrap evidence gates");
  if (
    stableSignedArtifactJson(parsedGates)
      !== stableSignedArtifactJson(independent.gates)
  ) {
    throw new Error(
      "bootstrap evidence gates were not derived from the independent source bundle",
    );
  }
  if (
    JSON.stringify(payload.limitations)
      !== JSON.stringify(STABLE_PREDECESSOR_BOOTSTRAP_LIMITATIONS)
  ) {
    throw new Error("bootstrap evidence limitations are missing or altered");
  }
  return payload;
}

export function validateStablePredecessorBootstrapImageAttestationV1(
  value: unknown,
  expectedRepository?: string,
  expectedDefaultBranch?: string,
): JsonRecord {
  const attestation = exactObject(value, [
    "schemaVersion",
    "repository",
    "workflow",
    "workflowRef",
    "workflowSourceRevision",
    "controllerRecipeSourceRevision",
    "controllerRecipeSha256",
    "historicalBuildIntentSha256",
    "builderIdentity",
    "reconstructionMode",
    "subjectImageReference",
    "subjectImageDigest",
    "historicalSourceRevision",
    "historicalSourceTree",
    "recoveredRailwayObservation",
    "recoveredRailwayObservationHash",
    "githubVerificationHash",
    "predicateType",
    "runnerEnvironment",
  ], "stable predecessor bootstrap image attestation");
  const digest = imageDigest(
    attestation.subjectImageDigest,
    "bootstrap image attestation.subjectImageDigest",
  );
  if (
    attestation.schemaVersion
      !== STABLE_PREDECESSOR_BOOTSTRAP_IMAGE_ATTESTATION_SCHEMA_V1
    || typeof attestation.repository !== "string"
    || (expectedRepository && attestation.repository !== expectedRepository)
    || attestation.workflow
      !== `${attestation.repository}/${STABLE_PREDECESSOR_BOOTSTRAP_IMAGE_WORKFLOW}`
    || attestation.workflowRef
      !== `refs/heads/${expectedDefaultBranch ?? "main"}`
    || attestation.controllerRecipeSourceRevision
      !== attestation.workflowSourceRevision
    || attestation.controllerRecipeSha256
      !== STABLE_PREDECESSOR_BOOTSTRAP_CONTROLLER_RECIPE_SHA256
    || attestation.historicalBuildIntentSha256
      !== STABLE_PREDECESSOR_HISTORICAL_BUILD_INTENT_SHA256
    || attestation.builderIdentity
      !== STABLE_PREDECESSOR_BOOTSTRAP_BUILDER_IDENTITY
    || attestation.reconstructionMode
      !== STABLE_PREDECESSOR_BOOTSTRAP_RECONSTRUCTION_MODE
    || typeof attestation.subjectImageReference !== "string"
    || !IMAGE_REFERENCE.test(attestation.subjectImageReference)
    || !attestation.subjectImageReference.endsWith(`@${digest}`)
    || attestation.historicalSourceRevision
      !== STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_REVISION
    || attestation.historicalSourceTree
      !== STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_TREE
    || attestation.predicateType
      !== STABLE_PREDECESSOR_BOOTSTRAP_PREDICATE_TYPE
    || attestation.runnerEnvironment !== "github-hosted"
  ) {
    throw new Error("stable predecessor bootstrap image attestation is invalid");
  }
  revision(
    attestation.workflowSourceRevision,
    "bootstrap image attestation.workflowSourceRevision",
  );
  revision(
    attestation.controllerRecipeSourceRevision,
    "bootstrap image attestation.controllerRecipeSourceRevision",
  );
  sha256Digest(
    attestation.controllerRecipeSha256,
    "bootstrap image attestation.controllerRecipeSha256",
  );
  const recovered = validateStablePredecessorRecoveredRailwayObservationV1(
    attestation.recoveredRailwayObservation,
  );
  if (
    signedArtifactSha256(recovered)
      !== attestation.recoveredRailwayObservationHash
  ) {
    throw new Error(
      "bootstrap image attestation does not bind the recovered Railway observation",
    );
  }
  sha256Digest(
    attestation.recoveredRailwayObservationHash,
    "bootstrap image attestation.recoveredRailwayObservationHash",
  );
  sha256Digest(
    attestation.githubVerificationHash,
    "bootstrap image attestation.githubVerificationHash",
  );
  return attestation;
}

function validateAuthorizationPayload(
  value: unknown,
  expectedRepository?: string,
  expectedDefaultBranch?: string,
): JsonRecord {
  const payload = exactObject(value, [
    "schemaVersion",
    "issuer",
    "generatedAt",
    "expiresAt",
    "action",
    "candidate",
    "anchor",
    "successorPolicy",
    "controller",
    "bootstrapEvidencePayloadHash",
    "protectedBaselineMetadataHash",
    "imageAttestationHash",
    "recoveredRailwayObservationHash",
    "independentEvidenceHash",
    "fixtureRegistryHash",
    "finalBrowserGateEvidenceHash",
    "producerKeyId",
    "producerKeySha256",
    "sitesKeyId",
    "sitesKeySha256",
    "originalRailwayProvenancePayloadHash",
    "originalRailwayProvenanceArtifactHash",
    "originalRailwayProvenanceKeyId",
    "originalRailwayProvenanceKeySha256",
    "originalRailwayImageDigest",
  ], "stable predecessor bootstrap authorization");
  const generatedAt = timestamp(
    payload.generatedAt,
    "bootstrap authorization.generatedAt",
  );
  const expiresAt = timestamp(
    payload.expiresAt,
    "bootstrap authorization.expiresAt",
  );
  if (
    payload.schemaVersion
      !== STABLE_PREDECESSOR_BOOTSTRAP_AUTHORIZATION_SCHEMA_V1
    || payload.issuer !== "genio-protected-stable-predecessor-bootstrap-authorizer"
    || payload.action !== "publish_immutable_v2_3_4_predecessor_bootstrap"
    || Date.parse(expiresAt) <= Date.parse(generatedAt)
    || Date.parse(expiresAt) - Date.parse(generatedAt)
      > STABLE_PREDECESSOR_BOOTSTRAP_TTL_MS
  ) {
    throw new Error("stable predecessor bootstrap authorization is invalid");
  }
  fixedCandidate(payload.candidate, "bootstrap authorization candidate");
  fixedAnchor(payload.anchor, "bootstrap authorization anchor");
  fixedSuccessorPolicy(
    payload.successorPolicy,
    "bootstrap authorization successor policy",
  );
  controller(
    payload.controller,
    "bootstrap authorization controller",
    expectedRepository,
    expectedDefaultBranch,
  );
  for (const name of [
    "bootstrapEvidencePayloadHash",
    "protectedBaselineMetadataHash",
    "imageAttestationHash",
    "recoveredRailwayObservationHash",
    "independentEvidenceHash",
    "fixtureRegistryHash",
    "finalBrowserGateEvidenceHash",
    "producerKeySha256",
    "sitesKeySha256",
    "originalRailwayProvenancePayloadHash",
    "originalRailwayProvenanceArtifactHash",
    "originalRailwayProvenanceKeySha256",
  ]) {
    sha256Digest(payload[name], `bootstrap authorization.${name}`);
  }
  imageDigest(
    payload.originalRailwayImageDigest,
    "bootstrap authorization.originalRailwayImageDigest",
  );
  if (
    typeof payload.producerKeyId !== "string"
    || !KEY_ID.test(payload.producerKeyId)
    || typeof payload.sitesKeyId !== "string"
    || !KEY_ID.test(payload.sitesKeyId)
    || typeof payload.originalRailwayProvenanceKeyId !== "string"
    || !KEY_ID.test(payload.originalRailwayProvenanceKeyId)
    || new Set([
      payload.producerKeySha256,
      payload.sitesKeySha256,
      payload.originalRailwayProvenanceKeySha256,
    ]).size !== 3
  ) {
    throw new Error(
      "bootstrap authorization independent producer authorities are invalid",
    );
  }
  return payload;
}

export function isSignedStablePredecessorBootstrapEvidence(
  value: unknown,
): boolean {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as JsonRecord).schemaVersion
      === SIGNED_STABLE_PREDECESSOR_BOOTSTRAP_EVIDENCE_SCHEMA_V1
  );
}

export function isSignedStablePredecessorBootstrapAuthorization(
  value: unknown,
): boolean {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as JsonRecord).schemaVersion
      === SIGNED_STABLE_PREDECESSOR_BOOTSTRAP_AUTHORIZATION_SCHEMA_V1
  );
}

export function validateStablePredecessorBootstrapSuccessor(input: {
  rcTag: string;
  sourceRevision: string;
}): void {
  if (
    !SUCCESSOR_RC.test(input.rcTag)
    || !REVISION.test(input.sourceRevision)
  ) {
    throw new Error(
      "v2.3.4 bootstrap may be consumed only by a v2.4.0-rc.N successor",
    );
  }
}

export function createStablePredecessorBootstrapImageAttestationV1(input: {
  repository: string;
  defaultBranch: string;
  controllerSourceRevision: string;
  imageReference: string;
  recoveredRailwayObservation: unknown;
  githubAttestationVerification: unknown;
}): JsonRecord {
  if (
    !input.githubAttestationVerification
    || typeof input.githubAttestationVerification !== "object"
  ) {
    throw new Error(
      "bootstrap image attestation requires structured GitHub verification",
    );
  }
  const recovered = validateStablePredecessorRecoveredRailwayObservationV1(
    input.recoveredRailwayObservation,
  );
  const digest = String(input.imageReference).split("@").at(-1) ?? "";
  return validateStablePredecessorBootstrapImageAttestationV1({
    schemaVersion:
      STABLE_PREDECESSOR_BOOTSTRAP_IMAGE_ATTESTATION_SCHEMA_V1,
    repository: input.repository,
    workflow:
      `${input.repository}/${STABLE_PREDECESSOR_BOOTSTRAP_IMAGE_WORKFLOW}`,
    workflowRef: `refs/heads/${input.defaultBranch}`,
    workflowSourceRevision: input.controllerSourceRevision,
    controllerRecipeSourceRevision: input.controllerSourceRevision,
    controllerRecipeSha256:
      STABLE_PREDECESSOR_BOOTSTRAP_CONTROLLER_RECIPE_SHA256,
    historicalBuildIntentSha256:
      STABLE_PREDECESSOR_HISTORICAL_BUILD_INTENT_SHA256,
    builderIdentity: STABLE_PREDECESSOR_BOOTSTRAP_BUILDER_IDENTITY,
    reconstructionMode: STABLE_PREDECESSOR_BOOTSTRAP_RECONSTRUCTION_MODE,
    subjectImageReference: input.imageReference,
    subjectImageDigest: digest,
    historicalSourceRevision:
      STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_REVISION,
    historicalSourceTree: STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_TREE,
    recoveredRailwayObservation: recovered,
    recoveredRailwayObservationHash: signedArtifactSha256(recovered),
    githubVerificationHash:
      signedArtifactSha256(input.githubAttestationVerification),
    predicateType: STABLE_PREDECESSOR_BOOTSTRAP_PREDICATE_TYPE,
    runnerEnvironment: "github-hosted",
  }, input.repository, input.defaultBranch);
}

export interface StablePredecessorBootstrapEvidenceInput
  extends StablePredecessorBootstrapSourceBytesV1 {
  repository: string;
  defaultBranch: string;
  controllerSourceRevision: string;
  imageReference: string;
  imageAttestation: unknown;
  recoveredRailwayObservation: unknown;
  independentEvidence: unknown;
  generatedAt?: string;
  signingKey: string | Buffer | KeyObject;
  keyId: string;
}

export function createStablePredecessorBootstrapEvidence(
  input: StablePredecessorBootstrapEvidenceInput,
): ReturnType<typeof createStrictSignedEnvelope> {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const image = validateStablePredecessorBootstrapImageAttestationV1(
    input.imageAttestation,
    input.repository,
    input.defaultBranch,
  );
  if (
    image.workflowSourceRevision !== input.controllerSourceRevision
    || image.subjectImageReference !== input.imageReference
  ) {
    throw new Error("bootstrap image attestation does not bind the controller");
  }
  const recovered = validateStablePredecessorRecoveredRailwayObservationV1(
    input.recoveredRailwayObservation,
  );
  const recoveredHash = signedArtifactSha256(recovered);
  if (
    image.recoveredRailwayObservationHash !== recoveredHash
    || stableSignedArtifactJson(image.recoveredRailwayObservation)
      !== stableSignedArtifactJson(recovered)
  ) {
    throw new Error(
      "bootstrap image attestation does not bind the supplied Railway observation",
    );
  }
  const digest = String(input.imageReference).split("@").at(-1) ?? "";
  const candidate = fixedCandidate({
    compatibilityRcTag:
      STABLE_PREDECESSOR_BOOTSTRAP_COMPATIBILITY_RC_TAG,
    compatibilityRcTagIsSynthetic: true,
    stableTag: STABLE_PREDECESSOR_BOOTSTRAP_TAG,
    version: STABLE_PREDECESSOR_BOOTSTRAP_VERSION,
    sourceRevision: STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_REVISION,
    sourceTree: STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_TREE,
    imageDigest: digest,
    imageReference: input.imageReference,
  }, "bootstrap evidence candidate");
  const sourceBindings =
    deriveStablePredecessorBootstrapSourceBindings(input);
  const independent =
    validateStablePredecessorBootstrapIndependentEvidence(
      input.independentEvidence,
      candidate,
    );
  const releaseKeySha256 =
    stablePredecessorBootstrapKeyFingerprint(input.signingKey);
  if (
    independent.producerKeySha256 === releaseKeySha256
    || independent.sitesKeySha256 === releaseKeySha256
  ) {
    throw new Error(
      "bootstrap release, independent producer, and Sites keys must be distinct",
    );
  }
  const compressedIndependent =
    compressStablePredecessorBootstrapIndependentEvidenceV1(
      independent.bundle,
    );
  const fixtureRegistryHash =
    stablePredecessorBootstrapFixtureRegistryHash(independent.fixtures);
  const payload = validateEvidencePayload({
    schemaVersion: STABLE_PREDECESSOR_BOOTSTRAP_EVIDENCE_SCHEMA_V1,
    issuer: "genio-protected-stable-predecessor-bootstrap-producer",
    generatedAt,
    expiresAt: new Date(
      Date.parse(generatedAt) + STABLE_PREDECESSOR_BOOTSTRAP_TTL_MS,
    ).toISOString(),
    kind: "stable_predecessor_bootstrap",
    mode: "recovered_observation_with_separate_reconstruction_wrapper",
    candidate,
    anchor: sourceBindings.anchor,
    successorPolicy: {
      version: STABLE_PREDECESSOR_BOOTSTRAP_SUCCESSOR_VERSION,
      rcTagPattern: STABLE_PREDECESSOR_BOOTSTRAP_SUCCESSOR_RC_PATTERN,
      requiresGreatestLowerStable: true,
      requiresControllerAncestry: true,
      forbidsPublishedStableVersion: true,
    },
    controller: {
      repository: input.repository,
      defaultBranch: input.defaultBranch,
      sourceRevision: input.controllerSourceRevision,
      workflow: `${input.repository}/${STABLE_PREDECESSOR_BOOTSTRAP_WORKFLOW}`,
      workflowSha256: sourceBindings.controllerWorkflowSha256,
    },
    provenance: {
      imageAttestationHash: signedArtifactSha256(image),
      recoveredRailwayObservationHash: recoveredHash,
      independentEvidenceHash: independent.independentEvidenceHash,
      fixtureRegistryHash,
    },
    independentEvidence: compressedIndependent,
    productionObservation: {
      sourceRevision: STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_REVISION,
      kind:
        "authenticated_platform_observation_not_supply_chain_attestation",
      recoveredRailwayObservationHash: recoveredHash,
      semanticBaselineScope:
        "reconstruction_wrapper_only_not_historical_production_equivalence",
      wrapperFixtureEvidenceHash: independent.wrapperFixtureEvidenceHash,
    },
    fixtures: independent.fixtures,
    fixtureRegistryHash,
    gates: independent.gates,
    limitations: [...STABLE_PREDECESSOR_BOOTSTRAP_LIMITATIONS],
  }, input.repository, input.defaultBranch);
  return createStrictSignedEnvelope({
    envelopeSchemaVersion:
      SIGNED_STABLE_PREDECESSOR_BOOTSTRAP_EVIDENCE_SCHEMA_V1,
    payload,
    signingKey: privateKey(input.signingKey),
    keyId: input.keyId,
  });
}

function verifiedEvidence(input: {
  value: unknown;
  verificationKey: string | Buffer | KeyObject;
  approvedKeyId: string;
  approvedKeySha256: string;
  expectedRepository?: string;
  expectedDefaultBranch?: string;
}): ReturnType<typeof verifyStrictSignedEnvelope> {
  if (
    !KEY_ID.test(input.approvedKeyId)
    || stablePredecessorBootstrapKeyFingerprint(input.verificationKey)
      !== sha256Digest(
        input.approvedKeySha256,
        "approved bootstrap evidence key fingerprint",
      )
  ) {
    throw new Error("bootstrap evidence does not use its protected key");
  }
  const result = verifyStrictSignedEnvelope({
    value: input.value,
    verificationKey: publicKey(input.verificationKey),
    envelopeSchemaVersion:
      SIGNED_STABLE_PREDECESSOR_BOOTSTRAP_EVIDENCE_SCHEMA_V1,
    payloadLabel: "stable predecessor bootstrap evidence",
    validatePayload: (value) => validateEvidencePayload(
      value,
      input.expectedRepository,
      input.expectedDefaultBranch,
    ),
  });
  if (result.keyId !== input.approvedKeyId) {
    throw new Error("bootstrap evidence key ID is not protected");
  }
  return result;
}

export function authorizeStablePredecessorBootstrap(input: {
  bootstrapEvidence: unknown;
  protectedBaselineMetadata: unknown;
  imageAttestation: unknown;
  sourceBytes: StablePredecessorBootstrapSourceBytesV1;
  releaseVerificationKey: string | Buffer | KeyObject;
  approvedReleaseKeyId: string;
  approvedReleaseKeySha256: string;
  approvedProducerKeyId: string;
  approvedProducerKeySha256: string;
  approvedSitesControlPlaneVerificationKey: unknown;
  approvedSitesControlPlaneTrustPolicy: unknown;
  originalRailwayProvenance: unknown;
  originalRailwayProvenanceVerificationKey:
    string | Buffer | KeyObject;
  approvedOriginalRailwayProvenanceKeyId: string;
  approvedOriginalRailwayProvenanceKeySha256: string;
  authorizerSigningKey: string | Buffer | KeyObject;
  approvedAuthorizerKeyId: string;
  approvedAuthorizerKeySha256: string;
  expectedRepository: string;
  expectedDefaultBranch: string;
  generatedAt?: string;
}): ReturnType<typeof createStrictSignedEnvelope> {
  const evidence = verifiedEvidence({
    value: input.bootstrapEvidence,
    verificationKey: input.releaseVerificationKey,
    approvedKeyId: input.approvedReleaseKeyId,
    approvedKeySha256: input.approvedReleaseKeySha256,
    expectedRepository: input.expectedRepository,
    expectedDefaultBranch: input.expectedDefaultBranch,
  });
  assertStablePredecessorBootstrapSourceBindings(
    evidence.payload,
    input.sourceBytes,
  );
  const authorizerFingerprint =
    stablePredecessorBootstrapKeyFingerprint(input.authorizerSigningKey);
  if (
    !KEY_ID.test(input.approvedAuthorizerKeyId)
    || authorizerFingerprint !== sha256Digest(
      input.approvedAuthorizerKeySha256,
      "approved bootstrap authorizer key fingerprint",
    )
    || authorizerFingerprint === input.approvedReleaseKeySha256
  ) {
    throw new Error("bootstrap authorizer must use its distinct protected key");
  }
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  if (
    Date.parse(generatedAt) < Date.parse(String(evidence.payload.generatedAt))
    || Date.parse(generatedAt) >= Date.parse(String(evidence.payload.expiresAt))
  ) {
    throw new Error("bootstrap authorization is outside the evidence window");
  }
  const metadata = validateSemanticRankingProtectedBaselineMetadataV1(
    input.protectedBaselineMetadata,
  );
  const candidate = fixedCandidate(
    evidence.payload.candidate,
    "bootstrap evidence candidate",
  );
  const independent =
    validateCompressedStablePredecessorBootstrapIndependentEvidence(
      evidence.payload.independentEvidence,
      candidate,
    );
  const protectedSites = verifyProtectedBootstrapSitesAuthority({
    independentEvidence: independent,
    verificationKey: input.approvedSitesControlPlaneVerificationKey,
    trustPolicy: input.approvedSitesControlPlaneTrustPolicy,
  });
  const image = validateStablePredecessorBootstrapImageAttestationV1(
    input.imageAttestation,
    input.expectedRepository,
    input.expectedDefaultBranch,
  );
  const originalRailway = verifyStablePredecessorOriginalRailwayProvenanceV1({
    value: input.originalRailwayProvenance,
    verificationKey: input.originalRailwayProvenanceVerificationKey,
    approvedKeyId: input.approvedOriginalRailwayProvenanceKeyId,
    approvedKeySha256: input.approvedOriginalRailwayProvenanceKeySha256,
    recoveredRailwayObservation: image.recoveredRailwayObservation,
    expectedRepository: input.expectedRepository,
    now: generatedAt,
  });
  if (
    !KEY_ID.test(input.approvedProducerKeyId)
    || independent.producerKeyId !== input.approvedProducerKeyId
    || independent.producerKeySha256 !== sha256Digest(
      input.approvedProducerKeySha256,
      "approved bootstrap independent producer key fingerprint",
    )
    || new Set([
      input.approvedReleaseKeySha256,
      authorizerFingerprint,
      independent.producerKeySha256,
      independent.sitesKeySha256,
      input.approvedOriginalRailwayProvenanceKeySha256,
    ]).size !== 5
    || protectedSites.approvedKeyId
      !== validateSitesControlPlaneTrustPolicyV1(
        input.approvedSitesControlPlaneTrustPolicy,
      ).approvedKeyId
    || originalRailway.keyId
      !== input.approvedOriginalRailwayProvenanceKeyId
  ) {
    throw new Error(
      "bootstrap release, producer, Sites, Railway provenance, and authorizer keys must be distinct protected authorities",
    );
  }
  const provenance = exactObject(
    evidence.payload.provenance,
    [
      "imageAttestationHash",
      "recoveredRailwayObservationHash",
      "independentEvidenceHash",
      "fixtureRegistryHash",
    ],
    "bootstrap evidence provenance",
  );
  const finalBrowser = gates(
    evidence.payload.gates,
    "bootstrap evidence gates",
  ).find(({ name }) => name === "final_custom_domain_browser")!;
  const evidenceFixtures = fixtures(
    evidence.payload.fixtures,
    "bootstrap evidence fixtures",
  );
  const metadataFixtures = fixtures(
    metadata.fixtures,
    "bootstrap metadata fixtures",
  );
  if (
    metadata.rcTag !== STABLE_PREDECESSOR_BOOTSTRAP_COMPATIBILITY_RC_TAG
    || metadata.stableTag !== STABLE_PREDECESSOR_BOOTSTRAP_TAG
    || metadata.version !== STABLE_PREDECESSOR_BOOTSTRAP_VERSION
    || metadata.sourceRevision
      !== STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_REVISION
    || metadata.imageDigest !== candidate.imageDigest
    || metadata.imageReference !== candidate.imageReference
    || metadata.finalizationEvidencePayloadHash !== evidence.payloadHash
    || metadata.finalBrowserGateEvidenceHash !== finalBrowser.evidenceHash
    || signedArtifactSha256(image) !== provenance.imageAttestationHash
    || stableSignedArtifactJson(metadataFixtures)
      !== stableSignedArtifactJson(evidenceFixtures)
    || stablePredecessorBootstrapFixtureRegistryHash(evidenceFixtures)
      !== evidence.payload.fixtureRegistryHash
  ) {
    throw new Error("bootstrap metadata does not bind the signed evidence");
  }
  const payload = validateAuthorizationPayload({
    schemaVersion: STABLE_PREDECESSOR_BOOTSTRAP_AUTHORIZATION_SCHEMA_V1,
    issuer: "genio-protected-stable-predecessor-bootstrap-authorizer",
    generatedAt,
    expiresAt: new Date(Math.min(
      Date.parse(String(evidence.payload.expiresAt)),
      Date.parse(protectedSites.attestationExpiresAt),
      Date.parse(String(originalRailway.payload.expiresAt)),
      Date.parse(generatedAt) + STABLE_PREDECESSOR_BOOTSTRAP_TTL_MS,
    )).toISOString(),
    action: "publish_immutable_v2_3_4_predecessor_bootstrap",
    candidate: evidence.payload.candidate,
    anchor: evidence.payload.anchor,
    successorPolicy: evidence.payload.successorPolicy,
    controller: evidence.payload.controller,
    bootstrapEvidencePayloadHash: evidence.payloadHash,
    protectedBaselineMetadataHash:
      semanticRankingProtectedBaselineMetadataSha256(metadata),
    imageAttestationHash: provenance.imageAttestationHash,
    recoveredRailwayObservationHash:
      provenance.recoveredRailwayObservationHash,
    independentEvidenceHash: independent.independentEvidenceHash,
    fixtureRegistryHash: evidence.payload.fixtureRegistryHash,
    finalBrowserGateEvidenceHash: finalBrowser.evidenceHash,
    producerKeyId: independent.producerKeyId,
    producerKeySha256: independent.producerKeySha256,
    sitesKeyId: protectedSites.approvedKeyId,
    sitesKeySha256: independent.sitesKeySha256,
    originalRailwayProvenancePayloadHash: originalRailway.payloadHash,
    originalRailwayProvenanceArtifactHash:
      signedArtifactSha256(input.originalRailwayProvenance),
    originalRailwayProvenanceKeyId: originalRailway.keyId,
    originalRailwayProvenanceKeySha256:
      input.approvedOriginalRailwayProvenanceKeySha256,
    originalRailwayImageDigest:
      originalRailway.payload.originalImageDigest,
  }, input.expectedRepository, input.expectedDefaultBranch);
  return createStrictSignedEnvelope({
    envelopeSchemaVersion:
      SIGNED_STABLE_PREDECESSOR_BOOTSTRAP_AUTHORIZATION_SCHEMA_V1,
    payload,
    signingKey: privateKey(input.authorizerSigningKey),
    keyId: input.approvedAuthorizerKeyId,
  });
}

function verifyAuthorization(input: {
  value: unknown;
  verificationKey: string | Buffer | KeyObject;
  approvedKeyId: string;
  approvedKeySha256: string;
  expectedRepository?: string;
  expectedDefaultBranch?: string;
}): ReturnType<typeof verifyStrictSignedEnvelope> {
  if (
    !KEY_ID.test(input.approvedKeyId)
    || stablePredecessorBootstrapKeyFingerprint(input.verificationKey)
      !== sha256Digest(
        input.approvedKeySha256,
        "approved bootstrap authorizer key fingerprint",
      )
  ) {
    throw new Error("bootstrap authorization does not use its protected key");
  }
  const result = verifyStrictSignedEnvelope({
    value: input.value,
    verificationKey: publicKey(input.verificationKey),
    envelopeSchemaVersion:
      SIGNED_STABLE_PREDECESSOR_BOOTSTRAP_AUTHORIZATION_SCHEMA_V1,
    payloadLabel: "stable predecessor bootstrap authorization",
    validatePayload: (value) => validateAuthorizationPayload(
      value,
      input.expectedRepository,
      input.expectedDefaultBranch,
    ),
  });
  if (result.keyId !== input.approvedKeyId) {
    throw new Error("bootstrap authorization key ID is not protected");
  }
  return result;
}

export function verifyHistoricalStablePredecessorBootstrapLineage(input: {
  bootstrapEvidence: unknown;
  protectedBaselineMetadata: unknown;
  releaseVerificationKey: string | Buffer | KeyObject;
  approvedReleaseKeySha256: string;
  stableAuthorization: unknown;
  stableAuthorizationVerificationKey: string | Buffer | KeyObject;
  approvedStableAuthorizerKeyId: string;
  approvedStableAuthorizerKeySha256: string;
  expectedRcTag: string;
  expectedVersion: string;
  expectedRevision: string;
  expectedImageDigest: string;
  expectedImageReference: string;
  expectedRepository?: string;
  expectedDefaultBranch?: string;
  now?: string;
}): StableReleaseConsumerManifestV1 & {
  bootstrap: {
    tagObject: string;
    sourceTree: string;
    controllerSourceRevision: string;
    controllerRepository: string;
    controllerDefaultBranch: string;
  };
} {
  const evidenceEnvelope = exactObject(input.bootstrapEvidence, [
    "schemaVersion",
    "payload",
    "payloadHash",
    "signature",
  ], "signed stable predecessor bootstrap evidence");
  const evidenceSignature = exactObject(evidenceEnvelope.signature, [
    "algorithm",
    "keyId",
    "value",
  ], "signed stable predecessor bootstrap evidence.signature");
  const evidence = verifiedEvidence({
    value: input.bootstrapEvidence,
    verificationKey: input.releaseVerificationKey,
    approvedKeyId: String(evidenceSignature.keyId ?? ""),
    approvedKeySha256: input.approvedReleaseKeySha256,
    expectedRepository: input.expectedRepository,
    expectedDefaultBranch: input.expectedDefaultBranch,
  });
  const authorization = verifyAuthorization({
    value: input.stableAuthorization,
    verificationKey: input.stableAuthorizationVerificationKey,
    approvedKeyId: input.approvedStableAuthorizerKeyId,
    approvedKeySha256: input.approvedStableAuthorizerKeySha256,
    expectedRepository: input.expectedRepository,
    expectedDefaultBranch: input.expectedDefaultBranch,
  });
  if (
    input.approvedReleaseKeySha256 === input.approvedStableAuthorizerKeySha256
  ) {
    throw new Error("bootstrap evidence and authorizer keys must be distinct");
  }
  const issuedAt = timestamp(
    authorization.payload.generatedAt,
    "historical bootstrap authorization generatedAt",
  );
  const currentTime = input.now
    ? timestamp(input.now, "historical bootstrap verification time")
    : new Date().toISOString();
  if (
    Date.parse(currentTime) < Date.parse(issuedAt)
    || Date.parse(issuedAt) < Date.parse(String(evidence.payload.generatedAt))
    || Date.parse(issuedAt) >= Date.parse(String(evidence.payload.expiresAt))
    || Date.parse(issuedAt)
      >= Date.parse(String(authorization.payload.expiresAt))
  ) {
    throw new Error("historical bootstrap lineage time window is invalid");
  }
  const metadata = validateSemanticRankingProtectedBaselineMetadataV1(
    input.protectedBaselineMetadata,
  );
  const metadataHash =
    semanticRankingProtectedBaselineMetadataSha256(metadata);
  const candidate = fixedCandidate(
    evidence.payload.candidate,
    "bootstrap evidence candidate",
  );
  const independent =
    validateCompressedStablePredecessorBootstrapIndependentEvidence(
      evidence.payload.independentEvidence,
      candidate,
    );
  const anchor = fixedAnchor(
    evidence.payload.anchor,
    "bootstrap evidence anchor",
  );
  const controllerValue = controller(
    evidence.payload.controller,
    "bootstrap evidence controller",
    input.expectedRepository,
    input.expectedDefaultBranch,
  );
  const finalBrowser = gates(
    evidence.payload.gates,
    "bootstrap evidence gates",
  ).find(({ name }) => name === "final_custom_domain_browser")!;
  const evidenceProvenance = exactObject(evidence.payload.provenance, [
    "imageAttestationHash",
    "recoveredRailwayObservationHash",
    "independentEvidenceHash",
    "fixtureRegistryHash",
  ], "bootstrap evidence provenance");
  if (
    input.expectedRcTag !== STABLE_PREDECESSOR_BOOTSTRAP_COMPATIBILITY_RC_TAG
    || input.expectedVersion !== STABLE_PREDECESSOR_BOOTSTRAP_VERSION
    || input.expectedRevision !== STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_REVISION
    || input.expectedImageDigest !== candidate.imageDigest
    || input.expectedImageReference !== candidate.imageReference
    || metadata.rcTag !== input.expectedRcTag
    || metadata.stableTag !== STABLE_PREDECESSOR_BOOTSTRAP_TAG
    || metadata.version !== input.expectedVersion
    || metadata.sourceRevision !== input.expectedRevision
    || metadata.imageDigest !== input.expectedImageDigest
    || metadata.imageReference !== input.expectedImageReference
    || metadata.finalizationEvidencePayloadHash !== evidence.payloadHash
    || metadata.finalBrowserGateEvidenceHash !== finalBrowser.evidenceHash
    || authorization.payload.bootstrapEvidencePayloadHash
      !== evidence.payloadHash
    || authorization.payload.protectedBaselineMetadataHash !== metadataHash
    || authorization.payload.imageAttestationHash
      !== evidenceProvenance.imageAttestationHash
    || authorization.payload.recoveredRailwayObservationHash
      !== evidenceProvenance.recoveredRailwayObservationHash
    || authorization.payload.independentEvidenceHash
      !== independent.independentEvidenceHash
    || authorization.payload.fixtureRegistryHash
      !== evidence.payload.fixtureRegistryHash
    || authorization.payload.finalBrowserGateEvidenceHash
      !== finalBrowser.evidenceHash
    || stableSignedArtifactJson(
      fixtures(metadata.fixtures, "bootstrap metadata fixtures"),
    ) !== stableSignedArtifactJson(
      fixtures(evidence.payload.fixtures, "bootstrap evidence fixtures"),
    )
    || stablePredecessorBootstrapFixtureRegistryHash(
      evidence.payload.fixtures,
    ) !== evidence.payload.fixtureRegistryHash
    || stableSignedArtifactJson(authorization.payload.candidate)
      !== stableSignedArtifactJson(evidence.payload.candidate)
    || stableSignedArtifactJson(authorization.payload.anchor)
      !== stableSignedArtifactJson(evidence.payload.anchor)
    || stableSignedArtifactJson(authorization.payload.successorPolicy)
      !== stableSignedArtifactJson(evidence.payload.successorPolicy)
    || stableSignedArtifactJson(authorization.payload.controller)
      !== stableSignedArtifactJson(evidence.payload.controller)
    || authorization.payload.producerKeyId !== independent.producerKeyId
    || authorization.payload.producerKeySha256
      !== independent.producerKeySha256
    || authorization.payload.sitesKeyId !== independent.sitesKeyId
    || authorization.payload.sitesKeySha256 !== independent.sitesKeySha256
    || evidenceProvenance.independentEvidenceHash
      !== independent.independentEvidenceHash
    || new Set([
      input.approvedReleaseKeySha256,
      input.approvedStableAuthorizerKeySha256,
      independent.producerKeySha256,
      independent.sitesKeySha256,
      authorization.payload.originalRailwayProvenanceKeySha256,
    ]).size !== 5
  ) {
    throw new Error("historical bootstrap lineage bindings differ");
  }
  return {
    schemaVersion: "genio-stable-release-consumer-manifest/v2",
    verifiedAt: issuedAt,
    candidate: {
      rcTag: metadata.rcTag,
      stableTag: metadata.stableTag,
      version: metadata.version,
      sourceRevision: metadata.sourceRevision,
      imageDigest: metadata.imageDigest,
      imageReference: metadata.imageReference,
    },
    finalizationEvidencePayloadHash: evidence.payloadHash,
    finalBrowserGateEvidenceHash: String(finalBrowser.evidenceHash),
    protectedBaselineMetadataHash: metadataHash,
    stableAuthorizationPayloadHash: authorization.payloadHash,
    releaseVerificationKeySha256:
      stablePredecessorBootstrapKeyFingerprint(input.releaseVerificationKey),
    stableAuthorizerKeyId: input.approvedStableAuthorizerKeyId,
    stableAuthorizerKeySha256:
      stablePredecessorBootstrapKeyFingerprint(
        input.stableAuthorizationVerificationKey,
      ),
    bootstrap: {
      tagObject: String(anchor.tagObject),
      sourceTree: STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_TREE,
      controllerSourceRevision: String(controllerValue.sourceRevision),
      controllerRepository: String(controllerValue.repository),
      controllerDefaultBranch: String(controllerValue.defaultBranch),
    },
  };
}

export function verifyStablePredecessorBootstrapAssetBundle(input: {
  bootstrapEvidence: unknown;
  protectedBaselineMetadata: unknown;
  releaseVerificationKey: string | Buffer | KeyObject;
  approvedReleaseKeySha256: string;
  stableAuthorization: unknown;
  stableAuthorizationVerificationKey: string | Buffer | KeyObject;
  approvedStableAuthorizerKeyId: string;
  approvedStableAuthorizerKeySha256: string;
  imageAttestation: unknown;
  storedConsumer: unknown;
  expectedRepository: string;
  expectedDefaultBranch: string;
  now?: string;
}): ReturnType<typeof verifyHistoricalStablePredecessorBootstrapLineage> {
  const lineage = verifyHistoricalStablePredecessorBootstrapLineage({
    bootstrapEvidence: input.bootstrapEvidence,
    protectedBaselineMetadata: input.protectedBaselineMetadata,
    releaseVerificationKey: input.releaseVerificationKey,
    approvedReleaseKeySha256: input.approvedReleaseKeySha256,
    stableAuthorization: input.stableAuthorization,
    stableAuthorizationVerificationKey:
      input.stableAuthorizationVerificationKey,
    approvedStableAuthorizerKeyId: input.approvedStableAuthorizerKeyId,
    approvedStableAuthorizerKeySha256:
      input.approvedStableAuthorizerKeySha256,
    expectedRcTag: STABLE_PREDECESSOR_BOOTSTRAP_COMPATIBILITY_RC_TAG,
    expectedVersion: STABLE_PREDECESSOR_BOOTSTRAP_VERSION,
    expectedRevision: STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_REVISION,
    expectedImageDigest:
      validateSemanticRankingProtectedBaselineMetadataV1(
        input.protectedBaselineMetadata,
      ).imageDigest,
    expectedImageReference:
      validateSemanticRankingProtectedBaselineMetadataV1(
        input.protectedBaselineMetadata,
      ).imageReference,
    expectedRepository: input.expectedRepository,
    expectedDefaultBranch: input.expectedDefaultBranch,
    now: input.now,
  });
  const image = validateStablePredecessorBootstrapImageAttestationV1(
    input.imageAttestation,
    input.expectedRepository,
    input.expectedDefaultBranch,
  );
  const evidence = exactObject(
    exactObject(input.bootstrapEvidence, [
      "schemaVersion",
      "payload",
      "payloadHash",
      "signature",
    ], "signed stable predecessor bootstrap evidence").payload,
    [
      "schemaVersion",
      "issuer",
      "generatedAt",
      "expiresAt",
      "kind",
      "mode",
      "candidate",
      "anchor",
      "successorPolicy",
      "controller",
      "provenance",
      "independentEvidence",
      "productionObservation",
      "fixtures",
      "fixtureRegistryHash",
      "gates",
      "limitations",
    ],
    "stable predecessor bootstrap evidence",
  );
  const provenance = exactObject(evidence.provenance, [
    "imageAttestationHash",
    "recoveredRailwayObservationHash",
    "independentEvidenceHash",
    "fixtureRegistryHash",
  ], "bootstrap evidence provenance");
  if (
    signedArtifactSha256(image) !== provenance.imageAttestationHash
    || image.recoveredRailwayObservationHash
      !== provenance.recoveredRailwayObservationHash
    || image.subjectImageReference !== lineage.candidate.imageReference
    || image.workflowSourceRevision
      !== lineage.bootstrap.controllerSourceRevision
  ) {
    throw new Error("bootstrap image provenance does not match signed lineage");
  }
  const stored = exactObject(input.storedConsumer, [
    "schemaVersion",
    "verifiedAt",
    "candidate",
    "finalizationEvidencePayloadHash",
    "finalBrowserGateEvidenceHash",
    "protectedBaselineMetadataHash",
    "stableAuthorizationPayloadHash",
    "releaseVerificationKeySha256",
    "stableAuthorizerKeyId",
    "stableAuthorizerKeySha256",
  ], "stored bootstrap consumer");
  const canonicalLineage = { ...lineage } as JsonRecord;
  delete canonicalLineage.bootstrap;
  if (
    stableSignedArtifactJson(stored)
      !== stableSignedArtifactJson(canonicalLineage)
  ) {
    throw new Error("stored bootstrap consumer is not the rederived lineage");
  }
  return lineage;
}

export function verifyStablePredecessorBootstrapBundle(input: {
  bootstrapEvidence: unknown;
  protectedBaselineMetadata: unknown;
  releaseVerificationKey: string | Buffer | KeyObject;
  approvedReleaseKeySha256: string;
  stableAuthorization: unknown;
  stableAuthorizationVerificationKey: string | Buffer | KeyObject;
  approvedStableAuthorizerKeyId: string;
  approvedStableAuthorizerKeySha256: string;
  imageAttestation: unknown;
  storedConsumer: unknown;
  expectedSuccessorRcTag: string;
  expectedSuccessorSourceRevision: string;
  expectedRepository: string;
  expectedDefaultBranch: string;
  now?: string;
}): ReturnType<typeof verifyHistoricalStablePredecessorBootstrapLineage> {
  validateStablePredecessorBootstrapSuccessor({
    rcTag: input.expectedSuccessorRcTag,
    sourceRevision: input.expectedSuccessorSourceRevision,
  });
  return verifyStablePredecessorBootstrapAssetBundle(input);
}

export function validateStablePredecessorBootstrapPublicationWindow(input: {
  bootstrapEvidence: unknown;
  stableAuthorization: unknown;
  now?: string;
}): void {
  const evidenceEnvelope = exactObject(input.bootstrapEvidence, [
    "schemaVersion",
    "payload",
    "payloadHash",
    "signature",
  ], "signed stable predecessor bootstrap evidence");
  const authorizationEnvelope = exactObject(input.stableAuthorization, [
    "schemaVersion",
    "payload",
    "payloadHash",
    "signature",
  ], "signed stable predecessor bootstrap authorization");
  const evidence = validateEvidencePayload(evidenceEnvelope.payload);
  const authorization = validateAuthorizationPayload(
    authorizationEnvelope.payload,
  );
  const now = input.now
    ? timestamp(input.now, "bootstrap publication time")
    : new Date().toISOString();
  const nowMs = Date.parse(now);
  if (
    nowMs < Date.parse(String(evidence.generatedAt))
    || nowMs >= Date.parse(String(evidence.expiresAt))
    || nowMs < Date.parse(String(authorization.generatedAt))
    || nowMs >= Date.parse(String(authorization.expiresAt))
  ) {
    throw new Error(
      "bootstrap evidence or authorization is outside the publication window",
    );
  }
}

const CAPTURE_CONFIRMATION =
  "--confirm-authenticated-observation-not-attestation";
const BOOTSTRAP_CONFIRMATION =
  "--confirm-v2-3-4-stable-predecessor-bootstrap";

function exactCliOptions(
  args: readonly string[],
  confirmation: string,
  valueOptions: readonly string[],
): Record<string, string> {
  const allowed = new Set([confirmation, ...valueOptions]);
  const seen = new Set<string>();
  const parsed: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!allowed.has(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    if (seen.has(argument)) throw new Error(`Duplicate argument: ${argument}`);
    seen.add(argument);
    if (argument === confirmation) continue;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    parsed[argument] = value;
    index += 1;
  }
  if (!seen.has(confirmation)) {
    throw new Error(`bootstrap command requires ${confirmation}`);
  }
  for (const option of valueOptions) {
    if (!seen.has(option)) throw new Error(`${option} must be supplied once`);
  }
  return parsed;
}

export function parseStablePredecessorBootstrapCliArgs(
  argv: readonly string[],
): {
  command: "capture-railway-observation" | "produce" | "verify";
  options: Record<string, string>;
} {
  const [command, ...args] = argv;
  if (command === "capture-railway-observation") {
    return {
      command,
      options: exactCliOptions(args, CAPTURE_CONFIRMATION, [
        "--api-deployment",
        "--api-build-log",
        "--worker-deployment",
        "--worker-build-log",
        "--deep-deployment",
        "--deep-build-log",
        "--output",
      ]),
    };
  }
  if (command === "produce") {
    return {
      command,
      options: exactCliOptions(args, BOOTSTRAP_CONFIRMATION, [
        "--bootstrap-evidence",
        "--protected-baseline-metadata",
        "--bootstrap-authorization",
        "--release-verification-key",
        "--stable-authorization-verification-key",
        "--recovered-production-provenance",
        "--original-railway-provenance",
        "--original-railway-provenance-verification-key",
        "--sites-control-plane-verification-key",
        "--sites-control-plane-trust-policy",
        "--github-attestation-verification",
        "--controller-workflow-bytes",
        "--tag-object-bytes",
        "--source-commit-bytes",
        "--source-tree-object-bytes",
        "--expected-image-digest",
        "--bootstrap-controller-revision",
        "--expected-repository",
        "--expected-default-branch",
        "--output-image-attestation",
        "--output-consumer",
      ]),
    };
  }
  if (command === "verify") {
    return {
      command,
      options: exactCliOptions(args, BOOTSTRAP_CONFIRMATION, [
        "--assets-directory",
        "--release-verification-key",
        "--stable-authorization-verification-key",
        "--original-railway-provenance",
        "--original-railway-provenance-verification-key",
        "--sites-control-plane-verification-key",
        "--sites-control-plane-trust-policy",
        "--github-attestation-verification",
        "--controller-workflow-bytes",
        "--tag-object-bytes",
        "--source-commit-bytes",
        "--source-tree-object-bytes",
        "--expected-image-digest",
        "--bootstrap-controller-revision",
        "--expected-repository",
        "--expected-default-branch",
        "--output",
      ]),
    };
  }
  throw new Error(
    "Usage: stable-predecessor-bootstrap <capture-railway-observation|produce|verify> ...",
  );
}

async function boundedJson(path: string, label: string): Promise<unknown> {
  const bytes = await readFile(path);
  if (bytes.length === 0 || bytes.length > 2 * 1024 * 1024) {
    throw new Error(`${label} is empty or oversized`);
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function bootstrapProtectedAuthority(): {
  releaseKeyId: string;
  releaseKeySha256: string;
  authorizerKeyId: string;
  authorizerKeySha256: string;
  producerKeyId: string;
  producerKeySha256: string;
  sitesKeyId: string;
  sitesKeySha256: string;
  originalRailwayKeyId: string;
  originalRailwayKeySha256: string;
} {
  const authority = {
    releaseKeyId:
      process.env.RELEASE_VERIFICATION_KEY_ID?.trim() ?? "",
    releaseKeySha256:
      process.env.RELEASE_VERIFICATION_KEY_SHA256?.trim().toLowerCase() ?? "",
    authorizerKeyId:
      process.env.RELEASE_STABLE_AUTHORIZER_KEY_ID?.trim() ?? "",
    authorizerKeySha256:
      process.env.RELEASE_STABLE_AUTHORIZER_KEY_SHA256
        ?.trim()
        .toLowerCase() ?? "",
    producerKeyId:
      process.env.RELEASE_GATE_PRODUCER_KEY_ID?.trim() ?? "",
    producerKeySha256:
      process.env.RELEASE_GATE_PRODUCER_KEY_SHA256
        ?.trim()
        .toLowerCase() ?? "",
    sitesKeyId:
      process.env.RELEASE_SITES_CONTROL_PLANE_KEY_ID?.trim() ?? "",
    sitesKeySha256:
      process.env.RELEASE_SITES_CONTROL_PLANE_KEY_SHA256
        ?.trim()
        .toLowerCase() ?? "",
    originalRailwayKeyId:
      process.env.RELEASE_ORIGINAL_RAILWAY_PROVENANCE_KEY_ID?.trim() ?? "",
    originalRailwayKeySha256:
      process.env.RELEASE_ORIGINAL_RAILWAY_PROVENANCE_KEY_SHA256
        ?.trim()
        .toLowerCase() ?? "",
  };
  if (
    !KEY_ID.test(authority.releaseKeyId)
    || !KEY_ID.test(authority.authorizerKeyId)
    || !KEY_ID.test(authority.producerKeyId)
    || !KEY_ID.test(authority.sitesKeyId)
    || !KEY_ID.test(authority.originalRailwayKeyId)
    || !/^[0-9a-f]{64}$/u.test(authority.releaseKeySha256)
    || !/^[0-9a-f]{64}$/u.test(authority.authorizerKeySha256)
    || !/^[0-9a-f]{64}$/u.test(authority.producerKeySha256)
    || !/^[0-9a-f]{64}$/u.test(authority.sitesKeySha256)
    || !/^[0-9a-f]{64}$/u.test(authority.originalRailwayKeySha256)
    || new Set([
      authority.releaseKeySha256,
      authority.authorizerKeySha256,
      authority.producerKeySha256,
      authority.sitesKeySha256,
      authority.originalRailwayKeySha256,
    ]).size !== 5
  ) {
    throw new Error(
      "bootstrap protected verification authority is missing or not distinct",
    );
  }
  return authority;
}

function expectedImageReference(repository: string, digest: string): string {
  imageDigest(digest, "expected bootstrap image digest");
  const match = /^([^/\s]+)\/([^/\s]+)$/u.exec(repository);
  if (!match || repository !== "hooterjackson/genio") {
    throw new Error("bootstrap repository is not the protected repository");
  }
  return `ghcr.io/${match[1]!.toLowerCase()}/genio@${digest}`;
}

function releaseEvidenceKeyId(value: unknown): string {
  const envelope = exactObject(value, [
    "schemaVersion",
    "payload",
    "payloadHash",
    "signature",
  ], "signed stable predecessor bootstrap evidence");
  const signature = exactObject(envelope.signature, [
    "algorithm",
    "keyId",
    "value",
  ], "signed stable predecessor bootstrap evidence.signature");
  return typeof signature.keyId === "string" ? signature.keyId : "";
}

function bootstrapEvidencePayload(value: unknown): JsonRecord {
  const envelope = exactObject(value, [
    "schemaVersion",
    "payload",
    "payloadHash",
    "signature",
  ], "signed stable predecessor bootstrap evidence");
  return exactObject(
    envelope.payload,
    [
      "schemaVersion",
      "issuer",
      "generatedAt",
      "expiresAt",
      "kind",
      "mode",
      "candidate",
      "anchor",
      "successorPolicy",
      "controller",
      "provenance",
      "independentEvidence",
      "productionObservation",
      "fixtures",
      "fixtureRegistryHash",
      "gates",
      "limitations",
    ],
    "stable predecessor bootstrap evidence",
  );
}

function assertProtectedBootstrapExternalAuthorities(input: {
  bootstrapEvidence: unknown;
  stableAuthorization: unknown;
  recoveredRailwayObservation: unknown;
  originalRailwayProvenance: unknown;
  originalRailwayProvenanceVerificationKey:
    string | Buffer | KeyObject;
  sitesControlPlaneVerificationKey: unknown;
  sitesControlPlaneTrustPolicy: unknown;
  authority: ReturnType<typeof bootstrapProtectedAuthority>;
  repository: string;
  now?: string;
}): void {
  const evidencePayload = validateEvidencePayload(
    bootstrapEvidencePayload(input.bootstrapEvidence),
    input.repository,
  );
  const independent =
    validateCompressedStablePredecessorBootstrapIndependentEvidence(
      evidencePayload.independentEvidence,
      evidencePayload.candidate,
    );
  const sites = verifyProtectedBootstrapSitesAuthority({
    independentEvidence: independent,
    verificationKey: input.sitesControlPlaneVerificationKey,
    trustPolicy: input.sitesControlPlaneTrustPolicy,
  });
  const originalRailway = verifyStablePredecessorOriginalRailwayProvenanceV1({
    value: input.originalRailwayProvenance,
    verificationKey: input.originalRailwayProvenanceVerificationKey,
    approvedKeyId: input.authority.originalRailwayKeyId,
    approvedKeySha256: input.authority.originalRailwayKeySha256,
    recoveredRailwayObservation: input.recoveredRailwayObservation,
    expectedRepository: input.repository,
    now: input.now,
  });
  const authorizationEnvelope = exactObject(input.stableAuthorization, [
    "schemaVersion",
    "payload",
    "payloadHash",
    "signature",
  ], "signed stable predecessor bootstrap authorization");
  const authorization = validateAuthorizationPayload(
    authorizationEnvelope.payload,
    input.repository,
  );
  if (
    sites.approvedKeyId !== input.authority.sitesKeyId
    || sites.approvedKeySha256 !== input.authority.sitesKeySha256
    || authorization.sitesKeyId !== sites.approvedKeyId
    || authorization.sitesKeySha256 !== sites.approvedKeySha256
    || authorization.originalRailwayProvenancePayloadHash
      !== originalRailway.payloadHash
    || authorization.originalRailwayProvenanceArtifactHash
      !== signedArtifactSha256(input.originalRailwayProvenance)
    || authorization.originalRailwayProvenanceKeyId
      !== originalRailway.keyId
    || authorization.originalRailwayProvenanceKeySha256
      !== input.authority.originalRailwayKeySha256
    || authorization.originalRailwayImageDigest
      !== originalRailway.payload.originalImageDigest
  ) {
    throw new Error(
      "bootstrap authorization does not bind the externally protected Sites and original Railway provenance",
    );
  }
}

function assertProtectedBootstrapIndependentProducer(input: {
  bootstrapEvidence: unknown;
  producerKeyId: string;
  producerKeySha256: string;
  repository: string;
  defaultBranch: string;
}): void {
  const payload = validateEvidencePayload(
    bootstrapEvidencePayload(input.bootstrapEvidence),
    input.repository,
    input.defaultBranch,
  );
  const candidate = fixedCandidate(
    payload.candidate,
    "bootstrap evidence candidate",
  );
  const independent =
    validateCompressedStablePredecessorBootstrapIndependentEvidence(
      payload.independentEvidence,
      candidate,
    );
  if (
    independent.producerKeyId !== input.producerKeyId
    || independent.producerKeySha256 !== input.producerKeySha256
  ) {
    throw new Error(
      "bootstrap independent evidence producer is not the protected producer",
    );
  }
}

async function bootstrapSourceBytesFromOptions(
  options: Record<string, string>,
): Promise<StablePredecessorBootstrapSourceBytesV1> {
  const [
    controllerWorkflowBytes,
    tagObjectBytes,
    sourceCommitBytes,
    sourceTreeObjectBytes,
  ] = await Promise.all([
    readFile(options["--controller-workflow-bytes"]!),
    readFile(options["--tag-object-bytes"]!),
    readFile(options["--source-commit-bytes"]!),
    readFile(options["--source-tree-object-bytes"]!),
  ]);
  return {
    controllerWorkflowBytes: inputBytes(
      controllerWorkflowBytes,
      "bootstrap controller workflow bytes",
    ),
    tagObjectBytes: inputBytes(
      tagObjectBytes,
      "bootstrap tag object bytes",
    ),
    sourceCommitBytes: inputBytes(
      sourceCommitBytes,
      "bootstrap source commit bytes",
    ),
    sourceTreeObjectBytes: inputBytes(
      sourceTreeObjectBytes,
      "bootstrap source tree object bytes",
      4 * 1024 * 1024,
    ),
  };
}

async function produceBootstrapAssets(
  options: Record<string, string>,
): Promise<void> {
  const authority = bootstrapProtectedAuthority();
  const repository = options["--expected-repository"]!;
  const defaultBranch = options["--expected-default-branch"]!;
  const controllerRevision = revision(
    options["--bootstrap-controller-revision"],
    "bootstrap controller revision",
  );
  const imageReference = expectedImageReference(
    repository,
    options["--expected-image-digest"]!,
  );
  const [
    bootstrapEvidence,
    protectedBaselineMetadata,
    stableAuthorization,
    releaseVerificationKey,
    stableAuthorizationVerificationKey,
    recoveredRailwayObservation,
    originalRailwayProvenance,
    originalRailwayProvenanceVerificationKey,
    sitesControlPlaneVerificationKey,
    sitesControlPlaneTrustPolicy,
    githubAttestationVerification,
    sourceBytes,
  ] = await Promise.all([
    boundedJson(
      options["--bootstrap-evidence"]!,
      "bootstrap evidence",
    ),
    boundedJson(
      options["--protected-baseline-metadata"]!,
      "protected baseline metadata",
    ),
    boundedJson(
      options["--bootstrap-authorization"]!,
      "bootstrap authorization",
    ),
    readFile(options["--release-verification-key"]!),
    readFile(options["--stable-authorization-verification-key"]!),
    boundedJson(
      options["--recovered-production-provenance"]!,
      "recovered production observation",
    ),
    boundedJson(
      options["--original-railway-provenance"]!,
      "original Railway provenance",
    ),
    readFile(options["--original-railway-provenance-verification-key"]!),
    boundedJson(
      options["--sites-control-plane-verification-key"]!,
      "Sites control-plane verification key",
    ),
    boundedJson(
      options["--sites-control-plane-trust-policy"]!,
      "Sites control-plane trust policy",
    ),
    boundedJson(
      options["--github-attestation-verification"]!,
      "GitHub attestation verification",
    ),
    bootstrapSourceBytesFromOptions(options),
  ]);
  if (releaseEvidenceKeyId(bootstrapEvidence) !== authority.releaseKeyId) {
    throw new Error("bootstrap evidence key ID is not protected");
  }
  assertProtectedBootstrapIndependentProducer({
    bootstrapEvidence,
    producerKeyId: authority.producerKeyId,
    producerKeySha256: authority.producerKeySha256,
    repository,
    defaultBranch,
  });
  assertStablePredecessorBootstrapSourceBindings(
    bootstrapEvidencePayload(bootstrapEvidence),
    sourceBytes,
  );
  const imageAttestation =
    createStablePredecessorBootstrapImageAttestationV1({
      repository,
      defaultBranch,
      controllerSourceRevision: controllerRevision,
      imageReference,
      recoveredRailwayObservation,
      githubAttestationVerification,
    });
  assertProtectedBootstrapExternalAuthorities({
    bootstrapEvidence,
    stableAuthorization,
    recoveredRailwayObservation,
    originalRailwayProvenance,
    originalRailwayProvenanceVerificationKey,
    sitesControlPlaneVerificationKey,
    sitesControlPlaneTrustPolicy,
    authority,
    repository,
  });
  const lineage = verifyHistoricalStablePredecessorBootstrapLineage({
    bootstrapEvidence,
    protectedBaselineMetadata,
    releaseVerificationKey,
    approvedReleaseKeySha256: authority.releaseKeySha256,
    stableAuthorization,
    stableAuthorizationVerificationKey,
    approvedStableAuthorizerKeyId: authority.authorizerKeyId,
    approvedStableAuthorizerKeySha256: authority.authorizerKeySha256,
    expectedRcTag: STABLE_PREDECESSOR_BOOTSTRAP_COMPATIBILITY_RC_TAG,
    expectedVersion: STABLE_PREDECESSOR_BOOTSTRAP_VERSION,
    expectedRevision: STABLE_PREDECESSOR_BOOTSTRAP_SOURCE_REVISION,
    expectedImageDigest: options["--expected-image-digest"]!,
    expectedImageReference: imageReference,
    expectedRepository: repository,
    expectedDefaultBranch: defaultBranch,
  });
  const storedConsumer = { ...lineage } as JsonRecord;
  delete storedConsumer.bootstrap;
  verifyStablePredecessorBootstrapAssetBundle({
    bootstrapEvidence,
    protectedBaselineMetadata,
    releaseVerificationKey,
    approvedReleaseKeySha256: authority.releaseKeySha256,
    stableAuthorization,
    stableAuthorizationVerificationKey,
    approvedStableAuthorizerKeyId: authority.authorizerKeyId,
    approvedStableAuthorizerKeySha256: authority.authorizerKeySha256,
    imageAttestation,
    storedConsumer,
    expectedRepository: repository,
    expectedDefaultBranch: defaultBranch,
  });
  validateStablePredecessorBootstrapPublicationWindow({
    bootstrapEvidence,
    stableAuthorization,
  });
  await writeFile(
    options["--output-image-attestation"]!,
    `${JSON.stringify(imageAttestation, null, 2)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  await writeFile(
    options["--output-consumer"]!,
    `${JSON.stringify(storedConsumer, null, 2)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  process.stdout.write(`${JSON.stringify({
    ok: true,
    imageAttestationHash: signedArtifactSha256(imageAttestation),
    consumerHash: signedArtifactSha256(storedConsumer),
  })}\n`);
}

async function verifyBootstrapAssets(
  options: Record<string, string>,
): Promise<void> {
  const authority = bootstrapProtectedAuthority();
  const directory = options["--assets-directory"]!;
  const repository = options["--expected-repository"]!;
  const defaultBranch = options["--expected-default-branch"]!;
  const controllerRevision = revision(
    options["--bootstrap-controller-revision"],
    "bootstrap controller revision",
  );
  const expectedReference = expectedImageReference(
    repository,
    options["--expected-image-digest"]!,
  );
  const [
    bootstrapEvidence,
    protectedBaselineMetadata,
    stableAuthorization,
    imageAttestation,
    storedConsumer,
    releaseVerificationKey,
    stableAuthorizationVerificationKey,
    originalRailwayProvenance,
    originalRailwayProvenanceVerificationKey,
    sitesControlPlaneVerificationKey,
    sitesControlPlaneTrustPolicy,
    githubAttestationVerification,
    sourceBytes,
  ] = await Promise.all([
    boundedJson(
      join(directory, "finalization-evidence.json"),
      "bootstrap evidence",
    ),
    boundedJson(
      join(directory, "protected-semantic-baseline.json"),
      "protected baseline metadata",
    ),
    boundedJson(
      join(directory, "stable-authorization.json"),
      "bootstrap authorization",
    ),
    boundedJson(
      join(directory, "stable-image-attestation.json"),
      "bootstrap image attestation",
    ),
    boundedJson(
      join(directory, "stable-release-consumer.json"),
      "bootstrap consumer",
    ),
    readFile(options["--release-verification-key"]!),
    readFile(options["--stable-authorization-verification-key"]!),
    boundedJson(
      options["--original-railway-provenance"]!,
      "original Railway provenance",
    ),
    readFile(options["--original-railway-provenance-verification-key"]!),
    boundedJson(
      options["--sites-control-plane-verification-key"]!,
      "Sites control-plane verification key",
    ),
    boundedJson(
      options["--sites-control-plane-trust-policy"]!,
      "Sites control-plane trust policy",
    ),
    boundedJson(
      options["--github-attestation-verification"]!,
      "GitHub attestation verification",
    ),
    bootstrapSourceBytesFromOptions(options),
  ]);
  if (releaseEvidenceKeyId(bootstrapEvidence) !== authority.releaseKeyId) {
    throw new Error("bootstrap evidence key ID is not protected");
  }
  assertProtectedBootstrapIndependentProducer({
    bootstrapEvidence,
    producerKeyId: authority.producerKeyId,
    producerKeySha256: authority.producerKeySha256,
    repository,
    defaultBranch,
  });
  assertStablePredecessorBootstrapSourceBindings(
    bootstrapEvidencePayload(bootstrapEvidence),
    sourceBytes,
  );
  const parsedImage = validateStablePredecessorBootstrapImageAttestationV1(
    imageAttestation,
    repository,
    defaultBranch,
  );
  assertProtectedBootstrapExternalAuthorities({
    bootstrapEvidence,
    stableAuthorization,
    recoveredRailwayObservation: parsedImage.recoveredRailwayObservation,
    originalRailwayProvenance,
    originalRailwayProvenanceVerificationKey,
    sitesControlPlaneVerificationKey,
    sitesControlPlaneTrustPolicy,
    authority,
    repository,
  });
  if (
    parsedImage.githubVerificationHash
      !== signedArtifactSha256(githubAttestationVerification)
    || parsedImage.subjectImageReference !== expectedReference
    || parsedImage.workflowSourceRevision !== controllerRevision
  ) {
    throw new Error(
      "bootstrap image attestation does not bind the fresh GitHub verification",
    );
  }
  const lineage = verifyStablePredecessorBootstrapAssetBundle({
    bootstrapEvidence,
    protectedBaselineMetadata,
    releaseVerificationKey,
    approvedReleaseKeySha256: authority.releaseKeySha256,
    stableAuthorization,
    stableAuthorizationVerificationKey,
    approvedStableAuthorizerKeyId: authority.authorizerKeyId,
    approvedStableAuthorizerKeySha256: authority.authorizerKeySha256,
    imageAttestation: parsedImage,
    storedConsumer,
    expectedRepository: repository,
    expectedDefaultBranch: defaultBranch,
  });
  validateStablePredecessorBootstrapPublicationWindow({
    bootstrapEvidence,
    stableAuthorization,
  });
  await writeFile(
    options["--output"]!,
    `${JSON.stringify({
      schemaVersion:
        "genio-stable-predecessor-bootstrap-verification/v1",
      verified: true,
      candidate: lineage.candidate,
      bootstrap: lineage.bootstrap,
      imageAttestationHash: signedArtifactSha256(parsedImage),
      storedConsumerHash: signedArtifactSha256(storedConsumer),
    }, null, 2)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
}

export async function runStablePredecessorBootstrapCli(
  argv: readonly string[],
): Promise<void> {
  const parsed = parseStablePredecessorBootstrapCliArgs(argv);
  if (parsed.command === "produce") {
    await produceBootstrapAssets(parsed.options);
    return;
  }
  if (parsed.command === "verify") {
    await verifyBootstrapAssets(parsed.options);
    return;
  }
  const observation =
    await captureStablePredecessorRecoveredRailwayObservation({
      apiDeploymentPath: parsed.options["--api-deployment"]!,
      apiBuildLogPath: parsed.options["--api-build-log"]!,
      workerDeploymentPath: parsed.options["--worker-deployment"]!,
      workerBuildLogPath: parsed.options["--worker-build-log"]!,
      deepDeploymentPath: parsed.options["--deep-deployment"]!,
      deepBuildLogPath: parsed.options["--deep-build-log"]!,
    });
  await writeFile(
    parsed.options["--output"]!,
    `${JSON.stringify(observation, null, 2)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  process.stdout.write(`${JSON.stringify({
    ok: true,
    schemaVersion: observation.schemaVersion,
    observationHash: signedArtifactSha256(observation),
  })}\n`);
}

async function main(): Promise<void> {
  await runStablePredecessorBootstrapCli(process.argv.slice(2));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: "stable_predecessor_bootstrap_failed",
      message: error instanceof Error ? error.message : "unknown error",
    })}\n`);
    process.exitCode = 1;
  });
}
