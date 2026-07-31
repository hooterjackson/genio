import { describe, expect, test } from "vitest";
import {
  applyPlaylistContractPatchV1,
  assertPlaylistContractIntegrityV1,
  compilePlaylistContractRevisionV1,
  evaluatePlaylistContractTrackV1,
  evaluatePlaylistQualityV1,
  evaluatePlaylistQuotasV1,
  rebasePlaylistContractPatchV1,
  type PlaylistClauseAssessmentV1,
  type PlaylistContractClauseDraftV1,
  type PlaylistContractDraftV1,
  type PlaylistContractRevisionV1,
} from "../server/playlist-contract-v1.ts";

const prompt = "Smooth Reggaeton Heat: A 50-track smooth reggaeton playlist centered on polished, sensual, danceable reggaeton and adjacent Latin urban tracks with a flirtatious, crowd-pleasing vibe.";

function hardMembership(
  id: string,
  text: string,
  conceptText: string,
): PlaylistContractClauseDraftV1 {
  return {
    id,
    kind: "membership",
    scope: "track",
    hardness: "hard",
    axis: "genre",
    operator: "require",
    conceptInputs: [{ text: conceptText, expectedKind: "genre" }],
    source: { provenance: "guidance", text },
  };
}

function smoothReggaetonDraft(): PlaylistContractDraftV1 {
  const suitability = ["smooth", "polished", "sensual", "danceable", "crowd-pleasing"].map((value) => ({
    id: `suitability:${value}`,
    kind: "suitability" as const,
    scope: "track" as const,
    hardness: "soft" as const,
    axis: "suitability",
    operator: "prefer" as const,
    values: [value],
    source: { provenance: "prompt" as const, text: value },
  }));
  return {
    contractId: "run:reggaeton-50",
    rawPrompt: prompt,
    requestedTrackCount: 50,
    locale: "en-US",
    storefront: "US",
    clauses: [
      hardMembership("genre:core-reggaeton", "Core reggaeton", "reggaeton"),
      hardMembership("genre:adjacent-latin-urban", "Adjacent Latin urban", "Latin urban"),
      {
        id: "exclude:bad-bunny",
        kind: "exclusion",
        scope: "track",
        hardness: "hard",
        axis: "artist",
        operator: "exclude",
        values: ["Bad Bunny"],
        source: { provenance: "guidance", text: "No Bad Bunny" },
        unknownPolicy: "defer",
      },
      ...suitability,
      {
        id: "quota:core-reggaeton",
        kind: "quota_diversity",
        scope: "playlist",
        hardness: "hard",
        axis: "genre_distribution",
        operator: "require",
        values: ["at least 70% core reggaeton"],
        source: { provenance: "guidance", text: "At least 70% core reggaeton" },
      },
    ],
    trackPredicate: {
      op: "all",
      children: [
        {
          op: "any",
          children: [
            { op: "clause", clauseId: "genre:core-reggaeton" },
            { op: "clause", clauseId: "genre:adjacent-latin-urban" },
          ],
        },
        { op: "clause", clauseId: "exclude:bad-bunny" },
      ],
    },
    playlistConstraints: [{
      id: "distribution:core-reggaeton",
      clauseId: "quota:core-reggaeton",
      predicate: { op: "clause", clauseId: "genre:core-reggaeton" },
      minimumCount: null,
      maximumCount: null,
      minimumRatio: 0.7,
      maximumRatio: null,
    }],
    qualityPolicy: {
      centralSuitabilityClauseIds: suitability.map((clause) => clause.id),
      minimumPassRatio: 0.8,
      maximumUnknownRatio: 0.2,
      zeroKnownFailures: true,
    },
  };
}

function compileFixture(): PlaylistContractRevisionV1 {
  return compilePlaylistContractRevisionV1(smoothReggaetonDraft());
}

const editorialPass = {
  status: "pass",
  evidenceGrade: "track_specific_editorial_assertion",
} as const satisfies PlaylistClauseAssessmentV1;

