import { describe, expect, test, vi } from "vitest";
import {
  createHostedWebEvidenceSnapshotV3,
  executeRetrievalV3,
  publicTrackScopeAttestationV3,
  type CandidateQualificationV3,
  type RawTrackCandidateV3,
  type RetrievalAdaptersV3,
} from "../server/pipeline-v3-retrieval.ts";
import { createQueryPlanV3 } from "../server/query-plan-v3.ts";
import {
  createRunSpecV3,
  evidenceMembershipPredicateIdsV3,
  resolveRunSpecV3,
} from "../server/selection-plan-v3.ts";
import {
  RIO_DISCO_INCIDENT_APPLE_CALL_COUNT,
  RIO_DISCO_INCIDENT_BAD_HARD_CONSTRAINTS,
  RIO_DISCO_INCIDENT_BAD_PREDICATES,
  RIO_DISCO_INCIDENT_CHECKPOINT,
  RIO_DISCO_INCIDENT_DUPLICATE_COUNT,
  RIO_DISCO_INCIDENT_OBSERVATIONS,
  RIO_DISCO_INCIDENT_PROMPT,
  RIO_DISCO_INCIDENT_REQUESTED_COUNT,
  RIO_DISCO_INCIDENT_VALID_COUNT,
  rioDiscoCompatibilityPlanFixture,
  type SanitizedRioDiscoObservation,
} from "./fixtures/rio-disco-scope-gate-incident.ts";

const GRAPH_SNAPSHOT_ID = "491e695c-a8a0-49c0-886f-72e6f2fa1870";
const HOSTED_TEST_ACQUIRED_AT = new Date(Date.now() - 60_000).toISOString();
const HOSTED_TEST_FRESH_UNTIL = new Date(
  Date.parse(HOSTED_TEST_ACQUIRED_AT) + 29 * 24 * 60 * 60_000,
).toISOString();

function compileCorrectedRioPlan() {
  const spec = createRunSpecV3({
    prompt: RIO_DISCO_INCIDENT_PROMPT,
    requestedTrackCount: RIO_DISCO_INCIDENT_REQUESTED_COUNT,
    storefront: "us",
    typedSelectionPlan: rioDiscoCompatibilityPlanFixture(),
  });
  expect(spec.criticalAmbiguities).toEqual([]);
  return resolveRunSpecV3(spec, []);
}

function rawCandidate(observation: SanitizedRioDiscoObservation): RawTrackCandidateV3 {
  return {
    id: observation.id,
    artist: observation.artist,
    title: observation.title,
    album: observation.album,
    sourceObservationIds: observation.sourceObservationIds,
    metadata: {
      sourceUrl: observation.sourceUrl,
      relationship: observation.relationship,
      duplicateOf: observation.duplicateOf,
    },
  };
}

