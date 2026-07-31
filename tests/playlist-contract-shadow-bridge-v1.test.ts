import { describe, expect, test } from "vitest";
import type {
  PlaylistBrief,
  SelectionConstraint,
  SelectionPlan,
} from "../shared/types.ts";
import {
  compileGuidanceSelectionV3,
  guidanceContractPatchV1,
  SMOOTH_REGGAETON_HEAT_PROMPT,
  smoothReggaetonHeatGuidanceDecisionV3,
} from "../server/adaptive-guidance-v3.ts";
import {
  applyPlaylistContractPatchV1,
  assertPlaylistContractIntegrityV1,
} from "../server/playlist-contract-v1.ts";
import {
  buildPlaylistContractShadowDraftV1,
  compilePlaylistContractShadowV1,
  PLAYLIST_CONTRACT_SHADOW_BRIDGE_VERSION,
  PLAYLIST_CONTRACT_SHADOW_EVIDENCE_POLICY_VERSION,
} from "../server/playlist-contract-shadow-bridge-v1.ts";
import {
  CORPUS_FIRST_V3_PLAYLIST_CONTRACT_CAPABILITY,
  negotiatePlaylistContractBackendV1,
} from "../server/playlist-contract-backend-capability-v1.ts";
import { createSelectionPlanV2 } from "../server/selection-plan-v2.ts";

function brief(overrides: Partial<PlaylistBrief> = {}): PlaylistBrief {
  return {
    title: "Curated playlist",
    description: "A carefully selected playlist.",
    mode: "curated",
    subjectEntities: [],
    relationship: "belongs in the requested musical scope",
    include: [],
    exclude: [],
    versionPolicy: "Prefer one canonical studio recording; exclude live recordings and remixes.",
    evidencePolicy: "Require track-scope editorial or authoritative metadata evidence.",
    orderingPolicy: "Use a smooth editorial flow with artists intermixed.",
    targetSize: { min: 50, max: 50 },
    ambiguities: [],
    ...overrides,
  };
}

function smoothReggaetonBrief(): PlaylistBrief {
  return brief({
    title: "Smooth Reggaeton Heat",
    description: "A 50-track smooth reggaeton playlist centered on polished, sensual, danceable reggaeton and adjacent Latin urban tracks with a flirtatious, crowd-pleasing vibe.",
    subjectEntities: ["reggaeton", "Latin urban"],
    relationship: "centered on reggaeton and adjacent Latin urban music",
    include: [
      "polished reggaeton",
      "sensual reggaeton",
      "danceable reggaeton",
      "adjacent Latin urban tracks",
      "flirtatious vibe",
      "crowd-pleasing club-friendly tracks",
    ],
    targetSize: { min: 50, max: 50 },
  });
}

function constraint(
  id: string,
  axis: SelectionConstraint["axis"],
  operator: SelectionConstraint["operator"],
  values: string[],
  kind: SelectionConstraint["kind"],
): SelectionConstraint {
  return {
    id,
    axis,
    operator,
    values,
    kind,
    geographyRelationship: axis === "language"
      ? "language"
      : axis === "geography"
        ? "artist_origin"
        : null,
    relaxationRank: kind === "hard" ? null : 1,
  };
}

