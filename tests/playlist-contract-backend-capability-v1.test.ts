import { describe, expect, test } from "vitest";
import type {
  PlaylistContractDraftV1,
  PlaylistContractRevisionV1,
  PlaylistPredicateV1,
} from "../server/playlist-contract-v1.ts";
import {
  compilePlaylistContractRevisionV1,
} from "../server/playlist-contract-v1.ts";
import {
  CORPUS_FIRST_V3_PLAYLIST_CONTRACT_CAPABILITY,
  negotiatePlaylistContractBackendV1,
  playlistContractCapabilityRequirementsV1,
} from "../server/playlist-contract-backend-capability-v1.ts";
import type { BackendCapabilityDeclaration } from "../server/never-dead-end-policy.ts";

function draft(input: {
  storefront?: string;
  predicate?: PlaylistPredicateV1;
  compilerVersion?: string;
  quota?: boolean;
  catalogAxis?: "recording_version" | "content" | "era";
} = {}): PlaylistContractDraftV1 {
  const catalogAxis = input.catalogAxis ?? "recording_version";
  const trackPredicate = input.predicate ?? {
    op: "all",
    children: [
      { op: "clause", clauseId: "membership:reggaeton" },
      { op: "clause", clauseId: `catalog:${catalogAxis}` },
    ],
  };
  return {
    contractId: "contract:capability-fixture",
    rawPrompt: "Make a 20-track reggaeton playlist with canonical versions.",
    requestedTrackCount: 20,
    locale: "en-US",
    storefront: input.storefront ?? "us",
    versions: input.compilerVersion ? { compiler: input.compilerVersion } : undefined,
    clauses: [
      {
        id: "membership:reggaeton",
        kind: "membership",
        scope: "track",
        hardness: "hard",
        axis: "genre",
        operator: "require",
        values: ["reggaeton"],
        source: { provenance: "prompt", text: "reggaeton" },
      },
      {
        id: `catalog:${catalogAxis}`,
        kind: "catalog_version",
        scope: "track",
        hardness: "hard",
        axis: catalogAxis,
        operator: "require",
        values: catalogAxis === "content"
          ? ["explicit-content:clean_only"]
          : catalogAxis === "era"
            ? ["2010"]
            : ["allow:canonical"],
        source: {
          provenance: "prompt",
          text: catalogAxis === "era" ? "released in 2010" : "canonical versions",
        },
      },
      {
        id: "playlist:core-share",
        kind: "quota_diversity",
        scope: "playlist",
        hardness: "soft",
        axis: "core-share",
        operator: "balance",
        values: ["70%"],
        source: { provenance: "system_default", text: "core share" },
      },
      {
        id: "playlist:flow",
        kind: "ranking_preference",
        scope: "playlist",
        hardness: "soft",
        axis: "sequencing",
        operator: "prefer",
        values: ["smooth"],
        source: { provenance: "prompt", text: "smooth flow" },
      },
    ],
    trackPredicate,
    playlistConstraints: input.quota === false ? [] : [{
      id: "quota:core-share",
      clauseId: "playlist:core-share",
      predicate: { op: "clause", clauseId: "membership:reggaeton" },
      minimumCount: null,
      maximumCount: null,
      minimumRatio: 0.7,
      maximumRatio: 1,
    }],
    sequencingObjectives: [{
      id: "sequence:smooth",
      clauseId: "playlist:flow",
      dimension: "playlist_flow",
      direction: "smooth",
      weight: 1,
      priority: 1,
    }],
    qualityPolicy: {
      centralSuitabilityClauseIds: [],
      minimumPassRatio: 0.8,
      maximumUnknownRatio: 0.2,
      zeroKnownFailures: true,
    },
  };
}

function contract(input: Parameters<typeof draft>[0] = {}): PlaylistContractRevisionV1 {
  return compilePlaylistContractRevisionV1(draft(input));
}