function qualifiedCandidate(
  candidate: RawTrackCandidateV3,
  predicateIds: readonly string[],
  sourceRank: number,
): CandidateQualificationV3 {
  const sourceUrl = String(candidate.metadata?.sourceUrl);
  const bindingId = `binding-${candidate.id}`;
  const excerpt = `${candidate.artist} — ${candidate.title}: exact disco scope evidence.`;
  const hostedEvidenceSnapshot = createHostedWebEvidenceSnapshotV3({
    sourceUrl,
    excerpt,
    responseId: `rio-response-${candidate.id}`,
    outputItemId: `rio-output-${candidate.id}`,
    contentIndex: 0,
    citationStartIndex: 0,
    citationEndIndex: excerpt.length,
    excerptStartIndex: 0,
    excerptEndIndex: excerpt.length,
    acquiredAt: HOSTED_TEST_ACQUIRED_AT,
    storefront: "us",
    freshnessExpiresAt: HOSTED_TEST_FRESH_UNTIL,
    predicateIds,
    obligationIds: predicateIds,
  });
  return {
    candidateId: candidate.id,
    scope: {
      passed: true,
      failedMembershipPredicateIds: [],
      fit: 0.98,
    },
    hardConstraints: {
      passed: true,
      failedConstraintIds: [],
    },
    evidence: {
      passed: true,
      bindingIds: [bindingId],
      strength: 0.96,
      independentProvenanceRoots: 2,
      bindings: [{
        id: bindingId,
        url: sourceUrl,
        provenanceRoot: new URL(sourceUrl).hostname,
        strength: 0.96,
        sourceRank,
        kind: "track_specific_source",
        predicateIds: [...predicateIds],
        governance: {
          policyVersion: "evidence-source-governance-v3",
          useScope: "run_local",
          approvalState: "approved",
          accessMethod: "hosted_web_search",
          licenseState: "citation_only",
          licenseVersion: "sanitized-replay-v1",
          termsVersion: "sanitized-replay-v1",
          attribution: "Sanitized Rio disco replay source",
          cachePolicy: "excerpt_only",
          retentionPolicy: "ninety_days",
          freshnessPolicy: "immutable_revision",
          acquiredAt: hostedEvidenceSnapshot.acquiredAt,
          freshnessExpiresAt: hostedEvidenceSnapshot.freshnessExpiresAt,
          revokedAt: null,
          sourceHash: hostedEvidenceSnapshot.snapshotHash,
          sourceRevision: hostedEvidenceSnapshot.snapshotHash,
        },
        hostedEvidenceSnapshot,
        eligibilityAttestation: publicTrackScopeAttestationV3(
          sourceUrl,
          hostedEvidenceSnapshot,
        ),
      }],
    },
    version: {
      compatible: true,
      confidence: 0.99,
    },
    catalog: {
      lookupAttempted: true,
      storefrontPlayable: true,
      appleSongId: `apple-${candidate.id}`,
      recordingFamilyKey: `recording-family-${candidate.id}`,
      confidence: 0.99,
      releaseYear: sourceRank % 2 === 0 ? 1979 : 1981,
      compatibleReleaseYears: [sourceRank % 2 === 0 ? 1979 : 1981],
    },
    rankingSignals: {
      relevance: 0.98,
      influence: Math.max(0.2, 1 - sourceRank / 200),
    },
    sourceRank,
  };
}

