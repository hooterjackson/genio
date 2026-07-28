import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import {
  SITES_CONTROL_PLANE_ISSUER_V1,
  sitesControlPlaneKeyFingerprint,
  sitesControlPlaneTrustPolicyV1,
  sitesControlPlaneVerificationKeyV1,
} from "../shared/sites-control-plane-attestation.ts";
import {
  createSitesProductionRollbackReceiptV1,
  createSitesProductionRollbackTargetV1,
  SIGNED_SITES_PRODUCTION_ROLLBACK_ATTESTATION_SCHEMA_V1,
  SITES_PRODUCTION_ROLLBACK_ATTESTATION_SCHEMA_V1,
  SITES_PRODUCTION_ROLLBACK_OPERATION,
  sitesProductionRollbackAttestationPayloadV1,
  verifySitesProductionRollbackV1,
} from "../shared/sites-production-rollback.ts";
import { createStrictSignedEnvelope } from "../shared/signed-artifact.ts";
import {
  captureSitesProductionRollbackTarget,
  produceSitesProductionRollbackReceipt,
  SITES_ROLLBACK_CAPTURE_SOURCE_SCHEMA_V1,
  SITES_ROLLBACK_DEPLOYMENT_RESULT_SCHEMA_V1,
  type RollbackFetch,
} from "../scripts/sites-production-rollback.ts";

const projectId = "appgprj_opaque:Project/01";
const previousVersionId = "sites-version:previous/opaque";
const previousVersionNumber = 41;
const previousDeploymentId = "sites-deployment:previous/opaque";
const candidateVersionId = "sites-version:candidate/opaque";
const candidateDeploymentId = "sites-deployment:candidate/opaque";
const rollbackDeploymentId = "sites-deployment:rollback/opaque";
const previousRevision = "a".repeat(40);
const candidateRevision = "b".repeat(40);
const previousArchiveHash = "c".repeat(64);
const productionUrl = "https://9enio.com";
const controlPlaneKeys = generateKeyPairSync("ed25519");
const otherKeys = generateKeyPairSync("ed25519");
const controlPlaneKeyId = "sites-control-plane-production-v1";
const controlPlaneFingerprint = sitesControlPlaneKeyFingerprint(
  controlPlaneKeys.publicKey,
);
const verificationKeySource = sitesControlPlaneVerificationKeyV1(
  controlPlaneKeys.publicKey,
);
const trustPolicy = sitesControlPlaneTrustPolicyV1({
  approvedKeyId: controlPlaneKeyId,
  approvedKeySha256: controlPlaneFingerprint,
});

function target() {
  return createSitesProductionRollbackTargetV1({
    capturedAt: "2026-07-25T12:00:00.000Z",
    projectId,
    productionUrl,
    plannedCandidate: {
      commitSha: candidateRevision,
      buildVersion: "2.4.0",
    },
    previous: {
      versionId: previousVersionId,
      versionNumber: previousVersionNumber,
      commitSha: previousRevision,
      archiveSha256: previousArchiveHash,
      deploymentId: previousDeploymentId,
      deploymentStatus: "succeeded",
      controlPlaneObservedAt: "2026-07-25T11:59:00.000Z",
      liveObservedAt: "2026-07-25T11:59:30.000Z",
      liveBuildVersion: "2.3.5",
      liveBuildRevision: previousRevision,
    },
  });
}

function deploymentResult() {
  return {
    schemaVersion: SITES_ROLLBACK_DEPLOYMENT_RESULT_SCHEMA_V1,
    projectId,
    productionUrl,
    candidate: {
      versionId: candidateVersionId,
      versionNumber: 42,
      commitSha: candidateRevision,
      buildVersion: "2.4.0",
      deploymentId: candidateDeploymentId,
      status: "succeeded" as const,
      requestedAt: "2026-07-25T12:01:00.000Z",
      readyAt: "2026-07-25T12:05:00.000Z",
    },
    rollback: {
      requestedAt: "2026-07-25T12:06:00.000Z",
      versionId: previousVersionId,
      versionNumber: previousVersionNumber,
      commitSha: previousRevision,
      archiveSha256: previousArchiveHash,
      deploymentId: rollbackDeploymentId,
      status: "succeeded" as const,
    },
    pollObservations: [
      {
        observedAt: "2026-07-25T12:06:10.000Z",
        projectId,
        versionId: previousVersionId,
        versionNumber: previousVersionNumber,
        deploymentId: rollbackDeploymentId,
        status: "deploying" as const,
      },
      {
        observedAt: "2026-07-25T12:07:00.000Z",
        projectId,
        versionId: previousVersionId,
        versionNumber: previousVersionNumber,
        deploymentId: rollbackDeploymentId,
        status: "succeeded" as const,
      },
    ],
  };
}

