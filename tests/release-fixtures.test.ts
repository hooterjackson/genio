import { describe, expect, test } from "vitest";
import {
  releaseFixtureSha256,
  RELEASE_FIXTURES,
  createOfflineReleaseGateArtifact,
  matchPromotableReleaseFixture,
  releaseFixtureBindingsForGate,
  releaseFixturePrompt,
  validateSitesControlPlaneSource,
  validateReleaseGateArtifact,
} from "../scripts/release-fixtures.ts";
import {
  createSitesProductionRollbackTargetV1,
} from "../shared/sites-production-rollback.ts";

const candidate = {
  tag: "v2.4.0-rc.2",
  version: "2.4.0",
  sourceRevision: "a".repeat(40),
  imageDigest: `sha256:${"b".repeat(64)}`,
  sitesSourceRevision: "a".repeat(40),
};

describe("immutable release fixtures", () => {
  test("recognizes only exact code-owned prompts, counts, and guidance modes", () => {
    const fixture = RELEASE_FIXTURES["smooth-reggaeton-heat-50-v1"];
    expect(matchPromotableReleaseFixture({
      prompt: releaseFixturePrompt("smooth-reggaeton-heat-50-v1"),
      targetTrackCount: 50,
      guidanceMode: "recommended",
    })).toEqual(fixture);
    expect(fixture).toMatchObject({
      targetTrackCount: 50,
      guidanceMode: "recommended",
      fixtureHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      promptHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      guidanceSemanticsHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(matchPromotableReleaseFixture({
      prompt: `${releaseFixturePrompt("smooth-reggaeton-heat-50-v1")} Add a filler track.`,
      targetTrackCount: 50,
      guidanceMode: "recommended",
    })).toBeNull();
    expect(matchPromotableReleaseFixture({
      prompt: releaseFixturePrompt("smooth-reggaeton-heat-50-v1"),
      targetTrackCount: 49,
      guidanceMode: "recommended",
    })).toBeNull();
    expect(matchPromotableReleaseFixture({
      prompt: releaseFixturePrompt("smooth-reggaeton-heat-50-v1"),
      targetTrackCount: 50,
      guidanceMode: "not_applicable",
    })).toBeNull();
  });

  test("binds the reggaeton promotion fixture to guidance lineage and >=70% semantics", () => {
    const fixtures = releaseFixtureBindingsForGate("staging_affected_regression", {
      "smooth-reggaeton-heat-50-v1": "c".repeat(64),
    });
    expect(fixtures).toEqual([{
      ...RELEASE_FIXTURES["smooth-reggaeton-heat-50-v1"],
      guidanceLineageHash: "c".repeat(64),
    }]);
    expect(() => releaseFixtureBindingsForGate("staging_affected_regression"))
      .toThrow(/requires a guidance lineage hash/u);
  });

  test("recomputes typed inner and outer hashes instead of trusting opaque evidence", () => {
    const artifact = createOfflineReleaseGateArtifact({
      completedAt: "2026-07-23T12:00:00.000Z",
      candidate,
      workflow: {
        repository: "hooterjackson/genio",
        runId: "30035354716",
        runAttempt: "1",
        sha: candidate.sourceRevision,
        refName: candidate.tag,
      },
    });
    expect(validateReleaseGateArtifact(artifact)).toEqual(artifact);
    expect(artifact).not.toHaveProperty("rawPrompt");
    expect(artifact).not.toHaveProperty("customAnswer");

    expect(() => validateReleaseGateArtifact({
      ...artifact,
      proof: {
        ...artifact.proof,
        assertions: {
          ...artifact.proof.assertions,
          build: false,
        },
      },
    })).toThrow(/unsuccessful assertion|proof hash/u);
    expect(() => validateReleaseGateArtifact({
      ...artifact,
      evidenceHash: "0".repeat(64),
    })).toThrow(/evidence hash does not match/u);
  });

  test("requires the exact prior saved Sites version to be captured before deployment", () => {
    const rollbackTarget = createSitesProductionRollbackTargetV1({
      capturedAt: "2026-07-23T12:30:00.000Z",
      projectId: "opaque-project-id",
      productionUrl: "https://9enio.com",
      plannedCandidate: {
        commitSha: candidate.sitesSourceRevision,
        buildVersion: candidate.version,
      },
      previous: {
        versionId: "opaque-prior-version-id",
        versionNumber: 80,
        commitSha: "f".repeat(40),
        archiveSha256: "e".repeat(64),
        deploymentId: "opaque-prior-deployment-id",
        deploymentStatus: "succeeded",
        controlPlaneObservedAt: "2026-07-23T12:29:00.000Z",
        liveObservedAt: "2026-07-23T12:29:30.000Z",
        liveBuildVersion: "2.3.9",
        liveBuildRevision: "f".repeat(40),
      },
    });
    const unsigned = {
      schemaVersion: "genio-sites-control-plane-deployment/v2",
      projectId: "opaque-project-id",
      versionId: "opaque-candidate-version-id",
      versionNumber: 81,
      archiveSha256: "d".repeat(64),
      deploymentId: "opaque-candidate-deployment-id",
      commitSha: candidate.sitesSourceRevision,
      buildVersion: candidate.version,
      productionUrl: "https://9enio.com",
      status: "succeeded",
      deploymentRequestedAt: "2026-07-23T12:31:00.000Z",
      observedAt: "2026-07-23T12:35:00.000Z",
      rollbackTarget,
    };
    const receipt = {
      ...unsigned,
      evidenceHash: releaseFixtureSha256(unsigned),
    };
    expect(validateSitesControlPlaneSource(receipt, candidate))
      .toEqual(rollbackTarget);

    const reordered = {
      ...unsigned,
      deploymentRequestedAt: "2026-07-23T12:29:00.000Z",
    };
    expect(() => validateSitesControlPlaneSource({
      ...reordered,
      evidenceHash: releaseFixtureSha256(reordered),
    }, candidate)).toThrow(/does not bind the production candidate/u);

    const substituted = {
      ...unsigned,
      projectId: "another-project-id",
    };
    expect(() => validateSitesControlPlaneSource({
      ...substituted,
      evidenceHash: releaseFixtureSha256(substituted),
    }, candidate)).toThrow(/does not bind the production candidate/u);
  });
});
