import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  sitesControlPlaneKeyFingerprint,
  sitesControlPlaneTrustPolicyV1,
  sitesControlPlaneVerificationKeyV1,
} from "../shared/sites-control-plane-attestation.ts";
import { createStrictSignedEnvelope } from "../shared/signed-artifact.ts";
import {
  createSitesProductionRollbackTargetV1,
} from "../shared/sites-production-rollback.ts";
import {
  parseReleaseConvergenceProducerArgs,
} from "../scripts/release-convergence-producer.ts";
import {
  parseHistoricalReplayReleaseProducerArgs,
} from "../scripts/historical-browser-replay-release-producer.ts";
import {
  parseFinalCustomDomainBrowserProducerArgs,
  validatePublicPlaylistDirectoryDto,
} from "../scripts/final-custom-domain-browser-producer.ts";
import {
  emitReleaseGateProducerArtifacts,
  preflightReleaseProducerFiles,
  releaseProducerCandidate,
} from "../scripts/release-gate-producer.ts";
import {
  releaseFixtureSha256,
  validateReleaseGateArtifact,
  verifyReleaseGateProducerAttestation,
} from "../scripts/release-fixtures.ts";

const revision = "a".repeat(40);
const imageDigest = `sha256:${"b".repeat(64)}`;

function producerFiles(): string[] {
  return [
    "--runtime-snapshot", "/tmp/production-runtime.json",
    "--source-output", "/tmp/source.json",
    "--output", "/tmp/gate.json",
    "--attestation-output", "/tmp/gate.attestation.json",
    "--producer-signing-key", "/tmp/producer-private.pem",
    "--producer-key-id", "production-producer-v1",
  ];
}

