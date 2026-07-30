import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { QueryPlanV3 } from "../shared/types.ts";
import {
  buildReleaseManifestCanaryEvidence,
  createReleaseManifestCanaryMarker,
  parseReleaseManifestCanaryMarker,
} from "../server/release-manifest-canary.ts";
import { canonicalContractExecutionPolicyV1 } from "../server/canonical-contract-runtime-v1.ts";
import {
  createHostedWebEvidenceSnapshotV3,
  evaluatePlaylistOptimizationV3,
  publicTrackScopeAttestationV3,
  type EvidenceBindingReferenceV3,
  type QualifiedTrackV3,
} from "../server/pipeline-v3-retrieval.ts";
import { compilePlaylistContractRevisionV1 } from "../server/playlist-contract-v1.ts";
import { createQueryPlanV3, queryPlanV3Hash } from "../server/query-plan-v3.ts";
import { pipelineV3ResearchJob } from "../server/research-resume.ts";
import {
  createRunSpecV3,
  resolveRunSpecV3,
  type SelectionPlanV3,
} from "../server/selection-plan-v3.ts";
import {
  parseStagingManifestCanaryArgs,
  parseStagingManifestRuntimeSnapshot,
  validateStagingManifestCanaryEvidence,
  validateStagingManifestGuidanceExecution,
} from "../scripts/staging-manifest-canary.ts";
import { releaseFixtureSha256 } from "../scripts/release-fixtures.ts";
import {
  buildReleaseRuntimeSnapshot,
  REQUIRED_RELEASE_SECRET_VERSION_NAMES,
} from "../scripts/release-runtime-snapshot.ts";

const revision = "a".repeat(40);
const identityHash = "c".repeat(64);
const configurationHash = "d".repeat(64);
const semanticExecutionConfigurationHash = "6".repeat(64);
const HOSTED_TEST_ACQUIRED_AT = new Date(Date.now() - 60_000).toISOString();
const HOSTED_TEST_FRESH_UNTIL = new Date(
  Date.parse(HOSTED_TEST_ACQUIRED_AT) + 29 * 24 * 60 * 60_000,
).toISOString();
const queryPlanRevisionId = "11111111-1111-4111-8111-111111111111";
const contractRevisionDatabaseId = "22222222-2222-4222-8222-222222222222";
const canonicalContract = compilePlaylistContractRevisionV1({
  contractId: "contract:release-manifest-unit",
  rawPrompt: "Create exactly 3 reggaeton tracks",
  requestedTrackCount: 3,
  locale: "en-US",
  storefront: "us",
  clauses: [{
    id: "membership:reggaeton",
    kind: "membership",
    scope: "track",
    hardness: "hard",
    axis: "genre",
    operator: "require",
    values: ["reggaeton"],
    source: { provenance: "prompt", text: "reggaeton" },
    unknownPolicy: "reject",
  }],
  trackPredicate: {
    op: "clause",
    clauseId: "membership:reggaeton",
  },
});
const contractRevisionId = canonicalContract.revisionId;
const contractSemanticHash = canonicalContract.semanticHash;

function selectionPlan(): SelectionPlanV3 {
  const base = resolveRunSpecV3(createRunSpecV3({
    prompt: "Create exactly 3 reggaeton tracks",
    requestedTrackCount: 3,
    storefront: "us",
  }), []);
  return {
    ...base,
    canonicalContractPolicy:
      canonicalContractExecutionPolicyV1(canonicalContract),
    softGoalRelaxationOrder: [],
    diversityGoals: {
      minimumDistinctArtists: null,
      minimumDistinctAlbums: null,
      minimumDistinctEras: null,
      minimumDistinctScenes: null,
      minimumDistinctGeographies: null,
      maximumTracksPerArtist: null,
      maximumTracksPerAlbum: null,
    },
  };
}