describe("frozen Rio disco scope-gate incident", () => {
  test("preserves the confirmed production incident shape", () => {
    expect(RIO_DISCO_INCIDENT_OBSERVATIONS).toHaveLength(148);
    expect(RIO_DISCO_INCIDENT_VALID_COUNT).toBe(142);
    expect(RIO_DISCO_INCIDENT_DUPLICATE_COUNT).toBe(6);
    expect(RIO_DISCO_INCIDENT_APPLE_CALL_COUNT).toBe(0);
    expect(RIO_DISCO_INCIDENT_CHECKPOINT).toEqual({
      discovered: 148,
      validCandidates: 142,
      scopeEligible: 0,
      appleLookupCount: 0,
      discardedByReason: {
        scope_membership_failed: 142,
        candidate_already_seen: 6,
      },
    });
    expect(RIO_DISCO_INCIDENT_BAD_PREDICATES.map(({ kind }) => kind)).toEqual([
      "genre",
      "geography",
      "recording_version",
    ]);
    expect(RIO_DISCO_INCIDENT_BAD_HARD_CONSTRAINTS.map(({ axis }) => axis)).toEqual([
      "genre",
      "geography",
      "recording_version",
    ]);

    const uniqueArtistTitles = new Set(
      RIO_DISCO_INCIDENT_OBSERVATIONS.map(({ artist, title }) => `${artist}\u0000${title}`),
    );
    expect(uniqueArtistTitles).toHaveLength(RIO_DISCO_INCIDENT_VALID_COUNT);
    expect(RIO_DISCO_INCIDENT_OBSERVATIONS.filter(({ duplicateOf }) => duplicateOf !== null))
      .toHaveLength(RIO_DISCO_INCIDENT_DUPLICATE_COUNT);
    expect(RIO_DISCO_INCIDENT_OBSERVATIONS.every(({ sourceUrl }) => sourceUrl.startsWith("https://")))
      .toBe(true);
  });

  test("schema 2 keeps disco membership while moving Rio and catalog prose out of the evidence gate", () => {
    const plan = compileCorrectedRioPlan();
    const query = createQueryPlanV3(plan, GRAPH_SNAPSHOT_ID);

    const membership = plan.membershipPredicates.flatMap(({ axis, values }) => (
      values.map((value) => ({ axis, value }))
    ));
    expect(membership).toContainEqual({ axis: "genre", value: "disco" });
    expect(membership.some(({ axis, value }) => (
      axis === "geography" || /rio de janeiro/iu.test(value)
    ))).toBe(false);
    expect(membership.some(({ axis, value }) => (
      axis === "recording_version" || /historically canonical/iu.test(value)
    ))).toBe(false);

    expect(plan.contextSignals).toContainEqual(expect.objectContaining({
      role: "context",
      axis: "geography",
      values: ["Rio de Janeiro"],
    }));
    expect(plan.catalogPolicies).toContainEqual(expect.objectContaining({
      role: "catalog_policy",
      axis: "recording_version",
      values: ["Prefer the historically canonical studio version while allowing compatible remasters."],
    }));
    expect(plan.catalogPolicies).toContainEqual(expect.objectContaining({
      role: "catalog_policy",
      axis: "era",
      values: expect.arrayContaining(["1970s", "1980s"]),
    }));
    expect(plan.recordingPolicy).toMatchObject({
      allowedVersions: ["canonical", "clean", "explicit"],
      preferCanonicalStudio: true,
      excludeKaraokeTributeAndCovers: true,
    });
    expect(plan.hardConstraints.some(({ axis }) => (
      axis === "geography" || axis === "recording_version" || axis === "era"
    ))).toBe(false);

    expect(query.schemaVersion).toBe(2);
    expect(query.membershipPredicates).toHaveLength(1);
    expect(query.membershipPredicates[0]).toMatchObject({
      kind: "genre",
      subject: "disco",
    });
    expect(query.contextSignals).toContainEqual(expect.objectContaining({
      role: "context",
      axis: "geography",
      values: ["Rio de Janeiro"],
    }));
    expect(query.catalogPolicies).toEqual(expect.arrayContaining([
      expect.objectContaining({ axis: "era", role: "catalog_policy" }),
      expect.objectContaining({ axis: "recording_version", role: "catalog_policy" }),
    ]));
    expect(query.recordingPolicy).toEqual(plan.recordingPolicy);
    expect(query.hardConstraints.some(({ axis }) => (
      axis === "genre" || axis === "geography" || axis === "recording_version" || axis === "era"
    ))).toBe(false);
  });

  test("replays the evidence-backed pool through scope and reaches Apple matching", async () => {
    const plan = compileCorrectedRioPlan();
    const remaining = RIO_DISCO_INCIDENT_OBSERVATIONS.map(rawCandidate);
    const appleLookup = vi.fn(async (candidates: readonly RawTrackCandidateV3[]) => (
      candidates.map((candidate, index) => qualifiedCandidate(
        candidate,
        evidenceMembershipPredicateIdsV3(plan),
        index,
      ))
    ));
    const adapters: RetrievalAdaptersV3 = {
      discover: vi.fn(async ({ requestedRawCandidateCount }) => ({
        candidates: remaining.splice(0, requestedRawCandidateCount),
        nextCursor: remaining.length > 0 ? String(RIO_DISCO_INCIDENT_OBSERVATIONS.length - remaining.length) : null,
        exhausted: remaining.length === 0,
      })),
      qualify: vi.fn(async ({ candidates }) => appleLookup(candidates)),
    };

    const result = await executeRetrievalV3({
      runId: "frozen-rio-disco-scope-gate-replay",
      plan,
      adapters,
      executionMode: "shadow",
    });

    expect(result.outcome).toMatchObject({
      status: "exact_ready",
      requestedTrackCount: 49,
      selectedTrackCount: 49,
      requiresPartialPublicationDecision: false,
    });
    expect(result.selected).toHaveLength(49);
    expect(result.stages.scopeEligible).toBeGreaterThanOrEqual(49);
    expect(result.stages.storefrontPlayable).toBeGreaterThanOrEqual(49);
    expect(appleLookup).toHaveBeenCalled();
    expect(result.predicateDiagnostics?.appleLookupCount).toBeGreaterThanOrEqual(49);
    expect(result.predicateDiagnostics?.rootCause).not.toBe("semantic_contract");
    expect(result.deficit.discardedByReason.scope_membership_failed ?? 0).toBe(0);
    expect(result.publicationBoundary).toEqual({
      appleWriteAccess: "forbidden",
      manifestDisposition: "shadow_manifest_only",
    });
  });
});
