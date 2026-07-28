import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  RELEASE_ATTESTATION_PREDICATE_TYPE,
  RELEASE_ATTESTATION_REPOSITORY,
  RELEASE_ATTESTATION_SOURCE_REF,
  RELEASE_ATTESTATION_WORKFLOW,
  verifyGithubOfflineAttestation,
} from "../scripts/github-offline-attestation.ts";
import { createOfflineReleaseGateArtifact } from "../scripts/release-fixtures.ts";

const candidate = {
  tag: "v2.4.0-rc.2",
  version: "2.4.0",
  sourceRevision: "a".repeat(40),
  imageDigest: `sha256:${"b".repeat(64)}`,
  sitesSourceRevision: "a".repeat(40),
};

async function fixture(): Promise<{
  artifactPath: string;
  bundlePath: string;
  artifactSha256: string;
  artifact: ReturnType<typeof createOfflineReleaseGateArtifact>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "genio-github-attestation-"));
  const artifactPath = join(directory, "release-offline-suite.json");
  const bundlePath = join(directory, "attestation.json");
  const artifact = createOfflineReleaseGateArtifact({
    candidate,
    completedAt: "2026-07-24T12:00:00.000Z",
    workflow: {
      repository: RELEASE_ATTESTATION_REPOSITORY,
      runId: "123456789",
      runAttempt: "1",
      sha: candidate.sourceRevision,
      refName: candidate.tag,
    },
  });
  const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
  await Promise.all([
    writeFile(artifactPath, bytes),
    writeFile(bundlePath, "{}"),
  ]);
  return {
    artifactPath,
    bundlePath,
    artifactSha256: createHash("sha256").update(bytes).digest("hex"),
    artifact,
  };
}

function binding(artifactSha256: string) {
  return {
    schemaVersion: "genio-release-offline-attestation-binding/v1",
    repository: RELEASE_ATTESTATION_REPOSITORY,
    workflow: RELEASE_ATTESTATION_WORKFLOW,
    workflowRef: RELEASE_ATTESTATION_SOURCE_REF,
    workflowSha: candidate.sourceRevision,
    candidateSourceRevision: candidate.sourceRevision,
    artifactSha256,
    predicateType: RELEASE_ATTESTATION_PREDICATE_TYPE,
  };
}

describe("GitHub keyless offline release attestation", () => {
  test("pins the artifact, trusted workflow identity, source, runner, and issuer", async () => {
    const item = await fixture();
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    const result = await verifyGithubOfflineAttestation({
      artifactPath: item.artifactPath,
      bundlePath: item.bundlePath,
      bindingValue: binding(item.artifactSha256),
      runner: async (executable, args) => {
        calls.push({ executable, args });
        return {
          stdout: JSON.stringify([{
            verificationResult: {
              statement: {
                predicateType: RELEASE_ATTESTATION_PREDICATE_TYPE,
                subject: [{
                  name: "release-offline-suite.json",
                  digest: { sha256: item.artifactSha256 },
                }],
              },
              signature: { certificate: { issuer: "github-actions" } },
              verifiedTimestamps: [],
            },
          }]),
        };
      },
    });
    expect(result.artifact).toEqual(item.artifact);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.executable).toBe("gh");
    expect(calls[0]?.args).toEqual(expect.arrayContaining([
      "--repo",
      RELEASE_ATTESTATION_REPOSITORY,
      "--signer-workflow",
      RELEASE_ATTESTATION_WORKFLOW,
      "--source-ref",
      RELEASE_ATTESTATION_SOURCE_REF,
      "--source-digest",
      candidate.sourceRevision,
      "--deny-self-hosted-runners",
      "--no-public-good",
    ]));
  });

  test("rejects a different artifact, candidate source, or verified subject digest", async () => {
    const item = await fixture();
    await expect(verifyGithubOfflineAttestation({
      artifactPath: item.artifactPath,
      bundlePath: item.bundlePath,
      bindingValue: binding("0".repeat(64)),
      runner: async () => ({ stdout: "[]" }),
    })).rejects.toThrow(/artifact bytes do not match/u);

    await expect(verifyGithubOfflineAttestation({
      artifactPath: item.artifactPath,
      bundlePath: item.bundlePath,
      bindingValue: {
        ...binding(item.artifactSha256),
        workflowSha: "c".repeat(40),
      },
      runner: async () => ({ stdout: "[]" }),
    })).rejects.toThrow(/trusted workflow and candidate/u);

    await expect(verifyGithubOfflineAttestation({
      artifactPath: item.artifactPath,
      bundlePath: item.bundlePath,
      bindingValue: binding(item.artifactSha256),
      runner: async () => ({
        stdout: JSON.stringify([{
          verificationResult: {
            statement: {
              predicateType: RELEASE_ATTESTATION_PREDICATE_TYPE,
              subject: [{ digest: { sha256: "d".repeat(64) } }],
            },
            signature: { certificate: { issuer: "github-actions" } },
            verifiedTimestamps: [],
          },
        }]),
      }),
    })).rejects.toThrow(/does not bind the offline artifact/u);
  });
});
