import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  RELEASE_EVIDENCE_TTL_MS,
  releaseEvidenceConfigurationHash,
  releaseEvidenceRuntimeHash,
  signReleaseEvidence,
  validateReleaseEvidencePayload,
  verifyReleaseEvidence,
} from "../scripts/release-evidence.ts";

const revision = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const hash = "c".repeat(64);
const generatedAt = "2026-07-23T12:00:00.000Z";
const expiresAt = new Date(Date.parse(generatedAt) + RELEASE_EVIDENCE_TTL_MS).toISOString();

function gate(
  name: string,
  environment: "offline" | "staging" | "production",
) {
  return {
    name,
    environment,
    passed: true,
    completedAt: generatedAt,
    evidenceHash: hash,
    cacheMode: environment === "offline" ? "not_applicable" : "cold",
    budgetStatus: environment === "staging" ? "within_cap" : "not_applicable",
  };
}

function payload(kind: "candidate" | "promotion" = "candidate"): any {
  const gates = [
    gate("offline_suite", "offline"),
    gate("staging_provider_manifest", "staging"),
    gate("staging_fixed_three_track", "staging"),
    gate("staging_affected_regression", "staging"),
    gate("staging_guided_constraint", "staging"),
    gate("semantic_ranking_blinded_review", "staging"),
  ];
  if (kind === "promotion") {
    gates.push(
      gate("production_fixed_three_track", "production"),
      gate("production_affected_regression", "production"),
      gate("release_convergence", "production"),
      gate("final_custom_domain_browser", "production"),
    );
  }
  return {
    schemaVersion: "genio-release-evidence/v1",
    kind,
    generatedAt,
    expiresAt,
    candidate: {
      tag: "v2.4.0-rc.1",
      version: "2.4.0",
      sourceRevision: revision,
      imageDigest: digest,
      sitesSourceRevision: revision,
    },
    configuration: {
      apiHash: hash,
      interactiveWorkerHash: hash,
      deepWorkerHash: hash,
      sitesHash: hash,
      secretVersionsHash: hash,
    },
    stagingControls: {
      monthlyCostLimitUsd: 10,
      budgetRemainingUsd: 6,
      reservedForRequiredGatesUsd: 4,
      budgetStatus: "available",
      musicKitOrigin: "https://staging-9enio.example",
      providerSecretVersionHash: "1".repeat(64),
      productionProviderSecretVersionHash: "2".repeat(64),
      appleSecretVersionHash: "3".repeat(64),
      productionAppleSecretVersionHash: "4".repeat(64),
      appleAccountSeparationEvidenceHash: "5".repeat(64),
      musicKitOriginRegistrationEvidenceHash: "6".repeat(64),
    },
    runtime: {
      deploymentPhase: "activate",
      databaseSchemaVersion: "18",
      workerProtocol: "playlist-pipeline-v10",
      briefContractVersion: "3",
      queryPlanSchemaVersion: "4",
      modelIds: {
        brief: "gpt-5.4-mini",
        baseline: "gpt-5.6-luna",
        escalation: "gpt-5.6-terra",
      },
      policyVersions: {
        guidance: "adaptive_guidance_v3",
        evidence: "governed_evidence_v2",
        queryPlan: "query_plan_v3_4",
        selection: "selection_plan_v3",
        semanticScope: "scope_gate_v2_1_2",
        musicConcept: "music_concepts_v3_2_0",
        pipeline: "corpus_first_v3",
        prompt: "grounded_recovery_v3_1_prompt_v1",
      },
    },
    gates,
  };
}

