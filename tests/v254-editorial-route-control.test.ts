import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import {
  buildV254EditorialRouteBehaviorManifestV1,
  buildV254EditorialRouteControlPlanV1,
  expectedV254EditorialRouteProofSourceV1,
  redactV254EditorialRouteCommandStderr,
  validateV254EditorialRouteAuthorityReceiptV1,
  validateV254EditorialRouteProofSourceV1,
  verifyV254EditorialRouteProofV1,
  type V254EditorialRouteAuthorityReceiptV1,
} from "../scripts/v254-editorial-route-control.ts";
import {
  attestReleaseGateArtifact,
} from "../scripts/release-fixtures.ts";
import {
  nativeV254OwnerEditorialGateVariablesV1,
  nativeV254PublicEditorialActivationVariablesV1,
} from "../scripts/promote-native-schema20-release.ts";
import {
  PUBLIC_ROLLOUT_INTENT_PERCENT_FLAGS,
} from "../shared/public-rollout-evidence.ts";
import {
  createStableBootstrapIndependentEvidenceFixture,
} from "./helpers/stable-bootstrap-independent-evidence.ts";

const sha = (character: string) => character.repeat(64);
const revision = "1".repeat(40);
const serviceIds = {
  interactive: "11111111-1111-4111-8111-111111111111",
  deep: "22222222-2222-4222-8222-222222222222",
  api: "33333333-3333-4333-8333-333333333333",
};
const promotion = {
  schemaVersion: "genio-native-schema20-promotion/v1",
  sourceRevision: revision,
  version: "2.5.4",
  imageReference: `ghcr.io/hooterjackson/genio@sha256:${sha("a")}`,
  imageDigest: `sha256:${sha("a")}`,
  candidateEvidenceHash: sha("b"),
  exactShaImageReceiptHash: sha("c"),
  semanticBehaviorManifestHash: sha("d"),
  semanticExecutionConfigurationHash: sha("e"),
  containmentReceiptHash: sha("f"),
  guidanceCheckpointMigrationReceiptHash: sha("0"),
  legacyExecutionRouteDrainInventoryReceiptHash: sha("1"),
  schema20EvidenceRecoveryReceiptHash: sha("2"),
  projectId: "44444444-4444-4444-8444-444444444444",
  environment: "production",
  services: {
    interactive: { serviceId: serviceIds.interactive, deploymentId: "51111111-1111-4111-8111-111111111111" },
    deep: { serviceId: serviceIds.deep, deploymentId: "52222222-2222-4222-8222-222222222222" },
    api: { serviceId: serviceIds.api, deploymentId: "53333333-3333-4333-8333-333333333333" },
  },
  backendConvergenceEvidenceHash: sha("3"),
  completedAt: "2026-08-02T12:00:00.000Z",
  receiptHash: sha("4"),
} as const;

function inventories() {
  return [{}, {}, {}] as Array<Record<string, string>>;
}

function receipt(input: Partial<V254EditorialRouteAuthorityReceiptV1> = {}) {
  const unsigned = {
    schemaVersion: "genio-v254-editorial-route-authority/v1" as const,
    phase: "owner_gate" as const,
    rollbackTarget: null,
    sourceRevision: revision,
    version: "2.5.4",
    imageReference: promotion.imageReference,
    imageDigest: promotion.imageDigest,
    promotionReceiptHash: promotion.receiptHash,
    priorAuthorityReceiptHash: null,
    ownerGateReceiptHash: sha("5"),
    publicCanaryReceiptHash: null,
    proofEvidenceHash: null,
    behaviorManifestHash: sha("6"),
    semanticExecutionConfigurationHash: sha("7"),
    approvalHash: sha("8"),
    rollbackId: sha("9"),
    rollingDeployGuardHash: null,
    railwayProjectId: promotion.projectId,
    services: promotion.services,
    database: {
      hardSwitchDisabled: false,
      globalPublicPause: true,
      intentPublicPause: true,
    },
    applied: true,
    completedAt: "2026-08-02T13:00:00.000Z",
    ...input,
  };
  // Validator hash behavior is covered by operational release tests; the
  // plan tests below need only a typed predecessor.
  return { ...unsigned, receiptHash: sha("a") } as V254EditorialRouteAuthorityReceiptV1;
}

