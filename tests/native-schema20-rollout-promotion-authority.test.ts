import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  NATIVE_SCHEMA20_ROLLOUT_PROMOTION_AUTHORITY_SCHEMA_VERSION,
  createSignedNativeSchema20RolloutPromotionAuthorityV1,
  type NativeSchema20RolloutPromotionAuthorityExpectedV1,
  type NativeSchema20RolloutPromotionAuthorityPayloadV1,
  verifyNativeSchema20RolloutPromotionAuthorityV1,
} from "../shared/native-schema20-rollout-promotion-authority.ts";

const keys = generateKeyPairSync("ed25519");
const otherKeys = generateKeyPairSync("ed25519");
const candidateRevision = "a".repeat(40);
const candidateImageDigest = `sha256:${"b".repeat(64)}`;
const candidateImageReference =
  `ghcr.io/hooterjackson/genio@${candidateImageDigest}`;
const priorSitesRevision = "c".repeat(40);
const generatedAt = "2026-08-02T18:05:00.000Z";
const expiresAt = "2026-08-03T18:05:00.000Z";

function payload(
  overrides: Partial<NativeSchema20RolloutPromotionAuthorityPayloadV1> = {},
): NativeSchema20RolloutPromotionAuthorityPayloadV1 {
  return {
    schemaVersion:
      NATIVE_SCHEMA20_ROLLOUT_PROMOTION_AUTHORITY_SCHEMA_VERSION,
    generatedAt,
    expiresAt,
    environment: "production",
    candidate: {
      tag: "v2.5.4-rc.1",
      version: "2.5.4",
      sourceRevision: candidateRevision,
      imageReference: candidateImageReference,
      imageDigest: candidateImageDigest,
    },
    nativePromotion: {
      receiptHash: "d".repeat(64),
      completedAt: "2026-08-02T17:00:00.000Z",
    },
    promotion: {
      configurationHash: "e".repeat(64),
      runtimeHash: "f".repeat(64),
      semanticBehaviorHash: "1".repeat(64),
      backendConvergenceEvidenceHash: "2".repeat(64),
      backendConvergenceCompletedAt: "2026-08-02T18:00:00.000Z",
    },
    sites: {
      projectId: "appgprj_6a5565cf7d6c8191ab9f2084e8eda856",
      versionId: "site-version-prior-81",
      deploymentId: "site-deployment-prior-81",
      version: "2.5.3",
      sourceRevision: priorSitesRevision,
      candidateMatched: false,
      controlPlaneEvidenceHash: "3".repeat(64),
    },
    ...overrides,
  };
}

function expected(
  overrides: Partial<NativeSchema20RolloutPromotionAuthorityExpectedV1> = {},
): NativeSchema20RolloutPromotionAuthorityExpectedV1 {
  const value = payload();
  return {
    keyId: "release-verification-v1",
    keySha256: createHash("sha256")
      .update(keys.publicKey.export({ format: "der", type: "spki" }))
      .digest("hex"),
    candidate: value.candidate,
    nativePromotion: value.nativePromotion,
    promotion: value.promotion,
    sites: {
      projectId: value.sites.projectId,
      versionId: value.sites.versionId,
      deploymentId: value.sites.deploymentId,
      version: value.sites.version,
      sourceRevision: value.sites.sourceRevision,
      controlPlaneEvidenceHash: value.sites.controlPlaneEvidenceHash,
    },
    now: "2026-08-02T18:10:00.000Z",
    ...overrides,
  };
}

function signed(
  value = payload(),
  key = keys.privateKey,
  keyId = "release-verification-v1",
) {
  return createSignedNativeSchema20RolloutPromotionAuthorityV1({
    payload: value,
    signingKey: key,
    keyId,
  });
}