describe("immutable playlist contract revision v1", () => {
  test("replaces an earlier answer from its historical base and drops dependent lineage", () => {
    const base = compileFixture();
    const first = applyPlaylistContractPatchV1(base, {
      baseRevisionId: base.revisionId,
      baseSemanticHash: base.semanticHash,
      answerLineage: {
        questionSetHash: "1".repeat(64),
        questionId: "guidance:scope",
        answerHash: "2".repeat(64),
      },
      operations: [{
        op: "replace_clause",
        clauseId: "suitability:smooth",
        clause: {
          id: "suitability:smooth",
          kind: "suitability",
          scope: "track",
          hardness: "soft",
          axis: "suitability",
          operator: "prefer",
          values: ["silky"],
          source: { provenance: "guidance", text: "silky" },
        },
      }],
    });
    const active = applyPlaylistContractPatchV1(first, {
      baseRevisionId: first.revisionId,
      baseSemanticHash: first.semanticHash,
      answerLineage: {
        questionSetHash: "3".repeat(64),
        questionId: "guidance:flow",
        answerHash: "4".repeat(64),
      },
      operations: [{
        op: "replace_clause",
        clauseId: "suitability:polished",
        clause: {
          id: "suitability:polished",
          kind: "suitability",
          scope: "track",
          hardness: "soft",
          axis: "suitability",
          operator: "prefer",
          values: ["glossy"],
          source: { provenance: "guidance", text: "glossy" },
        },
      }],
    });
    const replacement = rebasePlaylistContractPatchV1({
      active,
      historicalBase: base,
      replacementPatch: {
        baseRevisionId: base.revisionId,
        baseSemanticHash: base.semanticHash,
        answerLineage: {
          questionSetHash: "5".repeat(64),
          questionId: "guidance:scope",
          answerHash: "6".repeat(64),
        },
        operations: [{
          op: "replace_clause",
          clauseId: "suitability:smooth",
          clause: {
            id: "suitability:smooth",
            kind: "suitability",
            scope: "track",
            hardness: "soft",
            axis: "suitability",
            operator: "prefer",
            values: ["warm"],
            source: { provenance: "guidance", text: "warm" },
          },
        }],
      },
    });
    expect(replacement.parentRevisionId).toBe(active.revisionId);
    expect(replacement.parentSemanticHash).toBe(active.semanticHash);
    expect(replacement.revision).toBe(active.revision + 1);
    expect(replacement.requestedTrackCount).toBe(active.requestedTrackCount);
    expect(replacement.answerLineage).toEqual([{
      questionSetHash: "5".repeat(64),
      questionId: "guidance:scope",
      answerHash: "6".repeat(64),
    }]);
    expect(replacement.clauses.find(({ id }) => id === "suitability:smooth")
      ?.values).toEqual(["warm"]);
    expect(replacement.clauses.find(({ id }) => id === "suitability:polished")
      ?.values).toEqual(["polished"]);
    expect(() => assertPlaylistContractIntegrityV1(replacement)).not.toThrow();
  });

  test("compiles hard scope, soft suitability, version snapshots, and semantic identity", () => {
    const contract = compileFixture();
    expect(contract).toMatchObject({
      schemaVersion: 1,
      contractId: "run:reggaeton-50",
      revision: 1,
      parentRevisionId: null,
      requestedTrackCount: 50,
      storefront: "us",
      partialPolicy: "ask",
      versions: {
        compiler: "playlist_contract_compiler_v1",
        ontology: "playlist_music_ontology_v4",
        evidencePolicy: "governed_evidence_v2",
        questionTemplates: "guidance_decision_v3",
        catalogPolicy: "catalog_policy_v1",
      },
    });
    expect(contract.semanticHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(contract.revisionId).toMatch(/^pcr1:[0-9a-f]{64}$/u);
    expect(contract.clauses.find((clause) => clause.id === "genre:core-reggaeton")).toMatchObject({
      hardness: "hard",
      concepts: [{ status: "resolved", selectedConceptId: "genre:reggaeton" }],
      changePolicy: "user_revision_only",
    });
    expect(contract.clauses.find((clause) => clause.id === "suitability:smooth")).toMatchObject({
      hardness: "soft",
      changePolicy: "system_ranking_only",
    });
    expect(Object.isFrozen(contract)).toBe(true);
    expect(Object.isFrozen(contract.clauses)).toBe(true);
    expect(() => (contract.clauses as unknown as PlaylistContractClauseDraftV1[]).push(
      hardMembership("genre:other", "Other", "dembow"),
    )).toThrow();
    expect(() => assertPlaylistContractIntegrityV1(contract)).not.toThrow();
  });

  test("rejects a zero per-artist maximum instead of silently weakening it", () => {
    const draft = smoothReggaetonDraft();
    expect(() => compilePlaylistContractRevisionV1({
      ...draft,
      clauses: [...draft.clauses, {
        id: "diversity:max-artist-zero",
        kind: "quota_diversity",
        scope: "playlist",
        hardness: "hard",
        axis: "maximum-tracks-per-artist",
        operator: "limit",
        values: ["0"],
        source: { provenance: "guidance", text: "At most zero tracks per artist" },
      }],
    })).toThrow("contradictory_playlist_diversity_clause");
  });

  test("rejects count and ratio quotas that conflict at the immutable requested count", () => {
    const draft = smoothReggaetonDraft();
    expect(() => compilePlaylistContractRevisionV1({
      ...draft,
      playlistConstraints: draft.playlistConstraints?.map((constraint) => ({
        ...constraint,
        minimumCount: 40,
        maximumRatio: 0.75,
      })),
    })).toThrow("contradictory_quota_for_requested_count");
  });

  test("uses canonical ordering for semantic hashes without conflating revision identity", () => {
    const leftDraft = smoothReggaetonDraft();
    const rightDraft = {
      ...leftDraft,
      contractId: "run:reggaeton-equivalent",
      clauses: [...leftDraft.clauses].reverse(),
      trackPredicate: leftDraft.trackPredicate.op === "all"
        ? { ...leftDraft.trackPredicate, children: [...leftDraft.trackPredicate.children].reverse() }
        : leftDraft.trackPredicate,
    };
    const left = compilePlaylistContractRevisionV1(leftDraft);
    const right = compilePlaylistContractRevisionV1(rightDraft);
    expect(left.semanticHash).toBe(right.semanticHash);
    expect(left.revisionId).not.toBe(right.revisionId);
  });

  test("requires selection-grade evidence and treats exclusions as compliance rules", () => {
    const contract = compileFixture();
    const eligible = evaluatePlaylistContractTrackV1(contract, {
      "genre:core-reggaeton": {
        status: "pass",
        evidenceGrade: "trusted_scoped_container",
      },
      "genre:adjacent-latin-urban": { status: "unknown" },
      "exclude:bad-bunny": {
        status: "fail",
        evidenceGrade: "authoritative_structured_metadata",
      },
    });
    expect(eligible.status).toBe("pass");
    expect(eligible.eligible).toBe(true);
    expect(eligible.clauses["exclude:bad-bunny"]).toMatchObject({
      rawStatus: "fail",
      status: "pass",
      reason: "excluded_absent",
    });

    const leadOnly = evaluatePlaylistContractTrackV1(contract, {
      "genre:core-reggaeton": {
        status: "pass",
        evidenceGrade: "model_derived_lead",
      },
      "genre:adjacent-latin-urban": { status: "fail" },
      "exclude:bad-bunny": {
        status: "fail",
        evidenceGrade: "authoritative_structured_metadata",
      },
    });
    expect(leadOnly.status).toBe("unknown");
    expect(leadOnly.eligible).toBe(false);
    expect(leadOnly.clauses["genre:core-reggaeton"]?.reason).toBe("insufficient_evidence_grade");

    const excluded = evaluatePlaylistContractTrackV1(contract, {
      "genre:core-reggaeton": {
        status: "pass",
        evidenceGrade: "trusted_scoped_container",
      },
      "exclude:bad-bunny": {
        status: "pass",
        evidenceGrade: "authoritative_structured_metadata",
      },
    });
    expect(excluded.status).toBe("fail");
  });

  test("enforces permitted grades and the versioned minimum-grade partial order", () => {
    const evidenceDraft: PlaylistContractDraftV1 = {
      contractId: "run:evidence-floor",
      rawPrompt: "Tracks with a documented factual relationship.",
      requestedTrackCount: 1,
      locale: "en-US",
      storefront: "us",
      clauses: [{
        id: "relationship:documented",
        kind: "factual_relationship",
        scope: "track",
        hardness: "hard",
        axis: "relationship",
        operator: "require",
        values: ["documented relationship"],
        source: { provenance: "prompt", text: "documented factual relationship" },
        evidence: {
          required: true,
          minimumGrade: "primary_source",
          permittedGrades: [
            "primary_source",
            "independent_secondary_source",
            "authoritative_structured_metadata",
          ],
        },
      }],
      trackPredicate: { op: "clause", clauseId: "relationship:documented" },
    };
    const contract = compilePlaylistContractRevisionV1(evidenceDraft);
    const evaluate = (evidenceGrade: PlaylistClauseAssessmentV1["evidenceGrade"]) => (
      evaluatePlaylistContractTrackV1(contract, {
        "relationship:documented": { status: "pass", evidenceGrade },
      })
    );

    expect(evaluate("primary_source")).toMatchObject({ status: "pass", eligible: true });
    expect(evaluate("independent_secondary_source")).toMatchObject({
      status: "unknown",
      eligible: false,
    });
    // Structured metadata and primary sources are incomparable source
    // families, even when both are permitted for this particular claim.
    expect(evaluate("authoritative_structured_metadata")).toMatchObject({
      status: "unknown",
      eligible: false,
    });
    expect(evaluate("model_derived_lead")).toMatchObject({
      status: "unknown",
      eligible: false,
    });
    expect(evaluate(
      "future_unreviewed_grade" as PlaylistClauseAssessmentV1["evidenceGrade"],
    )).toMatchObject({ status: "unknown", eligible: false });

    const defaultFactual = compilePlaylistContractRevisionV1({
      ...evidenceDraft,
      contractId: "run:evidence-floor-default-factual",
      clauses: evidenceDraft.clauses.map((clause) => ({
        ...clause,
        evidence: undefined,
      })),
    });
    expect(evaluatePlaylistContractTrackV1(defaultFactual, {
      "relationship:documented": {
        status: "pass",
        evidenceGrade: "authoritative_structured_metadata",
      },
    })).toMatchObject({ status: "unknown", eligible: false });
    expect(evaluatePlaylistContractTrackV1(defaultFactual, {
      "relationship:documented": {
        status: "pass",
        evidenceGrade: "primary_source",
      },
    })).toMatchObject({ status: "pass", eligible: true });
  });

  test("evaluates playlist-level distribution and central suitability independently", () => {
    const contract = compileFixture();
    const quotaTracks = Array.from({ length: 10 }, (_, index) => ({
      "genre:core-reggaeton": index < 7
        ? { status: "pass" as const, evidenceGrade: "trusted_scoped_container" as const }
        : { status: "fail" as const, evidenceGrade: "trusted_scoped_container" as const },
    }));
    expect(evaluatePlaylistQuotasV1(contract, quotaTracks)).toEqual([expect.objectContaining({
      id: "distribution:core-reggaeton",
      status: "pass",
      passCount: 7,
      totalCount: 10,
    })]);

    const suitabilityIds = contract.qualityPolicy.centralSuitabilityClauseIds;
    const qualityTracks: Record<string, PlaylistClauseAssessmentV1>[] = [0, 1].map((trackIndex) => Object.fromEntries(
      suitabilityIds.map((clauseId, clauseIndex) => [
        clauseId,
        trackIndex === 1 && clauseIndex >= 3 ? { status: "unknown" as const } : editorialPass,
      ]),
    ));
    expect(evaluatePlaylistQualityV1(contract, qualityTracks)).toMatchObject({
      status: "pass",
      passRatio: 0.8,
      unknownRatio: 0.2,
      failCount: 0,
    });

    qualityTracks[0]![suitabilityIds[0]!] = {
      status: "fail",
      evidenceGrade: "track_specific_editorial_assertion",
    };
    expect(evaluatePlaylistQualityV1(contract, qualityTracks).status).toBe("fail");
  });

  test("creates a fenced immutable successor and rejects stale or no-op answers", () => {
    const base = compileFixture();
    const patch = {
      baseRevisionId: base.revisionId,
      baseSemanticHash: base.semanticHash,
      answerLineage: {
        questionSetHash: "a".repeat(64),
        questionId: "scope:latin-urban",
        answerHash: "b".repeat(64),
      },
      operations: [
        {
          op: "remove_clause" as const,
          clauseId: "genre:adjacent-latin-urban",
        },
        {
          op: "replace_track_predicate" as const,
          predicate: {
            op: "all" as const,
            children: [
              { op: "clause" as const, clauseId: "genre:core-reggaeton" },
              { op: "clause" as const, clauseId: "exclude:bad-bunny" },
            ],
          },
        },
        {
          op: "set_playlist_constraints" as const,
          constraints: [],
        },
      ],
    };
    const successor = applyPlaylistContractPatchV1(base, patch);
    expect(successor).toMatchObject({
      revision: 2,
      parentRevisionId: base.revisionId,
      parentSemanticHash: base.semanticHash,
      answerLineage: [{ questionId: "scope:latin-urban" }],
    });
    expect(successor.semanticHash).not.toBe(base.semanticHash);
    expect(() => applyPlaylistContractPatchV1(successor, patch)).toThrow("stale_playlist_contract_revision");
    expect(() => applyPlaylistContractPatchV1(base, {
      ...patch,
      operations: [{ op: "set_requested_track_count", count: 50 }],
    })).toThrow("contract_patch_did_not_change_semantics");
  });

  test("rejects ambiguous hard concepts, orphan hard clauses, and tampered revisions", () => {
    const draft = smoothReggaetonDraft();
    expect(() => compilePlaylistContractRevisionV1({
      ...draft,
      clauses: [
        ...draft.clauses,
        hardMembership("genre:ambiguous-brazilian-funk", "Brazilian funk", "Brazilian funk"),
      ],
    })).toThrow("hard_clause_requires_resolved_concept");

    expect(() => compilePlaylistContractRevisionV1({
      ...draft,
      clauses: [
        ...draft.clauses,
        hardMembership("genre:orphan", "Dembow", "dembow"),
      ],
    })).toThrow("orphan_hard_track_clause");

    const contract = compileFixture();
    const tampered = { ...contract, requestedTrackCount: 51 };
    expect(() => assertPlaylistContractIntegrityV1(tampered)).toThrow(
      "playlist_contract_semantic_hash_mismatch",
    );
  });
});