function receipt() {
  const result = deploymentResult();
  return createSitesProductionRollbackReceiptV1({
    generatedAt: "2026-07-25T12:10:00.000Z",
    expiresAt: "2026-07-25T13:10:00.000Z",
    target: target(),
    projectId,
    productionUrl,
    candidate: result.candidate,
    rollback: result.rollback,
    pollObservations: result.pollObservations,
    liveObservations: [
      {
        observedAt: "2026-07-25T12:08:00.000Z",
        requestUrl:
          `${productionUrl}/?__genio_rollback_probe=rollback-probe-one`,
        cacheBustNonce: "rollback-probe-one",
        cacheMode: "no-store",
        responseStatus: 200,
        buildVersion: "2.3.5",
        buildRevision: previousRevision,
      },
      {
        observedAt: "2026-07-25T12:09:00.000Z",
        requestUrl:
          `${productionUrl}/?__genio_rollback_probe=rollback-probe-two`,
        cacheBustNonce: "rollback-probe-two",
        cacheMode: "no-store",
        responseStatus: 200,
        buildVersion: "2.3.5",
        buildRevision: previousRevision,
      },
    ],
  });
}

function attestation(
  rollbackReceipt = receipt(),
  overrides: Record<string, unknown> = {},
  signingKey = controlPlaneKeys.privateKey,
) {
  const payload = {
    ...sitesProductionRollbackAttestationPayloadV1({
      generatedAt: "2026-07-25T12:10:30.000Z",
      expiresAt: "2026-07-25T13:00:00.000Z",
      receipt: rollbackReceipt,
    }),
    ...overrides,
  };
  return createStrictSignedEnvelope({
    envelopeSchemaVersion:
      SIGNED_SITES_PRODUCTION_ROLLBACK_ATTESTATION_SCHEMA_V1,
    payload,
    signingKey,
    keyId: controlPlaneKeyId,
  });
}

function verify(
  overrides: Partial<Parameters<typeof verifySitesProductionRollbackV1>[0]> = {},
) {
  const rollbackTarget = target();
  const rollbackReceipt = receipt();
  return verifySitesProductionRollbackV1({
    target: rollbackTarget,
    receipt: rollbackReceipt,
    attestation: attestation(rollbackReceipt),
    verificationKeySource,
    trustPolicy,
    expectedProjectId: projectId,
    expectedProductionUrl: productionUrl,
    expectedVersionId: previousVersionId,
    expectedVersionNumber: previousVersionNumber,
    expectedDeploymentId: rollbackDeploymentId,
    now: "2026-07-25T12:20:00.000Z",
    ...overrides,
  });
}