function queryPlan(): QueryPlanV3 {
  return createQueryPlanV3(
    selectionPlan(),
    "33333333-3333-4333-8333-333333333333",
    {
      schemaVersion: 5,
      briefContractVersion: 3,
      playlistContractRevisionId: contractRevisionId,
      playlistContractSemanticHash: contractSemanticHash,
      playlistContractCompilerVersion: canonicalContract.versions.compiler,
    },
  );
}

const planHash = queryPlanV3Hash(queryPlan());
const stageKey = `v3-retrieval:shadow:${planHash.slice(0, 48)}`;

function marker() {
  return createReleaseManifestCanaryMarker({
    canaryId: "manifest-rc-1",
    cacheMode: "reuse_disabled",
    sourceRevision: revision,
    queryPlanHash: planHash,
    queryPlanRevisionId,
    contractRevisionDatabaseId,
    contractRevisionId,
    contractSemanticHash,
    stageKey,
    requestedTrackCount: 3,
    createdAt: "2026-07-23T12:00:00.000Z",
  });
}

function track(
  index: number,
  evidenceMode:
    | "valid"
    | "legacy_url_only"
    | "wrong_obligation"
    | "wrong_storefront" = "valid",
): QualifiedTrackV3 {
  const evidenceBindingId = `binding-${index}`;
  const sourceUrl = `https://evidence.example.test/manifest/${index}`;
  const excerpt = `Artist ${index} — Track ${index}: exact reggaeton membership evidence.`;
  const freshnessExpiresAt = HOSTED_TEST_FRESH_UNTIL;
  const hostedEvidenceSnapshot = createHostedWebEvidenceSnapshotV3({
    sourceUrl,
    excerpt,
    responseId: `manifest-response-${index}`,
    outputItemId: `manifest-output-${index}`,
    contentIndex: 0,
    citationStartIndex: 0,
    citationEndIndex: excerpt.length,
    excerptStartIndex: 0,
    excerptEndIndex: excerpt.length,
    acquiredAt: HOSTED_TEST_ACQUIRED_AT,
    storefront: evidenceMode === "wrong_storefront" ? "ca" : "us",
    freshnessExpiresAt,
    predicateIds: ["membership:reggaeton"],
    obligationIds: evidenceMode === "wrong_obligation"
      ? ["membership:salsa"]
      : ["membership:reggaeton"],
  });
  const discoveryDependency = ([
    "hosted_web",
    "apple_catalog",
    "governed_evidence_graph",
    "orchestration_local",
  ] as const)[(index - 1) % 4]!;
  return {
    candidateId: `candidate-${index}`,
    title: `Track ${index}`,
    artist: `Artist ${index}`,
    album: `Album ${index}`,
    appleSongId: String(1000 + index),
    recordingFamilyKey: `isrc:USAAA260000${index}`,
    sourceObservationIds: [`observation-${index}`],
    evidenceBindingIds: [evidenceBindingId],
    evidenceBindings: [{
      id: evidenceBindingId,
      url: sourceUrl,
      provenanceRoot: `evidence-${index}.example.test`,
      strength: 0.95,
      sourceRank: index,
      kind: "hosted_web_track",
      predicateIds: ["membership:reggaeton"],
      governance: {
        policyVersion: "evidence-source-governance-v3",
        useScope: "run_local",
        approvalState: "approved",
        accessMethod: "hosted_web_search",
        licenseState: "citation_only",
        licenseVersion: "unit-citation-v1",
        termsVersion: "unit-terms-v1",
        attribution: "Unit exact-track evidence",
        cachePolicy: "excerpt_only",
        retentionPolicy: "ninety_days",
        freshnessPolicy: "revalidate_30d",
        acquiredAt: evidenceMode === "legacy_url_only"
          ? undefined
          : hostedEvidenceSnapshot.acquiredAt,
        freshnessExpiresAt,
        revokedAt: evidenceMode === "legacy_url_only" ? undefined : null,
        sourceHash: evidenceMode === "legacy_url_only"
          ? "a".repeat(64)
          : hostedEvidenceSnapshot.snapshotHash,
        sourceRevision: evidenceMode === "legacy_url_only"
          ? "a".repeat(64)
          : hostedEvidenceSnapshot.snapshotHash,
      },
      ...(evidenceMode === "legacy_url_only"
        ? {}
        : { hostedEvidenceSnapshot }),
      eligibilityAttestation: publicTrackScopeAttestationV3(
        sourceUrl,
        evidenceMode === "legacy_url_only"
          ? undefined
          : hostedEvidenceSnapshot,
      ),
    }],
    discoveryDependencyIds: [discoveryDependency],
    provenanceRoots: [`evidence-${index}.example.test`],
    cacheOrigin: "live",
    canonicalClauseAssessments: {
      "membership:reggaeton": {
        status: "pass",
        evidenceGrade: "track_specific_editorial_assertion",
        evidenceIds: [evidenceBindingId],
      },
    },
    evidenceStrength: 0.95,
    scopeFit: 0.95,
    independentProvenanceRoots: 1,
    versionConfidence: 0.99,
    catalogConfidence: 0.99,
    rankingSignals: { relevance: 1 - index * 0.01 },
    sourceRank: index,
  };
}