function semanticNegativeContract(input: {
  axis: "genre" | "scene" | "language";
  operator: "not" | "except";
}): PlaylistContractRevisionV1 {
  const semanticId = `semantic:${input.axis}`;
  const semanticClause = {
    id: semanticId,
    kind: "membership" as const,
    scope: "track" as const,
    hardness: "hard" as const,
    axis: input.axis,
    operator: "require" as const,
    values: [input.axis === "genre"
      ? "reggaeton"
      : input.axis === "scene"
        ? "Bristol scene"
        : "French"],
    source: { provenance: "prompt" as const, text: `not ${input.axis}` },
  };
  const availability = {
    id: "catalog:available",
    kind: "catalog_version" as const,
    scope: "track" as const,
    hardness: "hard" as const,
    axis: "storefront_availability",
    operator: "require" as const,
    values: ["available"],
    source: { provenance: "system_default" as const, text: "available" },
  };
  return compilePlaylistContractRevisionV1({
    contractId: `contract:semantic-negative:${input.operator}:${input.axis}`,
    rawPrompt: `Create a playlist excluding ${input.axis}.`,
    requestedTrackCount: 20,
    locale: "en-US",
    storefront: "us",
    clauses: input.operator === "not"
      ? [semanticClause]
      : [semanticClause, availability],
    trackPredicate: input.operator === "not"
      ? { op: "not", child: { op: "clause", clauseId: semanticId } }
      : {
          op: "except",
          base: { op: "clause", clauseId: availability.id },
          exceptions: [{ op: "clause", clauseId: semanticId }],
        },
    playlistConstraints: [],
    sequencingObjectives: [],
    qualityPolicy: {
      centralSuitabilityClauseIds: [],
      minimumPassRatio: 0.8,
      maximumUnknownRatio: 0.2,
      zeroKnownFailures: true,
    },
  });
}

function unsupportedQuotaContract(
  shape: "exact_exclusion" | "not" | "except",
): PlaylistContractRevisionV1 {
  const quotaPredicate: PlaylistPredicateV1 = shape === "exact_exclusion"
    ? { op: "clause", clauseId: "exclude:bad-bunny" }
    : shape === "not"
      ? {
          op: "not",
          child: { op: "clause", clauseId: "membership:dembow" },
        }
      : {
          op: "except",
          base: { op: "clause", clauseId: "membership:reggaeton" },
          exceptions: [{ op: "clause", clauseId: "membership:dembow" }],
        };
  return compilePlaylistContractRevisionV1({
    contractId: `contract:unsupported-quota:${shape}`,
    rawPrompt: "Create a governed reggaeton playlist.",
    requestedTrackCount: 20,
    locale: "en-US",
    storefront: "us",
    clauses: [
      {
        id: "membership:reggaeton",
        kind: "membership",
        scope: "track",
        hardness: "hard",
        axis: "genre",
        operator: "require",
        values: ["reggaeton"],
        source: { provenance: "prompt", text: "reggaeton" },
      },
      ...(shape !== "exact_exclusion" ? [{
        id: "membership:dembow",
        kind: "membership",
        scope: "track",
        hardness: "hard",
        axis: "genre",
        operator: "require",
        values: ["dembow"],
        source: { provenance: "prompt", text: "dembow" },
      } as const] : []),
      ...(shape === "exact_exclusion" ? [{
        id: "exclude:bad-bunny",
        kind: "exclusion",
        scope: "track",
        hardness: "hard",
        axis: "artist",
        operator: "exclude",
        values: ["Bad Bunny"],
        source: { provenance: "guidance", text: "No Bad Bunny" },
      } as const] : []),
      {
        id: "quota:shape",
        kind: "quota_diversity",
        scope: "playlist",
        hardness: "hard",
        axis: "distribution",
        operator: "limit",
        values: [shape],
        source: { provenance: "guidance", text: shape },
      },
    ],
    trackPredicate: shape === "exact_exclusion"
      ? {
          op: "all",
          children: [
            { op: "clause", clauseId: "membership:reggaeton" },
            { op: "clause", clauseId: "exclude:bad-bunny" },
          ],
        }
      : { op: "clause", clauseId: "membership:reggaeton" },
    playlistConstraints: [{
      id: `quota:${shape}`,
      clauseId: "quota:shape",
      predicate: quotaPredicate,
      minimumCount: 1,
      maximumCount: null,
      minimumRatio: null,
      maximumRatio: null,
    }],
    ...(shape === "exact_exclusion" ? {
      executionDirectives: {
        fixedContainer: null,
        similarity: null,
        exactArtistIdentityExclusions: {
          bindings: [{
            clauseId: "exclude:bad-bunny",
            catalogArtistId: "1126808565",
            displayName: "Bad Bunny",
            storefront: "us",
          }],
        },
      },
    } : {}),
  });
}

function without(
  capability: BackendCapabilityDeclaration,
  update: Partial<BackendCapabilityDeclaration>,
): BackendCapabilityDeclaration {
  return { ...capability, ...update };
}