describe("native schema-20 rollout promotion authority", () => {
  test("normalizes the exact native promotion, runtime, canary, and prior Sites bindings", () => {
    const verified = verifyNativeSchema20RolloutPromotionAuthorityV1(
      signed(),
      keys.publicKey,
      expected(),
    );

    expect(verified).toMatchObject({
      authorityKind: "native_schema20_rollout_promotion",
      candidate: {
        tag: "v2.5.4-rc.1",
        version: "2.5.4",
        sourceRevision: candidateRevision,
        imageReference: candidateImageReference,
        imageDigest: candidateImageDigest,
      },
      nativePromotionReceiptHash: "d".repeat(64),
      configurationHash: "e".repeat(64),
      runtimeHash: "f".repeat(64),
      semanticBehaviorHash: "1".repeat(64),
      backendConvergenceEvidenceHash: "2".repeat(64),
      backendConvergenceCompletedAt: "2026-08-02T18:00:00.000Z",
      sitesVersion: "2.5.3",
      sitesRevision: priorSitesRevision,
      sitesCandidateMatched: false,
      sites: {
        projectId: "appgprj_6a5565cf7d6c8191ab9f2084e8eda856",
        versionId: "site-version-prior-81",
        deploymentId: "site-deployment-prior-81",
        controlPlaneEvidenceHash: "3".repeat(64),
      },
    });
    expect(verified.payloadHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  test.each([
    ["candidate tag", {
      candidate: {
        ...expected().candidate,
        tag: "v2.5.4-rc.2",
      },
    }],
    ["native promotion receipt", {
      nativePromotion: {
        ...expected().nativePromotion,
        receiptHash: "4".repeat(64),
      },
    }],
    ["runtime hash", {
      promotion: {
        ...expected().promotion,
        runtimeHash: "5".repeat(64),
      },
    }],
    ["semantic behavior hash", {
      promotion: {
        ...expected().promotion,
        semanticBehaviorHash: "6".repeat(64),
      },
    }],
    ["backend convergence evidence", {
      promotion: {
        ...expected().promotion,
        backendConvergenceEvidenceHash: "7".repeat(64),
      },
    }],
    ["Sites deployment", {
      sites: {
        ...expected().sites,
        deploymentId: "site-deployment-other",
      },
    }],
  ])("rejects an unexpected %s binding", (_label, override) => {
    expect(() => verifyNativeSchema20RolloutPromotionAuthorityV1(
      signed(),
      keys.publicKey,
      expected(
        override as Partial<
          NativeSchema20RolloutPromotionAuthorityExpectedV1
        >,
      ),
    )).toThrow(/does not bind the expected release context/u);
  });

  test("rejects tampering, the wrong verification key, and the wrong protected key ID", () => {
    const envelope = signed();
    expect(() => verifyNativeSchema20RolloutPromotionAuthorityV1(
      {
        ...envelope,
        payload: {
          ...envelope.payload,
          promotion: {
            ...(envelope.payload.promotion as Record<string, unknown>),
            runtimeHash: "8".repeat(64),
          },
        },
      },
      keys.publicKey,
      expected(),
    )).toThrow(/payload hash does not match/u);

    expect(() => verifyNativeSchema20RolloutPromotionAuthorityV1(
      envelope,
      otherKeys.publicKey,
      expected(),
    )).toThrow(/protected release key/u);

    expect(() => verifyNativeSchema20RolloutPromotionAuthorityV1(
      envelope,
      keys.publicKey,
      expected({ keyId: "other-release-key" }),
    )).toThrow(/protected release key ID/u);
  });

  test("rejects a candidate-matched Sites identity and invalid chronology", () => {
    expect(() => signed(payload({
      sites: {
        ...payload().sites,
        version: "2.5.4",
        sourceRevision: candidateRevision,
        candidateMatched: false,
      },
    }))).toThrow(/preserve the exact prior Sites identity/u);

    expect(() => signed(payload({
      promotion: {
        ...payload().promotion,
        backendConvergenceCompletedAt: "2026-08-02T16:59:59.000Z",
      },
    }))).toThrow(/chronology is invalid/u);
  });

  test("rejects expired or overlong evidence without weakening historical verification", () => {
    expect(() => verifyNativeSchema20RolloutPromotionAuthorityV1(
      signed(),
      keys.publicKey,
      expected({ now: expiresAt }),
    )).toThrow(/has expired/u);

    expect(verifyNativeSchema20RolloutPromotionAuthorityV1(
      signed(),
      keys.publicKey,
      expected({ now: generatedAt }),
    ).payloadHash).toMatch(/^[0-9a-f]{64}$/u);

    expect(() => signed(payload({
      expiresAt: "2026-08-03T18:05:00.001Z",
    }))).toThrow(/expire within 24 hours/u);
  });
});