function checkpoint() {
  return {
    schemaVersion: "genio-pipeline-v3-worker/v1",
    state: "complete",
    stageKey,
    queryPlanHash: planHash,
    queryPlanRevisionId,
    executionMode: "shadow",
    outcome: {
      status: "exact_ready",
      requestedTrackCount: 3,
      selectedTrackCount: 3,
      reserveTrackCount: 1,
    },
    publicationBoundary: {
      appleWriteAccess: "forbidden",
      manifestDisposition: "shadow_manifest_only",
    },
    selected: [track(1), track(2), track(3)],
    reserve: [track(4)],
    playlistOptimization: evaluatePlaylistOptimizationV3({
      plan: selectionPlan(),
      tracks: [track(1), track(2), track(3)],
    }),
    completedAt: "2026-07-23T12:10:00.000Z",
  };
}

function evidence(overrides: Partial<Parameters<typeof buildReleaseManifestCanaryEvidence>[0]> = {}) {
  return buildReleaseManifestCanaryEvidence({
    marker: marker(),
    runStatus: "complete",
    runPhase: "v3_shadow_exact_ready",
    pipelineVersion: "corpus_first_v3",
    autoPublish: false,
    queryPlan: queryPlan(),
    activeQueryPlanRevisionId: queryPlanRevisionId,
    storedQueryPlanHash: planHash,
    activeContractRevisionDatabaseId: contractRevisionDatabaseId,
    activeContractRevisionId: contractRevisionId,
    activeContractSemanticHash: contractSemanticHash,
    checkpoint: checkpoint(),
    attempts: [{
      stage: stageKey,
      contractRevisionDatabaseId,
      queryPlanRevisionId,
      executorRevision: revision,
      executorIdentityHash: identityHash,
      configurationHash,
      status: "complete",
      completedAt: "2026-07-23T12:09:00.000Z",
    }],
    zeroWriteCounts: {
      autoPublish: false,
      manifestRows: 0,
      matchingJobs: 0,
      publicationJobs: 0,
      publicationVolumeRows: 0,
    },
    ...overrides,
  });
}