describe("live release gate producers", () => {
  test("binds an immutable RC candidate identity", () => {
    expect(releaseProducerCandidate({
      tag: "v2.4.0-rc.2",
      version: "2.4.0",
      sourceRevision: revision.toUpperCase(),
      imageDigest,
    })).toEqual({
      tag: "v2.4.0-rc.2",
      version: "2.4.0",
      sourceRevision: revision,
      imageDigest,
      sitesSourceRevision: revision,
    });
    expect(() => releaseProducerCandidate({
      tag: "v2.4.0",
      version: "2.4.0",
      sourceRevision: revision,
      imageDigest,
    })).toThrow(/candidate identity/u);
  });

  test("convergence producer is production-only and requires detached signing inputs", () => {
    const argv = [
      "--confirm-production-probe",
      "--origin", "https://9enio.com",
      "--scope", "full",
      "--expected-revision", revision,
      "--expected-version", "2.4.0",
      "--expected-sites-revision", revision,
      "--expected-sites-version", "2.4.0",
      "--candidate-tag", "v2.4.0-rc.2",
      "--image-digest", imageDigest,
      "--samples", "2",
      "--interval-seconds", "30",
      ...producerFiles(),
    ];
    expect(parseReleaseConvergenceProducerArgs(argv, {
      RELEASE_PRODUCTION_ORIGIN: "https://9enio.com",
    })).toMatchObject({
      origin: "https://9enio.com",
      scope: "full",
      expectedRevision: revision,
      expectedSitesRevision: revision,
      samples: 2,
      intervalMs: 30_000,
    });
    const missingKey = [...argv];
    missingKey.splice(missingKey.indexOf("--producer-signing-key"), 2);
    expect(() => parseReleaseConvergenceProducerArgs(
      missingKey,
      { RELEASE_PRODUCTION_ORIGIN: "https://9enio.com" },
    )).toThrow(/producer-signing-key/u);
    expect(() => parseReleaseConvergenceProducerArgs(
      argv,
      { RELEASE_PRODUCTION_ORIGIN: "https://staging.9enio.example" },
    )).toThrow(/9enio.com production origin/u);
  });

  test("historical replay producer is staging-only and requires the detached aggregate", () => {
    const argv = [
      "--origin", "https://staging.9enio.example",
      "--expected-revision", revision,
      "--expected-version", "2.4.0",
      "--candidate-tag", "v2.4.0-rc.2",
      "--image-digest", imageDigest,
      "--runtime-snapshot", "/tmp/staging-runtime.json",
      "--staging-control-plane-evidence", "/tmp/control.json",
      "--staging-control-plane-verification-key", "/tmp/control.pub",
      "--staging-control-plane-trust-policy", "/tmp/control-trust.json",
      "--historical-replay-evidence", "/tmp/historical.json",
      "--historical-replay-verification-key", "/tmp/historical.pub",
      "--historical-replay-trust-policy", "/tmp/historical-trust.json",
      "--source-output", "/tmp/source.json",
      "--output", "/tmp/gate.json",
      "--attestation-output", "/tmp/gate.attestation.json",
      "--producer-signing-key", "/tmp/producer-private.pem",
      "--producer-key-id", "staging-producer-v1",
    ];
    expect(parseHistoricalReplayReleaseProducerArgs(argv, {
      RELEASE_STAGING_ORIGIN: "https://staging.9enio.example",
      RELEASE_PRODUCTION_ORIGIN: "https://9enio.com",
      RELEASE_HISTORICAL_REPLAY_KEY_ID: "historical-replay-v1",
      RELEASE_HISTORICAL_REPLAY_KEY_SHA256: "d".repeat(64),
    })).toMatchObject({
      origin: "https://staging.9enio.example",
      expectedRevision: revision,
      historicalReplayEvidencePath: "/tmp/historical.json",
    });
    expect(() => parseHistoricalReplayReleaseProducerArgs(argv, {
      RELEASE_STAGING_ORIGIN: "https://9enio.com",
      RELEASE_PRODUCTION_ORIGIN: "https://9enio.com",
      RELEASE_HISTORICAL_REPLAY_KEY_ID: "historical-replay-v1",
      RELEASE_HISTORICAL_REPLAY_KEY_SHA256: "d".repeat(64),
    })).toThrow(/non-production/u);
    const missingReplayEvidence = [...argv];
    missingReplayEvidence.splice(
      missingReplayEvidence.indexOf("--historical-replay-evidence"),
      2,
    );
    expect(() => parseHistoricalReplayReleaseProducerArgs(
      missingReplayEvidence,
      {
        RELEASE_STAGING_ORIGIN: "https://staging.9enio.example",
        RELEASE_PRODUCTION_ORIGIN: "https://9enio.com",
        RELEASE_HISTORICAL_REPLAY_KEY_ID: "historical-replay-v1",
        RELEASE_HISTORICAL_REPLAY_KEY_SHA256: "d".repeat(64),
      },
    )).toThrow(/historical-replay-evidence/u);
    expect(() => parseHistoricalReplayReleaseProducerArgs(argv, {
      RELEASE_STAGING_ORIGIN: "https://staging.9enio.example",
      RELEASE_PRODUCTION_ORIGIN: "https://9enio.com",
    })).toThrow(/approved release gate producer identity/u);
  });

  test("final browser producer requires actual Sites control-plane evidence input", () => {
    const trustedSitesEnvironment = {
      RELEASE_PRODUCTION_ORIGIN: "https://9enio.com",
      RELEASE_SITES_CONTROL_PLANE_KEY_SHA256: "d".repeat(64),
      RELEASE_SITES_CONTROL_PLANE_KEY_ID: "sites-connector-v1",
    };
    const base = [
      "--confirm-production-browser",
      "--origin", "https://9enio.com",
      "--expected-revision", revision,
      "--expected-version", "2.4.0",
      "--candidate-tag", "v2.4.0-rc.2",
      "--image-digest", imageDigest,
      "--browser-artifact-dir", "/tmp/browser-evidence",
      ...producerFiles(),
    ];
    expect(() => parseFinalCustomDomainBrowserProducerArgs(
      base,
      trustedSitesEnvironment,
    )).toThrow(/sites-control-plane-evidence/u);
    expect(parseFinalCustomDomainBrowserProducerArgs([
      ...base,
      "--sites-control-plane-evidence", "/tmp/sites-control-plane.json",
      "--sites-control-plane-attestation", "/tmp/sites-attestation.json",
      "--sites-control-plane-verification-key", "/tmp/sites-public.pem",
    ], trustedSitesEnvironment)).toMatchObject({
      origin: "https://9enio.com",
      sitesControlPlaneEvidencePath: "/tmp/sites-control-plane.json",
      sitesControlPlaneAttestationPath: "/tmp/sites-attestation.json",
      sitesControlPlaneVerificationKeyPath: "/tmp/sites-public.pem",
      trustedSitesControlPlaneKeyFingerprint: "d".repeat(64),
      trustedSitesControlPlaneKeyId: "sites-connector-v1",
    });
    expect(() => parseFinalCustomDomainBrowserProducerArgs([
      ...base,
      "--sites-control-plane-evidence", "/tmp/sites-control-plane.json",
      "--sites-control-plane-attestation", "/tmp/sites-attestation.json",
      "--sites-control-plane-verification-key", "/tmp/sites-public.pem",
    ], {
      RELEASE_PRODUCTION_ORIGIN: "https://9enio.com",
    })).toThrow(/protected Sites control-plane key/u);
    const publicDirectory = {
      items: [{
        id: "00000000-0000-4000-a000-000000000001",
        title: "Public title",
        trackCount: 3,
        volumeCount: 1,
        publishedAt: "2026-07-24T12:00:00.000Z",
        volumes: [{
          volumeNumber: 1,
          name: "Public title",
          trackCount: 3,
          shareUrl: "https://music.apple.com/us/playlist/public-title/pl.abc123",
        }],
      }],
      page: 1,
      pageSize: 12,
      total: 1,
      totalPages: 1,
    };
    expect(validatePublicPlaylistDirectoryDto(publicDirectory)).toEqual({
      firstTitle: "Public title",
      itemCount: 1,
    });
    for (const privateField of [
      "runId",
      "evidence",
      "cost",
      "manifestDescription",
      "applePlaylistId",
      "appleLibraryPlaylistId",
    ]) {
      expect(() => validatePublicPlaylistDirectoryDto({
        ...publicDirectory,
        items: [{
          ...publicDirectory.items[0],
          [privateField]: privateField,
        }],
      })).toThrow(/non-public fields/u);
    }
  });

  test("emits separate typed source, gate, and producer attestation files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "genio-producer-test-"));
    const privateKeyPath = join(directory, "producer-private.pem");
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const sitesKeys = generateKeyPairSync("ed25519");
    await writeFile(privateKeyPath, privateKey.export({
      format: "pem",
      type: "pkcs8",
    }));
    const candidate = releaseProducerCandidate({
      tag: "v2.4.0-rc.2",
      version: "2.4.0",
      sourceRevision: revision,
      imageDigest,
    });
    const observedAt = new Date().toISOString();
    const browserUnsigned = {
      schemaVersion: "genio-final-custom-domain-browser/v1",
      origin: "https://9enio.com",
      candidateRevision: revision,
      observedAt,
      tlsValid: true,
      releaseIdentityVisible: true,
      anonymousPlaylistDirectory: true,
      publicPlaylistContentsVisible: true,
      privacyProjectionPassed: true,
      screenshotHashes: ["c".repeat(64)],
    };
    const priorRevision = "f".repeat(40);
    const rollbackTarget = createSitesProductionRollbackTargetV1({
      capturedAt: new Date(Date.parse(observedAt) - 60_000).toISOString(),
      projectId: "actual-project-id",
      productionUrl: "https://9enio.com",
      plannedCandidate: {
        commitSha: revision,
        buildVersion: "2.4.0",
      },
      previous: {
        versionId: "actual-prior-version-id",
        versionNumber: 81,
        commitSha: priorRevision,
        archiveSha256: "e".repeat(64),
        deploymentId: "actual-prior-deployment-id",
        deploymentStatus: "succeeded",
        controlPlaneObservedAt:
          new Date(Date.parse(observedAt) - 120_000).toISOString(),
        liveObservedAt:
          new Date(Date.parse(observedAt) - 90_000).toISOString(),
        liveBuildVersion: "2.3.9",
        liveBuildRevision: priorRevision,
      },
    });
    const controlPlaneUnsigned = {
      schemaVersion: "genio-sites-control-plane-deployment/v2",
      projectId: "actual-project-id",
      versionId: "actual-version-id",
      versionNumber: 82,
      archiveSha256: "d".repeat(64),
      deploymentId: "actual-deployment-id",
      commitSha: revision,
      buildVersion: "2.4.0",
      productionUrl: "https://9enio.com",
      status: "ready",
      deploymentRequestedAt:
        new Date(Date.parse(observedAt) - 30_000).toISOString(),
      observedAt,
      rollbackTarget,
    };
    const controlPlane = {
      ...controlPlaneUnsigned,
      evidenceHash: releaseFixtureSha256(controlPlaneUnsigned),
    };
    const sitesAttestationPayload = {
      schemaVersion: "genio-sites-control-plane-attestation/v1",
      generatedAt: observedAt,
      expiresAt: new Date(Date.parse(observedAt) + 60 * 60_000).toISOString(),
      issuer: "openai-sites-control-plane",
      operation: "production_deployment_ready",
      receiptHash: controlPlane.evidenceHash,
    };
    const sitesAttestation = createStrictSignedEnvelope({
      envelopeSchemaVersion:
        "genio-signed-sites-control-plane-attestation/v1",
      payload: sitesAttestationPayload,
      signingKey: sitesKeys.privateKey,
      keyId: "sites-connector-v1",
    });
    const sitesKeyFingerprint =
      sitesControlPlaneKeyFingerprint(sitesKeys.publicKey);
    const sitesTrustUnsigned = {
      schemaVersion: "genio-sites-control-plane-trust-verification/v1",
      receiptHash: controlPlane.evidenceHash,
      attestationPayloadHash: sitesAttestation.payloadHash,
      trustedKeyId: sitesAttestation.signature.keyId,
      verificationKeyFingerprint: sitesKeyFingerprint,
      verifiedAt: observedAt,
    };
    const sourceOutputPath = join(directory, "source.json");
    const artifactOutputPath = join(directory, "artifact.json");
    const attestationOutputPath = join(directory, "attestation.json");
    const produced = await emitReleaseGateProducerArtifacts({
      gate: "final_custom_domain_browser",
      completedAt: observedAt,
      candidate,
      runtimeSnapshot: {
        schemaVersion: "genio-release-runtime-snapshot/v2",
        generatedAt: observedAt,
        origin: "https://9enio.com",
        environment: "production",
        scope: "full",
        candidate: { version: "2.4.0", sourceRevision: revision },
        sitesObservation: {
          version: "2.4.0",
          sourceRevision: revision,
          configurationHash: "4".repeat(64),
          ownerAllowlistVersion: "owner-allowlist-v1",
          candidateMatched: true,
        },
        configuration: {} as never,
        runtime: {} as never,
        credentialVersionHashes: {
          provider: "1".repeat(64),
          apple: "2".repeat(64),
          appleQaVerifier: "3".repeat(64),
        },
        configurationHash: "4".repeat(64),
        runtimeHash: "5".repeat(64),
        snapshotHash: "6".repeat(64),
      },
      fixtures: [],
      sources: {
        browser: {
          ...browserUnsigned,
          evidenceHash: releaseFixtureSha256(browserUnsigned),
        },
        sitesControlPlane: controlPlane,
        sitesControlPlaneAttestation: sitesAttestation,
        sitesControlPlaneTrust: {
          ...sitesTrustUnsigned,
          evidenceHash: releaseFixtureSha256(sitesTrustUnsigned),
        },
        sitesControlPlaneVerificationKey:
          sitesControlPlaneVerificationKeyV1(sitesKeys.publicKey),
        sitesControlPlaneTrustPolicy: sitesControlPlaneTrustPolicyV1({
          approvedKeyId: sitesAttestation.signature.keyId,
          approvedKeySha256: sitesKeyFingerprint,
        }),
      },
      files: {
        sourceOutputPath,
        artifactOutputPath,
        attestationOutputPath,
        producerSigningKeyPath: privateKeyPath,
        producerKeyId: "production-producer-v1",
      },
    });
    const artifact = validateReleaseGateArtifact(JSON.parse(
      await readFile(artifactOutputPath, "utf8"),
    ));
    const attestation = JSON.parse(await readFile(attestationOutputPath, "utf8"));
    expect(artifact).toEqual(produced.artifact);
    expect(verifyReleaseGateProducerAttestation(
      attestation,
      artifact,
      publicKey,
    )).toEqual(produced.attestation);
    expect(JSON.parse(await readFile(sourceOutputPath, "utf8"))).toMatchObject({
      schemaVersion: "genio-release-gate-producer-source/v1",
      gate: "final_custom_domain_browser",
      candidate,
      runtimeSnapshotHash: "6".repeat(64),
      credentialVersionHashes: {
        provider: "1".repeat(64),
        apple: "2".repeat(64),
        appleQaVerifier: "3".repeat(64),
      },
      sourceHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
  });

  test("preflights the producer key and immutable output paths before live work", async () => {
    const directory = await mkdtemp(join(tmpdir(), "genio-preflight-test-"));
    const privateKeyPath = join(directory, "producer-private.pem");
    const { privateKey } = generateKeyPairSync("ed25519");
    await writeFile(privateKeyPath, privateKey.export({
      format: "pem",
      type: "pkcs8",
    }));
    await expect(preflightReleaseProducerFiles({
      sourceOutputPath: join(directory, "source.json"),
      artifactOutputPath: join(directory, "artifact.json"),
      attestationOutputPath: join(directory, "attestation.json"),
      producerSigningKeyPath: privateKeyPath,
      producerKeyId: "production-producer-v1",
    })).resolves.toBeUndefined();
    await expect(preflightReleaseProducerFiles({
      sourceOutputPath: join(directory, "same.json"),
      artifactOutputPath: join(directory, "same.json"),
      attestationOutputPath: join(directory, "attestation.json"),
      producerSigningKeyPath: privateKeyPath,
      producerKeyId: "production-producer-v1",
    })).rejects.toThrow(/output paths must be distinct/u);
    await expect(preflightReleaseProducerFiles({
      sourceOutputPath: join(directory, "source.json"),
      artifactOutputPath: join(directory, "artifact.json"),
      attestationOutputPath: join(directory, "attestation.json"),
      producerSigningKeyPath: join(directory, "missing.pem"),
      producerKeyId: "production-producer-v1",
    })).rejects.toThrow(/readable Ed25519/u);
  });
});