describe("signed release evidence", () => {
  test("signs and verifies a strict, expiring artifact-bound candidate", () => {
    const keys = generateKeyPairSync("ed25519");
    const candidate = payload();
    const signed = signReleaseEvidence(candidate, keys.privateKey, "release-2026");
    expect(verifyReleaseEvidence(signed, keys.publicKey, {
      expectedKind: "candidate",
      now: "2026-07-23T12:30:00.000Z",
      expectedRevision: revision,
      expectedImageDigest: digest,
      expectedTag: "v2.4.0-rc.1",
      expectedConfigurationHash: releaseEvidenceConfigurationHash(candidate),
      expectedRuntimeHash: releaseEvidenceRuntimeHash(candidate),
    })).toMatchObject({
      kind: "candidate",
      candidate: { sourceRevision: revision, imageDigest: digest },
    });
    expect(signed.payloadHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(releaseEvidenceConfigurationHash(candidate)).toMatch(/^[0-9a-f]{64}$/u);
    expect(releaseEvidenceRuntimeHash(candidate)).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("invalidates otherwise valid evidence when runtime or configuration changes", () => {
    const keys = generateKeyPairSync("ed25519");
    const candidate = payload();
    const signed = signReleaseEvidence(candidate, keys.privateKey, "release-2026");
    expect(() => verifyReleaseEvidence(signed, keys.publicKey, {
      expectedKind: "candidate",
      now: "2026-07-23T12:30:00.000Z",
      expectedConfigurationHash: "d".repeat(64),
    })).toThrow(/configuration does not match/u);
    expect(() => verifyReleaseEvidence(signed, keys.publicKey, {
      expectedKind: "candidate",
      now: "2026-07-23T12:30:00.000Z",
      expectedRuntimeHash: "e".repeat(64),
    })).toThrow(/runtime does not match/u);
  });

  test("rejects tampering, expiry, and a signature for another key", () => {
    const keys = generateKeyPairSync("ed25519");
    const other = generateKeyPairSync("ed25519");
    const signed = signReleaseEvidence(payload(), keys.privateKey, "release-2026");
    expect(() => verifyReleaseEvidence({
      ...signed,
      payload: {
        ...signed.payload,
        candidate: { ...signed.payload.candidate, imageDigest: `sha256:${"d".repeat(64)}` },
      },
    }, keys.publicKey, {
      expectedKind: "candidate",
      now: "2026-07-23T12:30:00.000Z",
    })).toThrow(/payload hash/u);
    expect(() => verifyReleaseEvidence(signed, other.publicKey, {
      expectedKind: "candidate",
      now: "2026-07-23T12:30:00.000Z",
    })).toThrow(/signature is invalid/u);
    expect(() => verifyReleaseEvidence(signed, keys.publicKey, {
      expectedKind: "candidate",
      now: expiresAt,
    })).toThrow(/expired/u);
  });

  test("requires and enforces the caller's expected evidence kind", () => {
    const keys = generateKeyPairSync("ed25519");
    const candidate = signReleaseEvidence(payload(), keys.privateKey, "release-2026");
    expect(() => verifyReleaseEvidence(
      candidate,
      keys.publicKey,
      undefined as never,
    )).toThrow(/requires an expected candidate or promotion kind/u);
    expect(() => verifyReleaseEvidence(candidate, keys.publicKey, {
      expectedKind: "promotion",
      now: "2026-07-23T12:30:00.000Z",
    })).toThrow(/kind candidate does not match expected promotion/u);

    const promotion = signReleaseEvidence(
      payload("promotion"),
      keys.privateKey,
      "release-2026",
    );
    expect(verifyReleaseEvidence(promotion, keys.publicKey, {
      expectedKind: "promotion",
      now: "2026-07-23T12:30:00.000Z",
    })).toMatchObject({ kind: "promotion" });
  });

  test("the verification CLI fails closed when --expected-kind is omitted", () => {
    const keys = generateKeyPairSync("ed25519");
    const signed = signReleaseEvidence(payload(), keys.privateKey, "release-2026");
    const directory = mkdtempSync(join(tmpdir(), "genio-release-evidence-"));
    try {
      const evidencePath = join(directory, "evidence.json");
      const publicKeyPath = join(directory, "verification-key.pem");
      writeFileSync(evidencePath, JSON.stringify(signed));
      writeFileSync(publicKeyPath, keys.publicKey.export({
        type: "spki",
        format: "pem",
      }));
      const result = spawnSync(process.execPath, [
        "--experimental-transform-types",
        fileURLToPath(new URL("../scripts/release-evidence.ts", import.meta.url)),
        "verify",
        "--input",
        evidencePath,
        "--public-key",
        publicKeyPath,
        "--expected-revision",
        revision,
        "--expected-image-digest",
        digest,
        "--expected-tag",
        "v2.4.0-rc.1",
        "--expected-configuration-hash",
        releaseEvidenceConfigurationHash(signed.payload),
        "--expected-runtime-hash",
        releaseEvidenceRuntimeHash(signed.payload),
      ], { encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("--expected-kind requires a value");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("allows no raw prompts, run IDs, arbitrary labels, or incomplete promotion gates", () => {
    expect(() => validateReleaseEvidencePayload({
      ...payload(),
      rawPrompt: "make a playlist",
    })).toThrow(/unapproved fields/u);
    expect(() => validateReleaseEvidencePayload({
      ...payload(),
      runtime: {
        ...payload().runtime,
        modelIds: {
          ...payload().runtime.modelIds,
          brief: "sk-secret",
        },
      },
    })).toThrow(/approved release label/u);
    expect(() => validateReleaseEvidencePayload({
      ...payload(),
      kind: "promotion",
    })).toThrow(/gates do not match promotion/u);
    expect(() => validateReleaseEvidencePayload({
      ...payload(),
      runtime: {
        ...payload().runtime,
        queryPlanSchemaVersion: "3",
      },
    })).toThrow(/schema-18\/protocol-10 release contract/u);
    for (const [field, value] of [
      ["guidance", "intelligent_guidance_v2"],
      ["evidence", "governed_evidence_v1"],
    ] as const) {
      expect(() => validateReleaseEvidencePayload({
        ...payload(),
        runtime: {
          ...payload().runtime,
          policyVersions: {
            ...payload().runtime.policyVersions,
            [field]: value,
          },
        },
      })).toThrow(new RegExp(`policyVersions\\.${field}.*release contract`, "u"));
    }
  });

  test("cannot sign candidate evidence when staging budget or credential isolation is unproven", () => {
    expect(() => validateReleaseEvidencePayload({
      ...payload(),
      stagingControls: {
        ...payload().stagingControls,
        budgetRemainingUsd: 0,
        reservedForRequiredGatesUsd: 0,
      },
    })).toThrow(/budget cannot cover every required live gate/u);
    expect(() => validateReleaseEvidencePayload({
      ...payload(),
      stagingControls: {
        ...payload().stagingControls,
        productionProviderSecretVersionHash:
          payload().stagingControls.providerSecretVersionHash,
      },
    })).toThrow(/provider credential versions must be different/u);
    const candidate = payload();
    candidate.gates = candidate.gates.map((item: any) => (
      item.environment === "staging" ? { ...item, budgetStatus: "not_applicable" } : item
    ));
    expect(() => validateReleaseEvidencePayload(candidate)).toThrow(/QA budget state/u);
  });
});
