import { createHash, generateKeyPairSync } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  authorizeOfflineReleaseGate,
  parseOfflineReleaseGateAuthorizationArgs,
  type OfflineGithubVerifier,
} from "../scripts/authorize-offline-release-gate.ts";
import {
  RELEASE_ATTESTATION_PREDICATE_TYPE,
  RELEASE_ATTESTATION_REPOSITORY,
  RELEASE_ATTESTATION_SOURCE_REF,
  RELEASE_ATTESTATION_WORKFLOW,
  validateGithubOfflineAttestationBinding,
} from "../scripts/github-offline-attestation.ts";
import {
  createOfflineReleaseGateArtifact,
  validateReleaseGateArtifact,
  verifyReleaseGateProducerAttestation,
} from "../scripts/release-fixtures.ts";

const revision = "a".repeat(40);

function command(directory: string): string[] {
  return [
    "--confirm-protected-offline-authorization",
    "--artifact", join(directory, "offline.json"),
    "--github-bundle", join(directory, "sigstore.json"),
    "--github-binding", join(directory, "binding.json"),
    "--output", join(directory, "producer-attestation.json"),
    "--producer-signing-key", join(directory, "producer-private.pem"),
    "--producer-key-id", "protected-offline-authorizer-v1",
  ];
}

describe("protected offline release gate authorization", () => {
  test("requires explicit confirmation and exact arguments", () => {
    expect(() => parseOfflineReleaseGateAuthorizationArgs([
      ...command("/tmp").slice(1),
    ])).toThrow(/confirm-protected-offline-authorization/u);
    expect(() => parseOfflineReleaseGateAuthorizationArgs([
      ...command("/tmp"),
      "--passed", "true",
    ])).toThrow(/Unknown argument/u);
  });

  test("verifies GitHub keyless provenance before issuing the detached producer attestation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "genio-offline-authorize-"));
    const keys = generateKeyPairSync("ed25519");
    try {
      const args = parseOfflineReleaseGateAuthorizationArgs(command(directory));
      const artifact = createOfflineReleaseGateArtifact({
        candidate: {
          tag: "v2.4.0-rc.2",
          version: "2.4.0",
          sourceRevision: revision,
          imageDigest: `sha256:${"b".repeat(64)}`,
          sitesSourceRevision: revision,
        },
        completedAt: "2026-07-24T12:00:00.000Z",
        workflow: {
          repository: RELEASE_ATTESTATION_REPOSITORY,
          runId: "123456789",
          runAttempt: "1",
          sha: revision,
          refName: "v2.4.0-rc.2",
        },
      });
      const artifactBytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
      const binding = {
        schemaVersion: "genio-release-offline-attestation-binding/v1",
        repository: RELEASE_ATTESTATION_REPOSITORY,
        workflow: RELEASE_ATTESTATION_WORKFLOW,
        workflowRef: RELEASE_ATTESTATION_SOURCE_REF,
        workflowSha: revision,
        candidateSourceRevision: revision,
        artifactSha256:
          createHash("sha256").update(artifactBytes).digest("hex"),
        predicateType: RELEASE_ATTESTATION_PREDICATE_TYPE,
      };
      writeFileSync(args.artifactPath, artifactBytes);
      writeFileSync(args.githubBundlePath, "{}");
      writeFileSync(args.githubBindingPath, JSON.stringify(binding));
      writeFileSync(
        args.producerSigningKeyPath,
        keys.privateKey.export({ format: "pem", type: "pkcs8" }),
      );
      let verified = false;
      const verifier: OfflineGithubVerifier = async (input) => {
        expect(input.artifactPath).toBe(args.artifactPath);
        expect(input.bundlePath).toBe(args.githubBundlePath);
        const exactArtifact = validateReleaseGateArtifact(
          JSON.parse(readFileSync(input.artifactPath, "utf8")),
        );
        const exactBinding = validateGithubOfflineAttestationBinding(
          input.bindingValue,
          exactArtifact,
        );
        verified = true;
        return { artifact: exactArtifact, binding: exactBinding };
      };
      const attestation = await authorizeOfflineReleaseGate(args, verifier);
      expect(verified).toBe(true);
      expect(verifyReleaseGateProducerAttestation(
        JSON.parse(readFileSync(args.outputPath, "utf8")),
        artifact,
        keys.publicKey,
      )).toEqual(attestation);
      await expect(authorizeOfflineReleaseGate(args, verifier))
        .rejects.toThrow(/output already exists/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("does not sign when the independent GitHub verifier rejects", async () => {
    const directory = mkdtempSync(join(tmpdir(), "genio-offline-authorize-"));
    const keys = generateKeyPairSync("ed25519");
    try {
      const args = parseOfflineReleaseGateAuthorizationArgs(command(directory));
      writeFileSync(args.githubBindingPath, "{}");
      writeFileSync(
        args.producerSigningKeyPath,
        keys.privateKey.export({ format: "pem", type: "pkcs8" }),
      );
      await expect(authorizeOfflineReleaseGate(args, async () => {
        throw new Error("Sigstore proof rejected");
      })).rejects.toThrow(/Sigstore proof rejected/u);
      expect(() => readFileSync(args.outputPath)).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