function runtimeSnapshot() {
  return buildReleaseRuntimeSnapshot({
    origin: "https://staging.9enio.example",
    environment: "staging",
    scope: "full",
    expectedRevision: revision,
    expectedVersion: "2.4.0",
    sitesHtml:
      `<html data-build-version="2.4.0" data-build-revision="${revision}">`,
    sitesConfigurationHashes: Array(3).fill("7".repeat(64)),
    sitesOwnerAllowlistVersions: Array(3).fill("owner-allowlist-v1"),
    livePayload: {
      ok: true,
      build: {
        identifier: `2.4.0+${revision.slice(0, 12)}`,
        version: "2.4.0",
        revision,
      },
      api: {
        schemaVersion: "genio-api-runtime-identity/v1",
        replicaIdentityHash: "4".repeat(64),
        build: {
          identifier: `2.4.0+${revision.slice(0, 12)}`,
          version: "2.4.0",
          revision,
        },
        configurationHash: "8".repeat(64),
        semanticExecutionConfigurationHash,
      },
      configurationHash: "8".repeat(64),
      runtime: {
        semanticExecutionConfigurationHash,
        publicRolloutEvidenceHash: null,
        publicRolloutStage: null,
        releaseEnvironment: "staging",
        deploymentPhase: "activate",
        workerProtocol: "playlist-pipeline-v11",
        briefContractVersion: "3",
        queryPlanSchemaVersion: "6",
        briefProviderModelId: "gpt-5.4-mini",
        baselineProviderModelId: "gpt-5.6-luna",
        escalationProviderModelId: "gpt-5.6-terra",
        guidancePolicyVersion: "adaptive_guidance_v4",
        evidencePolicyVersion: "governed_evidence_v2",
        queryPlanPolicyVersion: "query_plan_v3_4",
        selectionPlanVersion: "selection_plan_v3",
        semanticScopePolicyVersion: "scope_gate_v2_1_2",
        musicConceptPolicyVersion: "music_concepts_v3_2_0",
        pipelinePolicyVersion: "corpus_first_v3",
        promptVersion: "grounded_recovery_v3_1_prompt_v1",
        ownerAllowlistVersion: "owner-allowlist-v1",
      },
    },
    systemPayload: {
      ok: true,
      activationReady: true,
      database: "ready",
      schemaVersion: "19",
      releaseManifestCanaryGuardsVersion: "1",
      canonicalExecutionHardeningVersion: "1",
      canonicalExecutorReleaseIdentityFencingVersion: "1",
      executorFencing: {
        ready: true,
        incompleteJobs: 0,
        mismatchedActiveAttempts: 0,
        uncoveredJobs: 0,
        requirements: [],
      },
      api: {
        schemaVersion: "genio-api-runtime-identity/v1",
        replicaIdentityHash: "5".repeat(64),
        build: {
          identifier: `2.4.0+${revision.slice(0, 12)}`,
          version: "2.4.0",
          revision,
        },
        configurationHash: "8".repeat(64),
        semanticExecutionConfigurationHash,
      },
      publicRollout: {
        active: false,
        databaseAuthorized: true,
        evidenceHash: null,
        stage: null,
        targetConfigurationHash: null,
      },
      paused: false,
      workerLanes: {
        interactive: {
          status: "healthy",
          protocolVersion: "playlist-pipeline-v11",
          compatibleCapacity: 1,
          eligibleWorkerCount: 1,
          eligibleIdentityCount: 1,
          candidateExecutorIdentityReady: true,
          eligibleRevisions: [revision],
          eligibleConfigurationHashes: [configurationHash],
          eligibleSemanticExecutionConfigurationHashes: [
            semanticExecutionConfigurationHash,
          ],
        },
        deep: {
          status: "healthy",
          protocolVersion: "playlist-pipeline-v11",
          compatibleCapacity: 1,
          eligibleWorkerCount: 1,
          eligibleIdentityCount: 1,
          candidateExecutorIdentityReady: true,
          eligibleRevisions: [revision],
          eligibleConfigurationHashes: ["9".repeat(64)],
          eligibleSemanticExecutionConfigurationHashes: [
            semanticExecutionConfigurationHash,
          ],
        },
      },
    },
    systemHttpStatus: 200,
    secretVersions: {
      schemaVersion: "genio-release-secret-versions/v2",
      environment: "staging",
      versions: Object.fromEntries(
        REQUIRED_RELEASE_SECRET_VERSION_NAMES.map((name, index) => [
          name,
          ((index + 1) % 16).toString(16).repeat(64),
        ]),
      ),
    },
    generatedAt: "2026-07-23T11:50:00.000Z",
  });
}