describe("Sites production rollback control", () => {
  test("binds the exact saved version, new deployment, live identity, and protected key", () => {
    expect(verify()).toMatchObject({
      schemaVersion: "genio-sites-production-rollback-proof/v1",
      projectId,
      productionUrl,
      versionId: previousVersionId,
      versionNumber: previousVersionNumber,
      rollbackDeploymentId,
      restoredBuildVersion: "2.3.5",
      restoredBuildRevision: previousRevision,
      verificationKeyFingerprint: controlPlaneFingerprint,
    });
  });

  test("rejects cross-project, cross-version, and cross-deployment verification", () => {
    expect(() => verify({
      expectedProjectId: "appgprj_other",
    })).toThrow(/projectId does not match/u);
    expect(() => verify({
      expectedVersionId: "sites-version:other",
    })).toThrow(/versionId does not match/u);
    expect(() => verify({
      expectedVersionNumber: previousVersionNumber + 1,
    })).toThrow(/versionNumber does not match/u);
    expect(() => verify({
      expectedDeploymentId: "sites-deployment:other",
    })).toThrow(/deploymentId does not match/u);
  });

  test("rejects receipt and target substitution even when the envelope is validly signed", () => {
    const rollbackTarget = target();
    const rollbackReceipt = receipt();
    expect(() => verifySitesProductionRollbackV1({
      target: rollbackTarget,
      receipt: rollbackReceipt,
      attestation: attestation(rollbackReceipt, {
        receiptHash: "d".repeat(64),
      }),
      verificationKeySource,
      trustPolicy,
      expectedProjectId: projectId,
      expectedProductionUrl: productionUrl,
      expectedVersionId: previousVersionId,
      expectedVersionNumber: previousVersionNumber,
      expectedDeploymentId: rollbackDeploymentId,
      now: "2026-07-25T12:20:00.000Z",
    })).toThrow(/receiptHash does not match/u);
    expect(() => verifySitesProductionRollbackV1({
      target: rollbackTarget,
      receipt: rollbackReceipt,
      attestation: attestation(rollbackReceipt, {
        targetHash: "e".repeat(64),
      }),
      verificationKeySource,
      trustPolicy,
      expectedProjectId: projectId,
      expectedProductionUrl: productionUrl,
      expectedVersionId: previousVersionId,
      expectedVersionNumber: previousVersionNumber,
      expectedDeploymentId: rollbackDeploymentId,
      now: "2026-07-25T12:20:00.000Z",
    })).toThrow(/targetHash does not match/u);
  });

  test("rejects an untrusted key and invalid rollback operation", () => {
    expect(() => verify({
      verificationKeySource: sitesControlPlaneVerificationKeyV1(
        otherKeys.publicKey,
      ),
    })).toThrow(/protected trusted key/u);
    const rollbackReceipt = receipt();
    expect(() => verify({
      receipt: rollbackReceipt,
      attestation: attestation(rollbackReceipt, {
        operation: "production_deployment_ready",
      }),
    })).toThrow(/unsupported provenance/u);
  });

  test("rejects expired, future, and receipt-detached attestation timestamps", () => {
    const rollbackReceipt = receipt();
    expect(() => verify({
      now: "2026-07-25T13:00:00.000Z",
    })).toThrow(/not currently valid/u);
    expect(() => verify({
      receipt: rollbackReceipt,
      attestation: attestation(rollbackReceipt, {
        generatedAt: "2026-07-25T12:20:01.000Z",
      }),
    })).toThrow(/timestamps do not bind/u);
    expect(() => verify({
      receipt: rollbackReceipt,
      attestation: attestation(rollbackReceipt, {
        expiresAt: "2026-07-25T13:10:01.000Z",
      }),
    })).toThrow(/timestamps do not bind/u);
  });

  test("refuses a rollback to anything except the captured saved version", () => {
    const result = deploymentResult();
    expect(() => createSitesProductionRollbackReceiptV1({
      generatedAt: "2026-07-25T12:10:00.000Z",
      expiresAt: "2026-07-25T13:10:00.000Z",
      target: target(),
      projectId,
      productionUrl,
      candidate: result.candidate,
      rollback: {
        ...result.rollback,
        versionId: "sites-version:not-the-saved-target",
      },
      pollObservations: result.pollObservations,
      liveObservations: receipt().liveObservations,
    })).toThrow(/versionId and saved target does not match/u);
  });

  test("proves the target was captured before the candidate deployment request", () => {
    const result = deploymentResult();
    expect(() => createSitesProductionRollbackReceiptV1({
      generatedAt: "2026-07-25T12:10:00.000Z",
      expiresAt: "2026-07-25T13:10:00.000Z",
      target: target(),
      projectId,
      productionUrl,
      candidate: {
        ...result.candidate,
        requestedAt: "2026-07-25T11:59:59.000Z",
      },
      rollback: result.rollback,
      pollObservations: result.pollObservations,
      liveObservations: receipt().liveObservations,
    })).toThrow(/not captured before/u);
  });

  test("requires ordered exact deployment polls and terminal success", () => {
    const result = deploymentResult();
    expect(() => createSitesProductionRollbackReceiptV1({
      generatedAt: "2026-07-25T12:10:00.000Z",
      expiresAt: "2026-07-25T13:10:00.000Z",
      target: target(),
      projectId,
      productionUrl,
      candidate: result.candidate,
      rollback: result.rollback,
      pollObservations: result.pollObservations.map((poll, index) => index === 0
        ? { ...poll, deploymentId: "sites-deployment:wrong" }
        : poll),
      liveObservations: receipt().liveObservations,
    })).toThrow(/poll 0 deploymentId does not match/u);
    expect(() => createSitesProductionRollbackReceiptV1({
      generatedAt: "2026-07-25T12:10:00.000Z",
      expiresAt: "2026-07-25T13:10:00.000Z",
      target: target(),
      projectId,
      productionUrl,
      candidate: result.candidate,
      rollback: result.rollback,
      pollObservations: [result.pollObservations[1]!],
      liveObservations: receipt().liveObservations,
    })).toThrow(/at least two deployment polls/u);
  });

  test("requires distinct no-store live probes of the restored build", () => {
    const result = deploymentResult();
    const good = receipt().liveObservations;
    expect(() => createSitesProductionRollbackReceiptV1({
      generatedAt: "2026-07-25T12:10:00.000Z",
      expiresAt: "2026-07-25T13:10:00.000Z",
      target: target(),
      projectId,
      productionUrl,
      candidate: result.candidate,
      rollback: result.rollback,
      pollObservations: result.pollObservations,
      liveObservations: [
        good[0]!,
        {
          ...good[1]!,
          cacheBustNonce: good[0]!.cacheBustNonce,
          requestUrl: good[0]!.requestUrl,
        },
      ],
    })).toThrow(/reused a cache-busting nonce/u);
    expect(() => createSitesProductionRollbackReceiptV1({
      generatedAt: "2026-07-25T12:10:00.000Z",
      expiresAt: "2026-07-25T13:10:00.000Z",
      target: target(),
      projectId,
      productionUrl,
      candidate: result.candidate,
      rollback: result.rollback,
      pollObservations: result.pollObservations,
      liveObservations: good.map((observation) => ({
        ...observation,
        buildRevision: candidateRevision,
      })),
    })).toThrow(/restored Sites live build revision does not match/u);
  });
});

