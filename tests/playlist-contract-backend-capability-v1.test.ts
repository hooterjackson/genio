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
  catalogAxis?: "recording_version" | "content";
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
          : ["allow:canonical"],
        source: { provenance: "prompt", text: "canonical versions" },
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
      requiresQuotas: true,
      quotaPredicateOperators: ["clause"],
      quotaAxes: ["genre"],
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