describe("authenticated staging manifest-only canary", () => {
  test("creates only a strict staging/shadow marker", () => {
    expect(marker()).toMatchObject({
      schemaVersion: "genio-release-manifest-canary-marker/v1",
      environment: "staging",
      executionMode: "shadow",
      publicationBoundary: "database_fenced",
      appleWriteAccess: "forbidden",
      requestedTrackCount: 3,
    });
    expect(parseReleaseManifestCanaryMarker({
      ...marker(),
      environment: "production",
    })).toBeNull();
    expect(parseReleaseManifestCanaryMarker({
      ...marker(),
      requestedTrackCount: 300,
    })).toMatchObject({
      requestedTrackCount: 300,
    });
    expect(parseReleaseManifestCanaryMarker({
      ...marker(),
      requestedTrackCount: 301,
    })).toBeNull();
    expect(parseReleaseManifestCanaryMarker({
      ...marker(),
      queryPlanRevisionId: "stale",
    })).toBeNull();
  });

  test("emits hash-bound exact qualified evidence only with zero write artifacts", () => {
    expect(evidence()).toMatchObject({
      schemaVersion: "genio-release-manifest-canary-evidence/v1",
      cacheMode: "reuse_disabled",
      environment: "staging",
      sourceRevision: revision,
      executionMode: "shadow",
      publicationBoundary: "database_fenced",
      appleWriteAccess: "forbidden",
      outcome: "exact_ready",
      requestedTrackCount: 3,
      selectedTrackCount: 3,
      reserveTrackCount: 1,
      queryPlanHash: planHash,
      queryPlanRevisionId,
      contractRevisionDatabaseId,
      contractRevisionId,
      contractSemanticHash,
      selectionValidation: {
        canonicalPublicationValid: true,
        playlistOptimizationRequired: true,
        playlistOptimizationExact: true,
        usefulReserveTrackCount: 1,
      },
      attempts: [{
        stage: stageKey,
        contractRevisionDatabaseId,
        queryPlanRevisionId,
        status: "complete",
      }],
      executorIdentityHashes: [identityHash],
      configurationHashes: [configurationHash],
      zeroWriteProof: {
        autoPublish: false,
        manifestRows: 0,
        matchingJobs: 0,
        publicationJobs: 0,
        publicationVolumeRows: 0,
      },
    });
    expect(evidence().qualifiedManifestHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(evidence().qualifiedReserveHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(evidence().evidenceHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("fails closed on partial results, stale executors, or any write-path artifact", () => {
    expect(() => evidence({
      runPhase: "v3_shadow_partial_ready",
    })).toThrow(/exact(?:_| )shadow(?:_| )manifest/u);
    expect(() => evidence({
      activeQueryPlanRevisionId:
        "99999999-9999-4999-8999-999999999999",
    })).toThrow(/exact(?:_| )shadow(?:_| )manifest/u);
    expect(() => evidence({
      checkpoint: {
        ...checkpoint(),
        queryPlanRevisionId:
          "99999999-9999-4999-8999-999999999999",
      },
    })).toThrow(/exact(?:_| )shadow(?:_| )manifest/u);
    expect(() => evidence({
      attempts: [{
        stage: stageKey,
        contractRevisionDatabaseId,
        queryPlanRevisionId,
        executorRevision: "e".repeat(40),
        executorIdentityHash: identityHash,
        configurationHash,
        status: "complete",
        completedAt: "2026-07-23T12:09:00.000Z",
      }],
    })).toThrow(/executor(?:_| )identity/u);
    expect(() => evidence({
      zeroWriteCounts: {
        autoPublish: false,
        manifestRows: 1,
        matchingJobs: 0,
        publicationJobs: 0,
        publicationVolumeRows: 0,
      },
    })).toThrow(/apple(?:_| )write(?:_| )boundary/u);
    expect(() => evidence({
      checkpoint: {
        ...checkpoint(),
        reserve: [{
          ...track(4),
          evidenceBindings: [],
        }],
      },
    })).toThrow(/qualified|usable|evidence/u);
    expect(() => evidence({
      checkpoint: {
        ...checkpoint(),
        playlistOptimization: {
          ...checkpoint().playlistOptimization,
          exact: false,
        },
      },
    })).toThrow(/optimization/u);
  });

  test("rejects URL-only, wrong-obligation, and wrong-storefront canary evidence", () => {
    for (const invalidTrack of [
      track(1, "legacy_url_only"),
      track(1, "wrong_obligation"),
      track(1, "wrong_storefront"),
    ]) {
      expect(() => evidence({
        checkpoint: {
          ...checkpoint(),
          selected: [invalidTrack, track(2), track(3)],
        },
      })).toThrow(/canonical(?:_| )evidence(?:_| )is(?:_| )unproven/u);
    }
  });

  test("rejects unbounded unhashed fields in canary evidence wrappers", () => {
    const base = track(1);
    const binding = base.evidenceBindings![0]!;
    const unboundedPayload = "x".repeat(1_000_000);
    const invalidTracks: QualifiedTrackV3[] = [
      {
        ...base,
        evidenceBindings: [({
          ...binding,
          untrustedProviderPayload: unboundedPayload,
        } as unknown as EvidenceBindingReferenceV3)],
      },
      {
        ...base,
        evidenceBindings: [({
          ...binding,
          governance: {
            ...binding.governance,
            untrustedProviderPayload: unboundedPayload,
          },
        } as unknown as EvidenceBindingReferenceV3)],
      },
      {
        ...base,
        evidenceBindings: [({
          ...binding,
          eligibilityAttestation: {
            ...binding.eligibilityAttestation!,
            untrustedProviderPayload: unboundedPayload,
          },
        } as unknown as EvidenceBindingReferenceV3)],
      },
    ];

    for (const invalidTrack of invalidTracks) {
      expect(() => evidence({
        checkpoint: {
          ...checkpoint(),
          selected: [invalidTrack, track(2), track(3)],
        },
      })).toThrow(/canonical(?:_| )evidence(?:_| )is(?:_| )unproven/u);
    }
  });

  test("strict CLI evidence validation binds the runtime snapshot and rejects tampering", () => {
    const snapshot = runtimeSnapshot();
    expect(parseStagingManifestRuntimeSnapshot(snapshot, {
      origin: "https://staging.9enio.example",
      sourceRevision: revision,
      version: "2.4.0",
    })).toEqual(snapshot);
    const validEvidence = evidence();
    expect(validateStagingManifestCanaryEvidence(validEvidence, {
      canaryId: "manifest-rc-1",
      targetTrackCount: 3,
      sourceRevision: revision,
      runtimeSnapshot: snapshot,
    })).toEqual(validEvidence);
    expect(() => validateStagingManifestCanaryEvidence({
      ...validEvidence,
      zeroWriteProof: {
        ...validEvidence.zeroWriteProof,
        publicationJobs: 1,
      },
    }, {
      canaryId: "manifest-rc-1",
      targetTrackCount: 3,
      sourceRevision: revision,
      runtimeSnapshot: snapshot,
    })).toThrow(/invalid release evidence|evidence hash/u);
    expect(() => validateStagingManifestCanaryEvidence({
      ...validEvidence,
      configurationHashes: ["f".repeat(64)],
    }, {
      canaryId: "manifest-rc-1",
      targetTrackCount: 3,
      sourceRevision: revision,
      runtimeSnapshot: snapshot,
    })).toThrow(/invalid release evidence/u);
  });

  test("durable job identity carries shadow mode and a distinct stage fence", () => {
    const job = pipelineV3ResearchJob("00000000-0000-4000-8000-000000000001", {
      ...queryPlan(),
      engines: ["curated_genre_scene"],
    } as unknown as QueryPlanV3, "shadow");
    expect(job.payload).toMatchObject({
      v3ExecutionMode: "shadow",
      stageExecutionKey: expect.stringMatching(/^v3-retrieval:shadow:/u),
    });
    expect(job.stageKey).toBe(job.payload.stageExecutionKey);
  });

  test("binds the live typed guidance delta to the active shadow contract", () => {
    const validation = {
      fixtureId: "smooth-reggaeton-heat-50-v1" as const,
      questionSetHash: "1".repeat(64),
      questionHash: "2".repeat(64),
      selectedOptionId: "reggaeton_dembow_latin_urban",
      executionDeltaHash: "3".repeat(64),
      affectedClauseIds: ["guidance:quota:core-reggaeton-share"],
    };
    const lineage = [{
      questionSetHash: validation.questionSetHash,
      executionDeltaHash: validation.executionDeltaHash,
      baseContractHash: "4".repeat(64),
      resultingContractHash: "5".repeat(64),
      affectedClauseIds: validation.affectedClauseIds,
      acceptedAt: "2026-07-23T12:00:00.000Z",
    }];
    expect(validateStagingManifestGuidanceExecution({
      executionProof: { guidanceLineage: lineage },
    }, validation)).toBe(releaseFixtureSha256(lineage));
    expect(() => validateStagingManifestGuidanceExecution({
      executionProof: {
        guidanceLineage: [{
          ...lineage[0],
          executionDeltaHash: "6".repeat(64),
        }],
      },
    }, validation)).toThrow(/did not reach the active contract/u);
  });

  test("CLI requires explicit provider approval and rejects production origins", () => {
    const common = (origin = "https://staging.9enio.example") => [
      "--origin", origin,
      "--fixture-id", "smooth-reggaeton-heat-50-v1",
      "--candidate-tag", "v2.4.0-rc.2",
      "--expected-revision", revision,
      "--expected-version", "2.4.0",
      "--image-digest", `sha256:${"b".repeat(64)}`,
      "--cache-mode", "reuse_disabled",
      "--runtime-snapshot", "/tmp/staging-runtime-snapshot.json",
      "--source-output", "/tmp/manifest-source.json",
      "--output", "/tmp/manifest-gate.json",
      "--attestation-output", "/tmp/manifest-gate.attestation.json",
      "--producer-signing-key", "/tmp/producer.pem",
      "--producer-key-id", "manifest-producer-v1",
    ];
    const releaseOrigins = {
      RELEASE_STAGING_ORIGIN: "https://staging.9enio.example",
    };
    expect(() => parseStagingManifestCanaryArgs(common(), releaseOrigins)).toThrow(
      "--confirm-live-provider",
    );
    expect(() => parseStagingManifestCanaryArgs([
      "--confirm-live-provider",
      ...common("https://9enio.com"),
    ], releaseOrigins)).toThrow(/non-production/u);
    expect(parseStagingManifestCanaryArgs([
      "--confirm-live-provider",
      ...common(),
    ], releaseOrigins)).toMatchObject({
      targetTrackCount: 50,
      fixtureId: "smooth-reggaeton-heat-50-v1",
      expectedRevision: revision,
      expectedVersion: "2.4.0",
    });
    expect(() => parseStagingManifestCanaryArgs([
      "--confirm-live-provider",
      ...common("https://attacker.example"),
    ], releaseOrigins)).toThrow(/exactly match RELEASE_STAGING_ORIGIN/u);
  });

  test("the CLI has no Apple or publisher import and the repository guards all queued work", () => {
    const cli = readFileSync(
      new URL("../scripts/staging-manifest-canary.ts", import.meta.url),
      "utf8",
    );
    const repository = readFileSync(
      new URL("../server/repository.ts", import.meta.url),
      "utf8",
    );
    expect(cli).not.toMatch(/from\s+["'][^"']*(?:apple|publisher)/iu);
    expect(cli).toContain("CANARY_DEADLINE_MS = 16 * 60_000");
    expect(cli).toContain('"Staging manifest canary failed closed"');
    expect(cli).not.toContain("error instanceof Error ? error.message");
    expect(repository).toContain("RELEASE_MANIFEST_CANARY_MARKER_PHASE");
    expect(repository).toContain("release_manifest_canary_write_forbidden");
    expect(repository).toContain("input.payload?.v3ExecutionMode !== \"shadow\"");
  });
});
