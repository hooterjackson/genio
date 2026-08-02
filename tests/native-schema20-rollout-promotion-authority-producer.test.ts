import {
  createHash,
  generateKeyPairSync,
} from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  parseNativePromotionAuthorityProducerArgsV1,
  produceNativeSchema20RolloutPromotionAuthorityV1,
} from "../scripts/native-schema20-rollout-promotion-authority-producer.ts";
import { signedArtifactSha256 } from "../shared/signed-artifact.ts";

function promotionReceipt() {
  const imageDigest = `sha256:${"b".repeat(64)}`;
  const unsigned = {
    schemaVersion: "genio-native-schema20-promotion/v1",
    sourceRevision: "a".repeat(40),
    version: "2.5.4",
    imageReference: `ghcr.io/hooterjackson/genio@${imageDigest}`,
    imageDigest,
    candidateEvidenceHash: "c".repeat(64),
    exactShaImageReceiptHash: "d".repeat(64),
    semanticBehaviorManifestHash: "e".repeat(64),
    semanticExecutionConfigurationHash: "f".repeat(64),
    containmentReceiptHash: "1".repeat(64),
    guidanceCheckpointMigrationReceiptHash: "9".repeat(64),
    legacyExecutionRouteDrainInventoryReceiptHash: "2".repeat(64),
    schema20EvidenceRecoveryReceiptHash: "3".repeat(64),
    projectId: "7e7a44ee-3e54-453c-9120-3cb1f33db76e",
    environment: "production",
    services: {
      interactive: {
        serviceId: "3affc435-074d-4f6f-806f-1c2b552a8b17",
        deploymentId: "10000000-0000-4000-8000-000000000001",
      },
      deep: {
        serviceId: "a3469457-f56e-4871-8a10-5ea6c052640c",
        deploymentId: "10000000-0000-4000-8000-000000000002",
      },
      api: {
        serviceId: "11ba75aa-2495-4f28-bbde-64c43efbe731",
        deploymentId: "10000000-0000-4000-8000-000000000003",
      },
    },
    rollbackServices: {
      interactive: {
        serviceId: "3affc435-074d-4f6f-806f-1c2b552a8b17",
        deploymentId: "20000000-0000-4000-8000-000000000001",
        imageReference: `ghcr.io/hooterjackson/genio@sha256:${"4".repeat(64)}`,
        imageDigest: `sha256:${"4".repeat(64)}`,
      },
      deep: {
        serviceId: "a3469457-f56e-4871-8a10-5ea6c052640c",
        deploymentId: "20000000-0000-4000-8000-000000000002",
        imageReference: `ghcr.io/hooterjackson/genio@sha256:${"4".repeat(64)}`,
        imageDigest: `sha256:${"4".repeat(64)}`,
      },
      api: {
        serviceId: "11ba75aa-2495-4f28-bbde-64c43efbe731",
        deploymentId: "20000000-0000-4000-8000-000000000003",
        imageReference: `ghcr.io/hooterjackson/genio@sha256:${"4".repeat(64)}`,
        imageDigest: `sha256:${"4".repeat(64)}`,
      },
    },
    promotedRuntimeConfigurationHashes: {
      api: "5".repeat(64),
      interactive: "6".repeat(64),
      deep: "7".repeat(64),
      semantic: "f".repeat(64),
    },
    backendConvergenceEvidenceHash: "8".repeat(64),
    completedAt: "2026-08-02T18:00:00.000Z",
  } as const;
  return { ...unsigned, receiptHash: signedArtifactSha256(unsigned) };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "native-promotion-authority-"));
  const keys = generateKeyPairSync("ed25519");
  const promotionReceiptPath = join(directory, "promotion.json");
  const signingKeyPath = join(directory, "release-private.pem");
  const outputPath = join(directory, "authority.json");
  await Promise.all([
    writeFile(promotionReceiptPath, JSON.stringify(promotionReceipt())),
    writeFile(
      signingKeyPath,
      keys.privateKey.export({ format: "pem", type: "pkcs8" }),
    ),
  ]);
  const keySha256 = createHash("sha256")
    .update(keys.publicKey.export({ format: "der", type: "spki" }))
    .digest("hex");
  return {
    directory,
    keys,
    keySha256,
    args: {
      promotionReceiptPath,
      candidateTag: "v2.5.4-rc.1",
      expectedSourceRevision: "a".repeat(40),
      expectedVersion: "2.5.4",
      expectedImageDigest: `sha256:${"b".repeat(64)}`,
      priorSites: {
        projectId: "appgprj_6a5565cf7d6c8191ab9f2084e8eda856",
        versionId: "site-version-previous",
        deploymentId: "site-deployment-previous",
        version: "2.5.3",
        sourceRevision: "9".repeat(40),
        controlPlaneEvidenceHash: "a".repeat(64),
      },
      signingKeyPath,
      keyId: "release-verification-v1",
      expectedKeySha256: keySha256,
      outputPath,
    },
  };
}

describe("native schema-20 rollout promotion authority producer", () => {
  test("emits an immutable signed candidate and prior-Sites binding", async () => {
    const value = await fixture();
    const produced = await produceNativeSchema20RolloutPromotionAuthorityV1(
      value.args,
      new Date("2026-08-02T18:30:00.000Z"),
    );
    const output = JSON.parse(await readFile(value.args.outputPath, "utf8"));
    expect(output).toEqual(produced.signed);
    expect(output.payload).toMatchObject({
      candidate: {
        tag: "v2.5.4-rc.1",
        sourceRevision: "a".repeat(40),
      },
      nativePromotion: { receiptHash: promotionReceipt().receiptHash },
      sites: {
        candidateMatched: false,
        sourceRevision: "9".repeat(40),
      },
    });
  });

  test("rejects a signing key outside the protected fingerprint", async () => {
    const value = await fixture();
    await expect(produceNativeSchema20RolloutPromotionAuthorityV1({
      ...value.args,
      expectedKeySha256: "0".repeat(64),
    }, new Date("2026-08-02T18:30:00.000Z"))).rejects.toThrow(
      /protected release key/u,
    );
  });

  test("requires a complete, closed CLI argument set", () => {
    expect(() => parseNativePromotionAuthorityProducerArgsV1([
      "--candidate-tag", "v2.5.4-rc.1",
    ])).toThrow(/arguments are incomplete/u);
  });
});
