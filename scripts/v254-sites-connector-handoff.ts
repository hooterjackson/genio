import { createHash, createPublicKey } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  releaseProducerCandidate,
  releaseProducerOption,
} from "./release-gate-producer.ts";
import {
  releaseFixtureSha256,
  validateSitesControlPlaneSource,
} from "./release-fixtures.ts";
import {
  sitesControlPlaneKeyFingerprint,
  verifySitesControlPlaneAttestation,
} from "../shared/sites-control-plane-attestation.ts";

const PROJECT_ID = "appgprj_6a5565cf7d6c8191ab9f2084e8eda856";
const KEY_ID = /^[0-9A-Za-z][0-9A-Za-z._:+/-]{2,159}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

async function json(path: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`${label} must identify connector-produced JSON`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const candidate = releaseProducerCandidate({
    tag: releaseProducerOption(argv, "--candidate-tag"),
    version: releaseProducerOption(argv, "--version"),
    sourceRevision:
      releaseProducerOption(argv, "--source-revision").toLowerCase(),
    imageDigest: releaseProducerOption(argv, "--image-digest"),
  });
  const projectId = releaseProducerOption(argv, "--project-id");
  const trustedKeyId =
    process.env.RELEASE_SITES_CONTROL_PLANE_TRUSTED_KEY_ID?.trim() ?? "";
  const trustedKeySha256 =
    process.env.RELEASE_SITES_CONTROL_PLANE_TRUSTED_KEY_SHA256?.trim() ?? "";
  if (
    projectId !== PROJECT_ID
    || !KEY_ID.test(trustedKeyId)
    || !SHA256.test(trustedKeySha256)
  ) {
    throw new Error("Sites connector handoff trust policy is invalid");
  }
  const evidencePath =
    releaseProducerOption(argv, "--sites-control-plane-evidence");
  const attestationPath =
    releaseProducerOption(argv, "--sites-control-plane-attestation");
  const publicKeyPath =
    releaseProducerOption(argv, "--sites-control-plane-public-key");
  const [evidence, attestation, publicKeyBytes] = await Promise.all([
    json(evidencePath, "Sites control-plane evidence"),
    json(attestationPath, "Sites control-plane attestation"),
    readFile(publicKeyPath),
  ]);
  const rollbackTarget = validateSitesControlPlaneSource(evidence, candidate);
  const evidenceRecord = evidence as Record<string, unknown>;
  if (
    evidenceRecord.projectId !== projectId
    || rollbackTarget.projectId !== projectId
  ) {
    throw new Error("Sites connector evidence targets another project");
  }
  const publicKey = createPublicKey(publicKeyBytes);
  const fingerprint = sitesControlPlaneKeyFingerprint(publicKey);
  if (fingerprint !== trustedKeySha256) {
    throw new Error("Sites connector verification key is not trusted");
  }
  const verified = verifySitesControlPlaneAttestation({
    value: attestation,
    verificationKey: publicKey,
    expectedReceiptHash: String(evidenceRecord.evidenceHash),
    expectedKeyId: trustedKeyId,
    expectedKeyFingerprint: trustedKeySha256,
  });
  const unsigned = {
    schemaVersion: "genio-v254-sites-connector-handoff/v1",
    candidate,
    projectId,
    connectorProduced: true,
    importedVia: "bounded_workflow_dispatch_input",
    sitesControlPlaneEvidenceHash: evidenceRecord.evidenceHash,
    sitesControlPlaneAttestationPayloadHash: verified.payloadHash,
    sitesControlPlaneAttestationHash:
      createHash("sha256")
        .update(JSON.stringify(attestation))
        .digest("hex"),
    trustedKeyId: verified.keyId,
    trustedKeySha256: verified.verificationKeyFingerprint,
    versionId: evidenceRecord.versionId,
    deploymentId: evidenceRecord.deploymentId,
    archiveSha256: evidenceRecord.archiveSha256,
    verifiedAt: new Date().toISOString(),
  };
  const output = {
    ...unsigned,
    handoffHash: releaseFixtureSha256(unsigned),
  };
  await writeFile(
    releaseProducerOption(argv, "--output"),
    `${JSON.stringify(output, null, 2)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  process.stdout.write(`${JSON.stringify({
    ok: true,
    projectId,
    sourceRevision: candidate.sourceRevision,
    handoffHash: output.handoffHash,
  })}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(() => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: "v254_sites_connector_handoff_failed",
      message: "Sites connector evidence handoff failed closed",
    })}\n`);
    process.exitCode = 1;
  });
}