describe("v2.5.4 editorial route activation authority", () => {
  test("fails closed for every Railway stderr credential shape", () => {
    const samples = [
      "railway_token_abcdefghijklmnopqrstuvwxyz0123456789",
      "postgresql://needle:p@ss.word/short@db.example.test:5432/needle",
      "Authorization: Bearer ab.cd+ef/gh==",
      "RAILWAY_TOKEN=rwy_short.value",
      '{"password":"tiny","token":"YWJjLmRlZg=="}',
      "unknown future credential syntax: secret·value",
    ];
    for (const secret of samples) {
      const redacted = redactV254EditorialRouteCommandStderr(
        `request failed for ${secret}: permission denied`,
      );
      expect(redacted).toBe("[redacted Railway stderr]");
      expect(redacted).not.toContain(secret);
      expect(redacted).not.toContain("permission denied");
    }
    expect(redactV254EditorialRouteCommandStderr(" \n\t"))
      .toBe("[no Railway stderr]");
  });

  test("pins each proof phase to its one approved exact-SHA workflow and artifact", () => {
    const expected = expectedV254EditorialRouteProofSourceV1(
      "public_canary",
      revision,
    )!;
    expect(validateV254EditorialRouteProofSourceV1({
      phase: "public_canary",
      sourceRevision: revision,
      ...expected,
    })).toEqual(expected);
    expect(() => validateV254EditorialRouteProofSourceV1({
      phase: "public_canary",
      sourceRevision: revision,
      ...expected,
      workflowPath: ".github/workflows/untrusted-proof.yml",
    })).toThrow(/approved exact-SHA producer/u);
    expect(() => validateV254EditorialRouteProofSourceV1({
      phase: "public_canary",
      sourceRevision: revision,
      ...expected,
      artifactName: `self-authored-${revision}`,
    })).toThrow(/approved exact-SHA producer/u);
  });

  test("accepts only an intended signed proof under the protected producer key", () => {
    const fixture = createStableBootstrapIndependentEvidenceFixture({
      candidate: {
        tag: "v2.5.4-rc.1",
        version: "2.5.4",
        sourceRevision: revision,
        sitesSourceRevision: revision,
        imageDigest: promotion.imageDigest,
      },
      completedAt: "2026-08-02T14:00:00.000Z",
    });
    const finalBrowser = fixture.bundle.sources.find(
      ({ gate }) => gate === "final_custom_domain_browser",
    )!;
    const verify = (attestationValue: unknown) =>
      verifyV254EditorialRouteProofV1({
        artifactValue: finalBrowser.artifact,
        attestationValue,
        verificationKey: fixture.producerKeys.publicKey.export({
          format: "pem",
          type: "spki",
        }),
        approvedKeyId: fixture.producerKeyId,
        approvedKeySha256: fixture.producerKeySha256,
        phase: "public_expose",
        expected: {
          sourceRevision: revision,
          version: "2.5.4",
          imageDigest: promotion.imageDigest,
        },
      });
    expect(verify(finalBrowser.attestation))
      .toBe(finalBrowser.artifact.evidenceHash);
    expect(() => verify({})).toThrow(/producer attestation/u);
    const selfAuthoredKeys = generateKeyPairSync("ed25519");
    expect(() => verify(attestReleaseGateArtifact(
      finalBrowser.artifact,
      selfAuthoredKeys.privateKey,
      fixture.producerKeyId,
    ))).toThrow(/signature is invalid/u);
    expect(() => verifyV254EditorialRouteProofV1({
      artifactValue: finalBrowser.artifact,
      attestationValue: finalBrowser.attestation,
      verificationKey: fixture.producerKeys.publicKey.export({
        format: "pem",
        type: "spki",
      }),
      approvedKeyId: fixture.producerKeyId,
      approvedKeySha256: fixture.producerKeySha256,
      phase: "public_canary",
      expected: {
        sourceRevision: revision,
        version: "2.5.4",
        imageDigest: promotion.imageDigest,
      },
    })).toThrow(/does not bind the exact candidate/u);
  });

  test("keeps the initial exact-SHA manifest owner-gate ready and every public V3 intent at zero", () => {
    const owner = nativeV254OwnerEditorialGateVariablesV1();
    expect(owner).toMatchObject({
      PIPELINE_V3_OWNER_CANARY: "true",
      PIPELINE_V3_OWNER_CANARY_GROUPS: "editorial_influence",
      PIPELINE_V3_EDITORIAL_INFLUENCE_PERCENT: "0",
    });
    for (const flag of Object.values(PUBLIC_ROLLOUT_INTENT_PERCENT_FLAGS)) {
      expect(owner[flag]).toBe("0");
    }
  });

  test("owner gate is same-image/no-redeploy and disengages only the hard switch", () => {
    const behavior = buildV254EditorialRouteBehaviorManifestV1({
      phase: "owner_gate",
      rollbackTarget: "owner_gate",
      inventories: inventories(),
    });
    const plan = buildV254EditorialRouteControlPlanV1({
      phase: "owner_gate",
      rollbackTarget: "owner_gate",
      promotion: promotion as never,
      priorAuthority: null,
      proofEvidenceHash: null,
      behavior,
      database: {
        hardSwitchDisabled: true,
        globalPublicPause: true,
        intentPublicPause: true,
        currentAuthorityReceipt: null,
      },
    });
    expect(plan).toMatchObject({
      imageDigest: promotion.imageDigest,
      requiresRedeploy: false,
      deploymentOrder: ["interactive", "deep", "api"],
      targetDatabase: {
        hardSwitchDisabled: false,
        globalPublicPause: true,
        intentPublicPause: true,
      },
      requiresRollingDeployGuard: false,
      rollingDeployGuardHash: null,
    });
  });

  test("public canary redeploys the same digest workers-first/API-last while the intent stays paused", () => {
    const owner = receipt();
    const behavior = buildV254EditorialRouteBehaviorManifestV1({
      phase: "public_canary",
      rollbackTarget: "owner_gate",
      inventories: inventories(),
    });
    const plan = buildV254EditorialRouteControlPlanV1({
      phase: "public_canary",
      rollbackTarget: "owner_gate",
      promotion: promotion as never,
      priorAuthority: owner,
      proofEvidenceHash: sha("b"),
      behavior,
      database: {
        hardSwitchDisabled: false,
        globalPublicPause: true,
        intentPublicPause: true,
        currentAuthorityReceipt: owner,
      },
    });
    expect(nativeV254PublicEditorialActivationVariablesV1()).toMatchObject({
      PIPELINE_V3_OWNER_CANARY: "false",
      PIPELINE_V3_EDITORIAL_INFLUENCE_PERCENT: "100",
    });
    expect(behavior.values).toMatchObject({
      PIPELINE_V3_OWNER_CANARY: "true",
      PIPELINE_V3_EDITORIAL_INFLUENCE_PERCENT: "0",
    });
    expect(plan).toMatchObject({
      imageDigest: promotion.imageDigest,
      requiresRedeploy: true,
      deploymentOrder: ["interactive", "deep", "api"],
      targetDatabase: {
        hardSwitchDisabled: false,
        globalPublicPause: true,
        intentPublicPause: true,
      },
      requiresRollingDeployGuard: true,
    });
    expect(plan.rollingDeployGuardHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("public exposure is DB-only and rollback re-engages switch and pauses first", () => {
    const publicCanary = receipt({
      phase: "public_canary",
      priorAuthorityReceiptHash: sha("a"),
      ownerGateReceiptHash: sha("5"),
      publicCanaryReceiptHash: sha("b"),
      rollingDeployGuardHash: sha("f"),
      proofEvidenceHash: sha("c"),
      receiptHash: sha("d"),
    });
    const behavior = buildV254EditorialRouteBehaviorManifestV1({
      phase: "public_expose",
      rollbackTarget: "owner_gate",
      inventories: inventories(),
    });
    const expose = buildV254EditorialRouteControlPlanV1({
      phase: "public_expose",
      rollbackTarget: "owner_gate",
      promotion: promotion as never,
      priorAuthority: publicCanary,
      proofEvidenceHash: sha("e"),
      behavior,
      database: {
        hardSwitchDisabled: false,
        globalPublicPause: true,
        intentPublicPause: true,
        currentAuthorityReceipt: publicCanary,
      },
    });
    expect(expose.requiresRedeploy).toBe(false);
    expect(expose.requiresRollingDeployGuard).toBe(false);
    expect(expose.rollingDeployGuardHash).toBe(sha("f"));
    expect(expose.targetDatabase).toEqual({
      hardSwitchDisabled: false,
      globalPublicPause: false,
      intentPublicPause: false,
    });
    const rollbackBehavior = buildV254EditorialRouteBehaviorManifestV1({
      phase: "rollback_zero",
      rollbackTarget: "zero",
      inventories: inventories(),
    });
    const rollback = buildV254EditorialRouteControlPlanV1({
      phase: "rollback_zero",
      rollbackTarget: "zero",
      promotion: promotion as never,
      priorAuthority: publicCanary,
      proofEvidenceHash: null,
      behavior: rollbackBehavior,
      database: {
        hardSwitchDisabled: false,
        globalPublicPause: false,
        intentPublicPause: false,
        currentAuthorityReceipt: publicCanary,
      },
    });
    expect(rollback).toMatchObject({
      requiresRedeploy: true,
      targetDatabase: {
        hardSwitchDisabled: true,
        globalPublicPause: true,
        intentPublicPause: true,
      },
    });
    expect(rollback.rollbackId).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("rejects a final exposure receipt without both owner and public-canary lineage", () => {
    expect(() => validateV254EditorialRouteAuthorityReceiptV1({
      ...receipt({
        phase: "public_expose",
        priorAuthorityReceiptHash: sha("a"),
        ownerGateReceiptHash: null,
        publicCanaryReceiptHash: null,
        proofEvidenceHash: sha("b"),
        database: {
          hardSwitchDisabled: false,
          globalPublicPause: false,
          intentPublicPause: false,
        },
      }),
    })).toThrow();
  });

  test("pre-exposure pause workflow exposes only the two paused exact-image phases", async () => {
    const [workflow, authority] = await Promise.all([
      readFile(new URL(
        "../.github/workflows/v254-pre-exposure-route-pause.yml",
        import.meta.url,
      ), "utf8"),
      readFile(new URL(
        "../scripts/v254-editorial-route-control.ts",
        import.meta.url,
      ), "utf8"),
    ]);
    expect(workflow).toContain(
      "options:\n          - owner_gate\n          - public_canary",
    );
    expect(workflow).toContain("native-schema20-promotion-${{ inputs.source_revision }}");
    expect(workflow).toContain(
      'test "$(jq -r \'.path\' <<<"$PRIOR")" = ".github/workflows/v254-pre-exposure-route-pause.yml"',
    );
    expect(workflow).toContain(
      'test "$(jq -r \'.path\' <<<"$PROOF")" = ".github/workflows/v254-owner-apple-gate.yml"',
    );
    expect(workflow).toContain(
      'test "$PROOF_ARTIFACT" = "v254-owner-apple-gate-$SOURCE_REVISION"',
    );
    expect(workflow).toContain(
      'test "$PRIOR_ARTIFACT" = "v254-pre-exposure-route-pause-owner_gate-$SOURCE_REVISION"',
    );
    expect(workflow).toContain(
      "name: v254-pre-exposure-route-pause-${{ inputs.phase }}-${{ inputs.source_revision }}",
    );
    expect(workflow).toContain("RELEASE_GATE_PRODUCER_PUBLIC_KEY_BASE64");
    expect(workflow).toContain("--proof-attestation");
    expect(workflow).toContain("--producer-verification-key");
    expect(authority).toContain("verifyReleaseGateProducerAttestation");
    expect(authority).toContain("releaseGateProducerKeyFingerprint");
    expect(workflow).toContain("pnpm release:v254:route-control -- dry-run");
    expect(workflow).toContain("pnpm release:v254:route-control -- apply");
    expect(workflow).toContain(
      'and (.imageDigest | test("^sha256:[0-9a-f]{64}$"))',
    );
    expect(workflow).toContain(".database.globalPublicPause == true");
    expect(workflow).toContain(".database.intentPublicPause == true");
    expect(workflow).not.toContain("public_expose");
    expect(workflow).not.toContain("rollback_zero");
    expect(workflow).not.toContain("v254-editorial-stage-canary");
    expect(workflow).not.toContain("v254-editorial-rollout-authority");
    expect(workflow).not.toContain("--stage");
    expect(workflow).not.toContain("v254-final-browser-");
    expect(workflow).not.toMatch(/railway up|--from-source|service create|docker build/u);
    const guard = authority.indexOf('"db-guard"');
    const stage = authority.indexOf("await stageManifest", guard);
    const worker = authority.indexOf("await requireWorkerConvergence", stage);
    const api = authority.indexOf("deploymentIds.api = await promoteExactService", worker);
    const convergence = authority.indexOf("await requireSystemConvergence", api);
    const release = authority.indexOf('"db-transition"', convergence);
    expect(guard).toBeGreaterThan(-1);
    expect(stage).toBeGreaterThan(guard);
    expect(worker).toBeGreaterThan(stage);
    expect(api).toBeGreaterThan(worker);
    expect(convergence).toBeGreaterThan(api);
    expect(release).toBeGreaterThan(convergence);
  });
});