describe("playlist-contract backend capability negotiation", () => {
  test("extracts the exact immutable selection requirements", () => {
    expect(playlistContractCapabilityRequirementsV1(contract())).toMatchObject({
      contractSchemaVersion: 1,
      compilerVersion: "playlist_contract_compiler_v1",
      ontologyVersion: "playlist_music_ontology_v2",
      evidencePolicyVersion: "governed_evidence_v2",
      evidenceStrengthPolicyVersion: "evidence_strength_partial_order_v1",
      questionTemplateVersion: "guidance_decision_v3",
      catalogPolicyVersion: "catalog_policy_v1",
      locale: "en-us",
      storefront: "us",
      predicateOperators: ["all", "clause"],
      negativePredicateRequirements: [],
      requiresQuotas: true,
      quotaPredicateOperators: ["clause"],
      quotaAxes: ["genre"],
      quotaPredicateLeafShapes: ["require:membership:track:hard"],
      catalogPolicyAxes: ["recording_version"],
      requiresSequencing: true,
      sequencingDirections: ["smooth"],
      sequencingDimensions: ["playlist_flow"],
    });
  });

  test("selects only a backend that supports the complete contract", () => {
    const discoveryOnlyV2 = without(CORPUS_FIRST_V3_PLAYLIST_CONTRACT_CAPABILITY, {
      backend: "catalog_first_v2",
      supportsQuotas: false,
      supportsSequencing: false,
      catalogPolicyAxes: [],
    });
    const result = negotiatePlaylistContractBackendV1({
      contract: contract(),
      backends: [discoveryOnlyV2, CORPUS_FIRST_V3_PLAYLIST_CONTRACT_CAPABILITY],
    });
    expect(result.backend?.backend).toBe("corpus_first_v3");
    expect(result.result).toEqual({ supported: true, missing: [] });
    expect(result.capabilityHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  test("selects the tri-state runtime for Boolean OR without flattening it", () => {
    const value = contract({
      quota: false,
      predicate: {
        op: "any",
        children: [
          { op: "clause", clauseId: "membership:reggaeton" },
          { op: "clause", clauseId: "catalog:recording_version" },
        ],
      },
    });
    const result = negotiatePlaylistContractBackendV1({
      contract: value,
      backends: [CORPUS_FIRST_V3_PLAYLIST_CONTRACT_CAPABILITY],
    });
    expect(result.backend?.backend).toBe("corpus_first_v3");
    expect(result.result).toEqual({ supported: true, missing: [] });
  });

  test.each([
    ["not", "genre"],
    ["not", "scene"],
    ["not", "language"],
    ["except", "genre"],
    ["except", "scene"],
    ["except", "language"],
  ] as const)(
    "fails capability negotiation for open-world semantic %s over %s",
    (operator, axis) => {
      const value = semanticNegativeContract({ axis, operator });
      expect(playlistContractCapabilityRequirementsV1(value))
        .toMatchObject({
          negativePredicateRequirements: [`require:membership:${axis}`],
        });
      const result = negotiatePlaylistContractBackendV1({
        contract: value,
        backends: [CORPUS_FIRST_V3_PLAYLIST_CONTRACT_CAPABILITY],
      });
      expect(result.backend).toBeNull();
      expect(result.result.missing).toContain(
        `corpus_first_v3:negative_predicate:require:membership:${axis}`,
      );
    },
  );

  test("retains NOT/EXCEPT for closed Apple version and content metadata", () => {
    const noLive = contract({
      quota: false,
      predicate: {
        op: "all",
        children: [
          { op: "clause", clauseId: "membership:reggaeton" },
          {
            op: "not",
            child: { op: "clause", clauseId: "catalog:recording_version" },
          },
        ],
      },
    });
    const cleanExceptExplicit = contract({
      quota: false,
      catalogAxis: "content",
      predicate: {
        op: "all",
        children: [
          { op: "clause", clauseId: "membership:reggaeton" },
          {
            op: "except",
            base: { op: "clause", clauseId: "catalog:content" },
            exceptions: [{ op: "clause", clauseId: "catalog:content" }],
          },
        ],
      },
    });
    expect(playlistContractCapabilityRequirementsV1(noLive))
      .toMatchObject({
        negativePredicateRequirements: [
          "require:catalog_version:recording_version",
        ],
      });
    expect(negotiatePlaylistContractBackendV1({
      contract: noLive,
      backends: [CORPUS_FIRST_V3_PLAYLIST_CONTRACT_CAPABILITY],
    }).result).toEqual({ supported: true, missing: [] });
    expect(playlistContractCapabilityRequirementsV1(cleanExceptExplicit)
      .negativePredicateRequirements).toEqual([
        "require:catalog_version:content",
      ]);
    expect(negotiatePlaylistContractBackendV1({
      contract: cleanExceptExplicit,
      backends: [CORPUS_FIRST_V3_PLAYLIST_CONTRACT_CAPABILITY],
    }).result).toEqual({ supported: true, missing: [] });
  });

  test("fails closed for unsupported quota, storefront, version, and content policy", () => {
    const noQuota = negotiatePlaylistContractBackendV1({
      contract: contract(),
      backends: [without(CORPUS_FIRST_V3_PLAYLIST_CONTRACT_CAPABILITY, {
        supportsQuotas: false,
      })],
    });
    expect(noQuota.result.missing).toContain("corpus_first_v3:feature:quotas");

    const wrongStorefront = negotiatePlaylistContractBackendV1({
      contract: contract({ storefront: "br" }),
      backends: [without(CORPUS_FIRST_V3_PLAYLIST_CONTRACT_CAPABILITY, {
        storefronts: ["us"],
      })],
    });
    expect(wrongStorefront.result.missing).toContain("corpus_first_v3:storefront:br");

    const futureCompiler = negotiatePlaylistContractBackendV1({
      contract: contract({ compilerVersion: "playlist_contract_compiler_v99" }),
      backends: [CORPUS_FIRST_V3_PLAYLIST_CONTRACT_CAPABILITY],
    });
    expect(futureCompiler.result.missing).toContain(
      "corpus_first_v3:compiler:playlist_contract_compiler_v99",
    );

    const noContentGate = negotiatePlaylistContractBackendV1({
      contract: contract({ catalogAxis: "content" }),
      backends: [without(CORPUS_FIRST_V3_PLAYLIST_CONTRACT_CAPABILITY, {
        catalogPolicyAxes: ["recording_version"],
      })],
    });
    expect(noContentGate.result.missing).toContain("corpus_first_v3:catalog_policy:content");

    const noEvidenceFloorSemantics = negotiatePlaylistContractBackendV1({
      contract: contract(),
      backends: [without(CORPUS_FIRST_V3_PLAYLIST_CONTRACT_CAPABILITY, {
        evidenceStrengthPolicyVersions: [],
      })],
    });
    expect(noEvidenceFloorSemantics.result.missing).toContain(
      "corpus_first_v3:evidence_strength_policy:evidence_strength_partial_order_v1",
    );
  });

  test("advertises the fail-closed recording-family era evaluator", () => {
    const exactYear = contract({ catalogAxis: "era" });
    expect(playlistContractCapabilityRequirementsV1(exactYear).catalogPolicyAxes)
      .toEqual(["era"]);
    expect(negotiatePlaylistContractBackendV1({
      contract: exactYear,
      backends: [CORPUS_FIRST_V3_PLAYLIST_CONTRACT_CAPABILITY],
    }).result).toEqual({ supported: true, missing: [] });

    const withoutEra = negotiatePlaylistContractBackendV1({
      contract: exactYear,
      backends: [without(CORPUS_FIRST_V3_PLAYLIST_CONTRACT_CAPABILITY, {
        catalogPolicyAxes: ["storefront_availability", "recording_version", "content"],
      })],
    });
    expect(withoutEra.result.missing).toContain("corpus_first_v3:catalog_policy:era");
  });

  test.each([
    ["exact_exclusion", "quota_leaf:exclude:exclusion:track:hard"],
    ["not", "quota_operator:not"],
    ["except", "quota_operator:except"],
  ] as const)(
    "rejects unsupported %s quota shape before execution projection",
    (shape, missing) => {
      const value = unsupportedQuotaContract(shape);
      const result = negotiatePlaylistContractBackendV1({
        contract: value,
        backends: [CORPUS_FIRST_V3_PLAYLIST_CONTRACT_CAPABILITY],
      });
      expect(result.backend).toBeNull();
      expect(result.result.missing).toContain(`corpus_first_v3:${missing}`);
    },
  );

  test("does not reinterpret a selection-incompatible discovery backend as failover", () => {
    const discoveryOnlyV2 = without(CORPUS_FIRST_V3_PLAYLIST_CONTRACT_CAPABILITY, {
      backend: "catalog_first_v2",
      predicateOperators: ["clause"],
      evidenceGrades: ["authoritative_structured_metadata"],
      supportsQuotas: false,
      supportsSequencing: false,
      storefronts: ["us"],
      catalogPolicyAxes: [],
    });
    const result = negotiatePlaylistContractBackendV1({
      contract: contract(),
      backends: [discoveryOnlyV2],
    });
    expect(result.backend).toBeNull();
    expect(result.result.supported).toBe(false);
    expect(result.result.missing).toEqual(expect.arrayContaining([
      "catalog_first_v2:operator:all",
      "catalog_first_v2:feature:quotas",
      "catalog_first_v2:feature:sequencing",
      "catalog_first_v2:catalog_policy:recording_version",
    ]));
  });
});