describe("playlist contract shadow bridge v1", () => {
  test("compiles co-named rap and grime as one hard OR membership clause", () => {
    const prompt = "Create 50 tracks for bike rides from new rap and grime artists, using Pop Smoke only as a reference point.";
    const requestBrief = brief({
      title: "Bike Ride Discovery",
      description: "High-energy rap and grime for bike rides.",
      subjectEntities: ["rap", "grime", "Pop Smoke"],
      relationship: "rap and grime recordings suited to bike rides",
      include: ["new rap and grime artists"],
      exclude: ["Pop Smoke as primary artist"],
      targetSize: { min: 50, max: 50 },
    });
    const selectionPlan = createSelectionPlanV2({
      prompt,
      brief: requestBrief,
      storefront: "us",
    });
    expect(selectionPlan.constraints).toEqual(expect.arrayContaining([
      expect.objectContaining({
        axis: expect.stringMatching(/genre|scene|subgenre/u),
        kind: "hard",
        values: expect.arrayContaining(["rap"]),
      }),
    ]));

    const bridged = compilePlaylistContractShadowV1({
      contractId: "run:rap-or-grime",
      prompt,
      brief: requestBrief,
      selectionPlan,
    });
    const hardGenreClauses = bridged.contract.clauses.filter((clause) => (
      clause.hardness === "hard"
      && clause.kind === "membership"
      && clause.axis === "genre"
    ));
    expect(hardGenreClauses).toEqual([
      expect.objectContaining({
        id: "bridge:membership:hip-hop-or-grime",
        operator: "require",
        values: expect.arrayContaining(["rap", "hip-hop", "grime"]),
        concepts: expect.arrayContaining([
          expect.objectContaining({ selectedConceptId: "genre:hip-hop" }),
          expect.objectContaining({ selectedConceptId: "genre:grime" }),
        ]),
      }),
    ]);
    expect(JSON.stringify(bridged.contract.trackPredicate)).toContain(
      "bridge:membership:hip-hop-or-grime",
    );
    expect(JSON.stringify(bridged.contract.trackPredicate)).not.toContain(
      "bridge:constraint:scope_1",
    );
    expect(() => assertPlaylistContractIntegrityV1(bridged.contract)).not.toThrow();
  });

  test("keeps an explicit quoted fixed list executable without a redundant substitution exclusion", () => {
    const prompt = "Create a playlist with exactly these three tracks and no substitutions: \"Take on Me\" by a-ha; \"Africa\" by Toto; \"Like a Prayer\" by Madonna.";
    const requestBrief = brief({
      title: "80s Pop Essentials",
      description: "The three explicitly named tracks.",
      relationship: "Limit to the three explicitly named tracks; preserve the user’s listed order.",
      include: [
        "\"Take on Me\" by a-ha",
        "\"Africa\" by Toto",
        "\"Like a Prayer\" by Madonna",
      ],
      exclude: ["Substitutions"],
      orderingPolicy: "Preserve the user’s listed order.",
      targetSize: { min: 3, max: 3 },
    });
    const selectionPlan = createSelectionPlanV2({
      prompt,
      brief: requestBrief,
      storefront: "us",
    });
    expect(selectionPlan.scopeKind).toBe("fixed_track_list");
    const bridged = compilePlaylistContractShadowV1({
      contractId: "run:fixed-three",
      prompt,
      brief: requestBrief,
      selectionPlan,
    });

    expect(bridged.contract.executionDirectives?.fixedTrackList).toMatchObject({
      tracks: [
        { artist: "a-ha", title: "Take on Me" },
        { artist: "Toto", title: "Africa" },
        { artist: "Madonna", title: "Like a Prayer" },
      ],
    });
    expect(bridged.contract.clauses).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "exclusion",
        axis: "relationship",
        values: ["Substitutions"],
      }),
    ]));
    expect(() => assertPlaylistContractIntegrityV1(bridged.contract)).not.toThrow();
    const negotiated = negotiatePlaylistContractBackendV1({
      contract: bridged.contract,
      backends: [CORPUS_FIRST_V3_PLAYLIST_CONTRACT_CAPABILITY],
    });
    expect(negotiated.backend?.backend).toBe("corpus_first_v3");
    expect(negotiated.result).toEqual({
      supported: true,
      missing: [],
    });
  });

  test("turns the exact Smooth Reggaeton scope fork into one required-guidance input", () => {
    const requestBrief = smoothReggaetonBrief();
    const selectionPlan = createSelectionPlanV2({
      prompt: SMOOTH_REGGAETON_HEAT_PROMPT,
      brief: requestBrief,
      storefront: "us",
    });
    selectionPlan.constraints = [
      ...selectionPlan.constraints,
      constraint("provider_invented_party", "activity", "prefer", ["party"], "soft"),
    ];
    const bridged = compilePlaylistContractShadowV1({
      contractId: "run:smooth-reggaeton-heat",
      prompt: SMOOTH_REGGAETON_HEAT_PROMPT,
      brief: requestBrief,
      selectionPlan,
      locale: "en-US",
    });

    expect(bridged.contract.requestedTrackCount).toBe(50);
    expect(bridged.contract.partialPolicy).toBe("ask");
    expect(bridged.contract.versions.compiler).toBe(PLAYLIST_CONTRACT_SHADOW_BRIDGE_VERSION);
    expect(bridged.contract.versions.evidencePolicy)
      .toBe(PLAYLIST_CONTRACT_SHADOW_EVIDENCE_POLICY_VERSION);
    expect(bridged.ambiguousScopeClauseIds).toHaveLength(1);
    expect(bridged.contract.trackPredicate).toEqual(bridged.preservedTrackPredicate);

    const ambiguousClause = bridged.contract.clauses.find(
      ({ id }) => id === bridged.ambiguousScopeClauseIds[0],
    );
    expect(ambiguousClause).toMatchObject({
      kind: "membership",
      hardness: "soft",
      axis: "genre",
      operator: "allow",
      values: expect.arrayContaining(["reggaeton", "Latin urban"]),
      source: {
        provenance: "prompt",
        text: "adjacent Latin urban",
      },
    });
    expect(JSON.stringify(bridged.preservedTrackPredicate)).not.toContain(ambiguousClause!.id);

    const central = bridged.contract.qualityPolicy.centralSuitabilityClauseIds
      .map((id) => bridged.contract.clauses.find((clause) => clause.id === id))
      .filter(Boolean);
    expect(central.map((clause) => clause!.values[0])).toEqual(expect.arrayContaining([
      "smooth",
      "polished",
      "sensual",
      "danceable",
      "flirtatious",
      "crowd-pleasing",
    ]));
    expect(central.map((clause) => clause!.values[0])).not.toContain("party");
    expect(central).toHaveLength(6);
    expect(central.every((clause) => (
      clause!.kind === "suitability" && clause!.hardness === "soft"
    ))).toBe(true);
    expect(bridged.contract.qualityPolicy).toMatchObject({
      minimumPassRatio: 0.8,
      maximumUnknownRatio: 0.2,
      zeroKnownFailures: true,
    });
    expect(() => assertPlaylistContractIntegrityV1(bridged.contract)).not.toThrow();
  });

  test("feeds the exact bridge output into the adaptive guidance patch without losing other gates", () => {
    const requestBrief = smoothReggaetonBrief();
    const selectionPlan = createSelectionPlanV2({
      prompt: SMOOTH_REGGAETON_HEAT_PROMPT,
      brief: requestBrief,
      storefront: "us",
    });
    const bridged = compilePlaylistContractShadowV1({
      contractId: "run:smooth-reggaeton-guided",
      prompt: SMOOTH_REGGAETON_HEAT_PROMPT,
      brief: requestBrief,
      selectionPlan,
    });
    const decision = smoothReggaetonHeatGuidanceDecisionV3({
      prompt: SMOOTH_REGGAETON_HEAT_PROMPT,
      baseContractRevisionId: bridged.contract.revisionId,
      baseContractSemanticHash: bridged.contract.semanticHash,
      preservedTrackPredicate: bridged.preservedTrackPredicate,
      ambiguousScopeClauseIds: bridged.ambiguousScopeClauseIds,
    })!;
    const selection = compileGuidanceSelectionV3(decision, {
      optionIds: ["reggaeton_dembow_latin_urban"],
    });
    const patch = guidanceContractPatchV1({
      decision,
      questionSetHash: "b".repeat(64),
      accepted: {
        answerHash: selection.answerHash,
        executableOperations: selection.operations,
      },
    })!;
    const revised = applyPlaylistContractPatchV1(bridged.contract, patch);

    expect(revised.requestedTrackCount).toBe(50);
    expect(revised.trackPredicate).toEqual({
      op: "all",
      children: [
        bridged.preservedTrackPredicate,
        {
          op: "any",
          children: [
            { op: "clause", clauseId: "guidance:membership:core-reggaeton" },
            { op: "clause", clauseId: "guidance:membership:dembow" },
            { op: "clause", clauseId: "guidance:membership:latin-urban" },
          ],
        },
      ],
    });
    expect(revised.playlistConstraints).toEqual([
      expect.objectContaining({
        id: "quota:genre:core-reggaeton-share",
        minimumRatio: 0.7,
        maximumRatio: 1,
      }),
    ]);
    expect(revised.clauses.some(({ id }) => bridged.ambiguousScopeClauseIds.includes(id))).toBe(false);
    expect(() => assertPlaylistContractIntegrityV1(revised)).not.toThrow();
  });

  test("preserves typed hard gates and rankings while softening only ambiguous/discovery concepts", () => {
    const prompt = "Make exactly 37 reggaeton and jazz tracks from 2010 to 2020, by French artists, in Spanish, clean only, no Bad Bunny. Prefer influential, smooth selections. Explore Brazilian funk and perreo only after clarification.";
    const requestBrief = brief({
      title: "Exact governed scope",
      description: prompt,
      include: ["clean recordings", "smooth selections"],
      exclude: ["Bad Bunny", "live recordings", "remixes"],
      targetSize: { min: 37, max: 37 },
    });
    const baseline = createSelectionPlanV2({ prompt, brief: requestBrief, storefront: "fr" });
    const constraints: SelectionConstraint[] = [
      constraint("genre_reggaeton", "genre", "require", ["reggaeton"], "hard"),
      constraint("genre_jazz", "genre", "require", ["jazz"], "hard"),
      constraint("genre_brazilian_funk", "genre", "require", ["Brazilian funk"], "hard"),
      constraint("genre_perreo", "genre", "require", ["perreo"], "hard"),
      constraint("era_2010_2020", "era", "between", ["2010", "2020"], "hard"),
      constraint("artist_origin_france", "geography", "require", ["France"], "hard"),
      constraint("language_spanish", "language", "require", ["Spanish"], "hard"),
      constraint("exclude_bad_bunny", "artist", "exclude", ["Bad Bunny"], "hard"),
      constraint("ranking_influence", "relationship", "prefer", ["influential"], "soft"),
      constraint("suitability_smooth", "mood", "prefer", ["smooth"], "soft"),
      constraint("avoid_aggressive", "mood", "avoid", ["aggressive"], "soft"),
    ];
    const selectionPlan: SelectionPlan = {
      ...baseline,
      requestedTrackCount: 37,
      minimumQualifiedTrackCount: 37,
      constraints,
      versionPolicy: {
        preferred: ["canonical"],
        allowed: ["canonical", "clean"],
        excludeCompilations: true,
        excludeKaraokeAndTributes: true,
      },
      contentPolicy: {
        explicitContent: "clean_only",
        instrumental: "allow",
        languages: ["Spanish"],
      },
    };
    const built = buildPlaylistContractShadowDraftV1({
      contractId: "run:typed-shadow",
      prompt,
      brief: requestBrief,
      selectionPlan,
      locale: "en",
    });
    const bridged = compilePlaylistContractShadowV1({
      contractId: "run:typed-shadow",
      prompt,
      brief: requestBrief,
      selectionPlan,
      locale: "en",
    });

    expect(built.draft.requestedTrackCount).toBe(37);
    expect(bridged.contract.requestedTrackCount).toBe(37);
    expect(bridged.contract.storefront).toBe("fr");
    expect(bridged.conceptDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: "reggaeton", status: "resolved" }),
      expect.objectContaining({ value: "jazz", status: "resolved" }),
      expect.objectContaining({ value: "Brazilian funk", status: "ambiguous" }),
      expect.objectContaining({ value: "perreo", status: "discovery_only" }),
    ]));
    expect(bridged.ambiguousScopeClauseIds).toHaveLength(2);
    expect(bridged.softenedHardConstraintIds).toEqual(expect.arrayContaining([
      "genre_brazilian_funk",
      "genre_perreo",
    ]));

    const clauseForValue = (value: string) => bridged.contract.clauses.find(
      (clause) => clause.values.includes(value),
    );
    expect(clauseForValue("reggaeton")).toMatchObject({
      kind: "membership",
      hardness: "hard",
      concepts: [{ status: "resolved", selectedConceptId: "genre:reggaeton" }],
    });
    expect(clauseForValue("jazz")).toMatchObject({
      kind: "membership",
      hardness: "hard",
      concepts: [expect.objectContaining({
        status: "resolved",
        selectedConceptId: "genre:jazz",
      })],
    });
    expect(clauseForValue("Brazilian funk")).toMatchObject({
      kind: "membership",
      hardness: "soft",
      concepts: [expect.objectContaining({
        status: "ambiguous",
        selectedConceptId: null,
      })],
    });
    expect(clauseForValue("perreo")).toMatchObject({
      kind: "membership",
      hardness: "soft",
      concepts: [expect.objectContaining({
        status: "discovery_only",
        selectedConceptId: null,
      })],
    });
    expect(clauseForValue("Bad Bunny")).toMatchObject({
      kind: "exclusion",
      hardness: "hard",
      operator: "exclude",
    });
    expect(clauseForValue("2010")).toMatchObject({
      kind: "factual_relationship",
      hardness: "hard",
      axis: "era",
    });
    expect(clauseForValue("France")).toMatchObject({
      kind: "factual_relationship",
      hardness: "hard",
      axis: "geography",
    });
    expect(clauseForValue("Spanish")).toMatchObject({
      kind: "factual_relationship",
      hardness: "hard",
      axis: "language",
    });
    expect(clauseForValue("influential")).toMatchObject({
      kind: "ranking_preference",
      hardness: "soft",
    });
    expect(clauseForValue("avoid:aggressive")).toMatchObject({
      kind: "ranking_preference",
      hardness: "soft",
      operator: "prefer",
    });
    expect(
      bridged.contract.qualityPolicy.centralSuitabilityClauseIds.some((id) => (
        bridged.contract.clauses.find((clause) => clause.id === id)
          ?.values.includes("aggressive")
      )),
    ).toBe(false);
    expect(bridged.contract.clauses).toContainEqual(expect.objectContaining({
      id: "bridge:catalog:recording-version-policy",
      kind: "catalog_version",
      hardness: "hard",
      values: expect.arrayContaining([
        "allow:canonical",
        "allow:clean",
        "exclude:compilations",
        "exclude:karaoke-and-tributes",
      ]),
    }));
    expect(bridged.contract.clauses).toContainEqual(expect.objectContaining({
      id: "bridge:catalog:content-policy",
      kind: "catalog_version",
      hardness: "hard",
      values: expect.arrayContaining([
        "explicit-content:clean_only",
        "language:Spanish",
      ]),
    }));
    expect(bridged.contract.clauses).toContainEqual(expect.objectContaining({
      id: "bridge:evidence:qualification-policy",
      kind: "factual_relationship",
      hardness: "hard",
      values: [requestBrief.evidencePolicy],
    }));
    expect(JSON.stringify(bridged.preservedTrackPredicate)).not.toContain("genre_brazilian_funk");
    expect(JSON.stringify(bridged.preservedTrackPredicate)).not.toContain("genre_perreo");
    expect(() => assertPlaylistContractIntegrityV1(bridged.contract)).not.toThrow();
  });

  test("keeps an unfamiliar music term as a discovery hint instead of a silent hard predicate", () => {
    const prompt = "Make exactly 25 velvet pulse tracks for a late-night set.";
    const requestBrief = brief({
      title: "Velvet pulse",
      description: prompt,
      targetSize: { min: 25, max: 25 },
    });
    const baseline = createSelectionPlanV2({ prompt, brief: requestBrief, storefront: "us" });
    const unknownConstraint = constraint(
      "genre_velvet_pulse",
      "genre",
      "require",
      ["velvet pulse"],
      "hard",
    );
    const bridged = compilePlaylistContractShadowV1({
      contractId: "run:unfamiliar-concept",
      prompt,
      brief: requestBrief,
      selectionPlan: {
        ...baseline,
        constraints: [unknownConstraint],
      },
    });

    const clause = bridged.contract.clauses.find(
      ({ values }) => values.includes("velvet pulse"),
    );
    expect(clause).toMatchObject({
      kind: "membership",
      hardness: "soft",
      operator: "allow",
      concepts: [expect.objectContaining({
        status: "unresolved",
        selectedConceptId: null,
        discoveryHint: "velvet pulse",
      })],
    });
    expect(bridged.ambiguousScopeClauseIds).toEqual([clause!.id]);
    expect(bridged.softenedHardConstraintIds).toEqual(["genre_velvet_pulse"]);
    expect(JSON.stringify(bridged.preservedTrackPredicate)).not.toContain(clause!.id);
  });
});
