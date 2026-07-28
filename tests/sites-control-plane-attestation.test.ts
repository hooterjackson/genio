import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  SIGNED_SITES_CONTROL_PLANE_ATTESTATION_SCHEMA_V1,
  SITES_CONTROL_PLANE_ATTESTATION_SCHEMA_V1,
  SITES_CONTROL_PLANE_ISSUER_V1,
  sitesControlPlaneKeyFingerprint,
  verifySitesControlPlaneAttestation,
} from "../shared/sites-control-plane-attestation.ts";
import { createStrictSignedEnvelope } from "../shared/signed-artifact.ts";

const receiptHash = "a".repeat(64);
const keys = generateKeyPairSync("ed25519");
const otherKeys = generateKeyPairSync("ed25519");
const keyId = "sites-control-plane-test-v1";

function envelope() {
  return createStrictSignedEnvelope({
    envelopeSchemaVersion: SIGNED_SITES_CONTROL_PLANE_ATTESTATION_SCHEMA_V1,
    payload: {
      schemaVersion: SITES_CONTROL_PLANE_ATTESTATION_SCHEMA_V1,
      generatedAt: "2026-07-24T12:00:00.000Z",
      expiresAt: "2026-07-24T13:00:00.000Z",
      issuer: SITES_CONTROL_PLANE_ISSUER_V1,
      operation: "production_deployment_ready",
      receiptHash,
    },
    signingKey: keys.privateKey,
    keyId,
  });
}

describe("detached Sites control-plane attestation", () => {
  test("requires the protected connector key and exact deployment receipt", () => {
    const fingerprint = sitesControlPlaneKeyFingerprint(keys.publicKey);
    expect(verifySitesControlPlaneAttestation({
      value: envelope(),
      verificationKey: keys.publicKey,
      expectedReceiptHash: receiptHash,
      expectedKeyId: keyId,
      expectedKeyFingerprint: fingerprint,
      now: "2026-07-24T12:30:00.000Z",
    })).toMatchObject({
      keyId,
      verificationKeyFingerprint: fingerprint,
      payload: { receiptHash },
    });
    expect(() => verifySitesControlPlaneAttestation({
      value: envelope(),
      verificationKey: otherKeys.publicKey,
      expectedReceiptHash: receiptHash,
      expectedKeyId: keyId,
      expectedKeyFingerprint: fingerprint,
      now: "2026-07-24T12:30:00.000Z",
    })).toThrow(/protected trusted key/u);
    expect(() => verifySitesControlPlaneAttestation({
      value: envelope(),
      verificationKey: keys.publicKey,
      expectedReceiptHash: "b".repeat(64),
      expectedKeyId: keyId,
      expectedKeyFingerprint: fingerprint,
      now: "2026-07-24T12:30:00.000Z",
    })).toThrow(/does not bind/u);
  });

  test("fails closed on missing trust pins and expired evidence", () => {
    expect(() => verifySitesControlPlaneAttestation({
      value: envelope(),
      verificationKey: keys.publicKey,
      expectedReceiptHash: receiptHash,
      expectedKeyId: "",
      expectedKeyFingerprint: sitesControlPlaneKeyFingerprint(keys.publicKey),
      now: "2026-07-24T12:30:00.000Z",
    })).toThrow(/key ID/u);
    expect(() => verifySitesControlPlaneAttestation({
      value: envelope(),
      verificationKey: keys.publicKey,
      expectedReceiptHash: receiptHash,
      expectedKeyId: keyId,
      expectedKeyFingerprint: sitesControlPlaneKeyFingerprint(keys.publicKey),
      now: "2026-07-24T13:00:00.000Z",
    })).toThrow(/not currently valid/u);
  });
});