describe("Sites production rollback producer", () => {
  test("captures the exact live saved version before the candidate", async () => {
    const fetchImpl = vi.fn<RollbackFetch>(async (url, init) => {
      expect(url).toContain("__genio_rollback_capture=capture-nonce");
      expect(init.cache).toBe("no-store");
      expect(init.redirect).toBe("error");
      return {
        status: 200,
        text: async () =>
          `<html data-build-version="2.3.5" data-build-revision="${previousRevision}">`,
      };
    });
    const captured = await captureSitesProductionRollbackTarget({
      source: {
        schemaVersion: SITES_ROLLBACK_CAPTURE_SOURCE_SCHEMA_V1,
        controlPlaneObservedAt: "2026-07-25T11:59:00.000Z",
        projectId,
        productionUrl,
        plannedCandidate: {
          commitSha: candidateRevision,
          buildVersion: "2.4.0",
        },
        previous: {
          versionId: previousVersionId,
          versionNumber: previousVersionNumber,
          commitSha: previousRevision,
          archiveSha256: previousArchiveHash,
          deploymentId: previousDeploymentId,
          deploymentStatus: "succeeded",
        },
      },
      fetchImpl,
      clock: () => "2026-07-25T12:00:00.000Z",
      nonceFactory: () => "capture-nonce",
    });
    expect(captured).toMatchObject({
      projectId,
      previous: {
        versionId: previousVersionId,
        versionNumber: previousVersionNumber,
        commitSha: previousRevision,
        archiveSha256: previousArchiveHash,
        liveBuildVersion: "2.3.5",
        liveBuildRevision: previousRevision,
      },
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  test("produces fresh cache-busted proof only after exact terminal polls", async () => {
    const clockValues = [
      "2026-07-25T12:08:00.000Z",
      "2026-07-25T12:09:00.000Z",
      "2026-07-25T12:10:00.000Z",
    ];
    const nonceValues = ["rollback-probe-one", "rollback-probe-two"];
    const fetchImpl = vi.fn<RollbackFetch>(async (_url, init) => {
      expect(init.headers["cache-control"]).toContain("no-store");
      return {
        status: 200,
        text: async () =>
          `<html data-build-version="2.3.5" data-build-revision="${previousRevision}">`,
      };
    });
    const produced = await produceSitesProductionRollbackReceipt({
      target: target(),
      deploymentResult: deploymentResult(),
      fetchImpl,
      clock: () => clockValues.shift()!,
      nonceFactory: () => nonceValues.shift()!,
    });
    expect(produced).toMatchObject({
      targetHash: target().evidenceHash,
      projectId,
      rollback: {
        versionId: previousVersionId,
        versionNumber: previousVersionNumber,
        deploymentId: rollbackDeploymentId,
        status: "succeeded",
      },
    });
    expect(produced.liveObservations).toHaveLength(2);
    expect(new Set(
      produced.liveObservations.map((observation) =>
        observation.cacheBustNonce),
    ).size).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

test("attestation fixture uses the protected rollback operation and schema", () => {
  const payload = sitesProductionRollbackAttestationPayloadV1({
    generatedAt: "2026-07-25T12:10:30.000Z",
    expiresAt: "2026-07-25T13:00:00.000Z",
    receipt: receipt(),
  });
  expect(payload).toMatchObject({
    schemaVersion: SITES_PRODUCTION_ROLLBACK_ATTESTATION_SCHEMA_V1,
    issuer: SITES_CONTROL_PLANE_ISSUER_V1,
    operation: SITES_PRODUCTION_ROLLBACK_OPERATION,
    projectId,
    versionId: previousVersionId,
    versionNumber: previousVersionNumber,
    deploymentId: rollbackDeploymentId,
  });
});
