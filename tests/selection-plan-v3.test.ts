import { describe, expect, test } from "vitest";
import {
  criticalAmbiguityAnswersFromGuidanceV3,
  criticalGuidanceQuestionsV3,
  createRunSpecV3,
  deterministicGuidanceQuestionsV3,
  resolveRunSpecV3,
  type RunSpecV3Input,
} from "../server/selection-plan-v3.ts";
import { evaluateCandidateMembershipV3 } from "../server/pipeline-v3-policy.ts";
import type { SelectionConstraint } from "../shared/types.ts";
import { MUSIC_CONCEPT_POLICY_VERSION } from "../server/music-concepts-v3.ts";

function genreCandidateMemberships(genres: readonly string[]) {
  return {
    id: `candidate:${genres.join("-")}`,
    value: null,
    artist: "Test artist",
    album: null,
    year: null,
    scene: null,
    memberships: { genre: genres },
    objectiveScores: {},
    sourceRank: 1,
  };
}

function typedPlan(constraints: readonly SelectionConstraint[]): NonNullable<RunSpecV3Input["typedSelectionPlan"]> {
  return {
    intents: ["genre_scene"],
    scopeKind: "broad_curated",
    constraints: constraints.map((constraint) => ({ ...constraint, values: [...constraint.values] })),
    diversityGoals: { minimumDistinctArtists: 10, minimumDistinctAlbums: null, minimumDistinctEras: null, minimumDistinctScenes: null, minimumDistinctGeographies: null, maximumTracksPerArtist: null, maximumTracksPerAlbum: null },
    versionPolicy: { preferred: ["canonical"], allowed: ["canonical"], excludeCompilations: false, excludeKaraokeAndTributes: true },
    orderingPolicy: { mode: "editorial", goals: [], avoidAdjacentSameArtist: true, avoidAdjacentSameAlbum: true },
    softGoalRelaxationOrder: [],
    contentPolicy: { explicitContent: "allow", instrumental: "allow", languages: [] },
  };
}

describe("Pipeline V3 typed planning", () => {
  test("classifies reggaeton as explicit genre membership without a fabricated fallback", () => {
    const spec = createRunSpecV3({
      prompt: "Smooth reggaeton for a late-night dance floor",
      requestedTrackCount: 50,
    });
    expect(spec.intents).toContain("genre_scene");
    expect(spec.intents).toContain("mood_activity");
    expect(spec.membershipPredicates).toContainEqual(expect.objectContaining({
      axis: "genre",
      values: ["reggaeton"],
    }));
  });

  test("compiles rap and grime as one OR membership predicate", () => {
    const spec = createRunSpecV3({
      prompt: "50 rap and grime tracks for a high-energy bike ride",
      requestedTrackCount: 50,
    });
    const genrePredicates = spec.membershipPredicates.filter(({ axis }) => axis === "genre");
    expect(genrePredicates).toHaveLength(1);
    expect(genrePredicates[0]).toMatchObject({
      operator: "require",
      values: expect.arrayContaining([
        "hip-hop",
        "hip hop",
        "rap",
        "grime",
        "grime music",
        "UK grime",
      ]),
    });
    expect(evaluateCandidateMembershipV3(
      genreCandidateMemberships(["rap"]),
      spec.membershipPredicates,
    ).eligible).toBe(true);
    expect(evaluateCandidateMembershipV3(
      genreCandidateMemberships(["UK grime"]),
      spec.membershipPredicates,
    ).eligible).toBe(true);
    expect(evaluateCandidateMembershipV3(
      genreCandidateMemberships(["drill"]),
      spec.membershipPredicates,
    ).eligible).toBe(false);
  });

  test("compiles Pop Smoke as an excluded primary reference with discovery emphasis", () => {
    const spec = createRunSpecV3({
      prompt: "create a playlist for bike rides for a hipster who loves rap music and grime. His favorite rapper is Pop Smoke but he wants to discover new stuff",
      requestedTrackCount: 50,
      brief: {
        mode: "curated",
        title: "Echo Park Ride Drift",
        description: "Rap and grime for a bike ride.",
        subjectEntities: ["Pop Smoke"],
        relationship: "stylistically similar to the reference artist",
        include: ["New rap and grime artists"],
        exclude: ["Reference artist is a style seed; exclude recordings by: Pop Smoke"],
        versionPolicy: "one canonical recording",
        evidencePolicy: "source-backed",
        orderingPolicy: "high-energy flow",
        targetSize: { min: 50, max: 50 },
        ambiguities: [],
      },
    });
    expect(spec.intents).toContain("similarity");
    expect(spec.membershipPredicates).toContainEqual(expect.objectContaining({
      axis: "artist",
      operator: "exclude",
      values: ["Pop Smoke"],
    }));
    expect(spec.rankingObjectives).toEqual(expect.arrayContaining([
      expect.objectContaining({ dimension: "similarity", values: ["Pop Smoke"] }),
      expect.objectContaining({
        dimension: "relevance",
        values: ["new artists", "emerging artists"],
      }),
    ]));
  });

  test("asks a neutral time-width question for the exact 2010 rap incident", () => {
    const spec = createRunSpecV3({
      prompt: "create me a playlist fromm the 2010 rap",
      requestedTrackCount: 50,
    });
    expect(spec.membershipPredicates).toContainEqual(expect.objectContaining({
      axis: "genre",
      values: expect.arrayContaining(["rap"]),
    }));
    expect(spec.catalogPolicies).not.toContainEqual(expect.objectContaining({ axis: "era" }));
    expect(spec.criticalAmbiguities).toContainEqual(expect.objectContaining({
      key: "temporal_width",
      yearValue: 2010,
      trust: "server_derived",
      resolution: "pending_question",
    }));

    const questions = criticalGuidanceQuestionsV3(spec);
    expect(questions).toContainEqual(expect.objectContaining({
      id: "v3-critical:temporal_width",
      options: [
        expect.objectContaining({ id: "era_year_only", recommended: false }),
        expect.objectContaining({ id: "era_around_year", recommended: false }),
        expect.objectContaining({ id: "era_full_decade", recommended: false }),
      ],
    }));
    const resolved = resolveRunSpecV3(spec, [{
      key: "temporal_width",
      optionId: "era_full_decade",
    }]);
    expect(resolved.confirmed).toBe(true);
    expect(resolved.criticalAmbiguities).toContainEqual(
      expect.objectContaining({
        key: "temporal_width",
        trust: "server_derived",
        resolution: "answered_successor",
      }),
    );
    expect(resolved.membershipPredicates).toContainEqual(expect.objectContaining({
      axis: "era",
      values: ["2010", "2019"],
    }));
  });

  test("does not turn the pronoun us into geography and keeps R&B as membership", () => {
    const spec = createRunSpecV3({
      prompt: "i met a girl from long island in del mar 10 years ago and i want r&b music from that time period that relates to us meeting",
      requestedTrackCount: 25,
    });
    expect(spec.membershipPredicates).toContainEqual(expect.objectContaining({
      axis: "genre",
      values: expect.arrayContaining(["R&B"]),
    }));
    expect(spec.membershipPredicates).not.toContainEqual(expect.objectContaining({
      axis: "geography",
      values: expect.arrayContaining(["United States"]),
    }));
  });

  test("recognizes explicit US musical scope without recognizing lowercase us", () => {
    const explicit = createRunSpecV3({
      prompt: "25 US rap tracks",
      requestedTrackCount: 25,
    });
    expect(explicit.membershipPredicates).toContainEqual(expect.objectContaining({
      axis: "scene",
      values: ["American rap"],
    }));
    const narrative = createRunSpecV3({
      prompt: "25 rap tracks that remind us of meeting",
      requestedTrackCount: 25,
    });
    expect(narrative.membershipPredicates).not.toContainEqual(expect.objectContaining({
      axis: "geography",
      values: ["United States"],
    }));
  });

  test("routes a pure late-night vibe without inventing genre membership", () => {
    const spec = createRunSpecV3({
      prompt: "Late-Night Smoke: chill music for gaming and a smoke session",
      requestedTrackCount: 25,
    });
    expect(spec.intents).toContain("mood_activity");
    expect(spec.intents).not.toContain("genre_scene");
    expect(spec.membershipPredicates).not.toContainEqual(expect.objectContaining({
      axis: "genre",
    }));
  });

  test("provides a deterministic subject-specific fallback for broad Brazilian disco guidance", () => {
    const questions = deterministicGuidanceQuestionsV3(createRunSpecV3({
      prompt: "brazilian disco playlist",
      requestedTrackCount: 25,
    }));
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({
      id: "v3-fallback:brazilian_disco_focus",
      decisionKey: "brazilian_disco_focus",
      options: [
        { id: "brazilian_disco_staples", recommended: true },
        { id: "brazilian_disco_boogie", recommended: false },
        { id: "brazilian_disco_balanced", recommended: false },
      ],
    });
    expect(deterministicGuidanceQuestionsV3(createRunSpecV3({
      prompt: "Kind of Blue album",
      requestedTrackCount: 5,
    }))).toEqual([]);
  });

  test("collapses baile funk aliases and ranks ordinary TikTok breakout context", () => {
    const spec = createRunSpecV3({
      prompt: "69 baile funk TikTok breakouts",
      requestedTrackCount: 69,
    });
    const genres = spec.membershipPredicates.filter((item) => item.axis === "genre");
    expect(genres).toHaveLength(1);
    expect(genres[0]?.values).toEqual(["funk carioca", "baile funk"]);
    expect(spec.membershipPredicates.some((item) => item.axis === "theme")).toBe(false);
    expect(spec.rankingObjectives).toContainEqual(expect.objectContaining({
      dimension: "relevance",
      values: ["TikTok breakout", "TikTok virality"],
    }));
    expect(spec.semanticAudit).toMatchObject({
      passed: true,
      musicConceptPolicyVersion: MUSIC_CONCEPT_POLICY_VERSION,
      aliasCollapses: ["baile funk|funk carioca=>funk carioca"],
    });
    expect(spec.musicConceptPolicyVersion).toBe(MUSIC_CONCEPT_POLICY_VERSION);
    expect(spec.userGoal?.requestedTrackCount).toBe(69);
  });

  test("keeps virality as hard membership only when the raw request makes it mandatory", () => {
    const spec = createRunSpecV3({
      prompt: "69 baile funk tracks; every track must have documented TikTok virality",
      requestedTrackCount: 69,
    });
    expect(spec.membershipPredicates).toContainEqual(expect.objectContaining({
      axis: "theme",
      operator: "require",
      values: ["TikTok breakout", "TikTok virality"],
    }));
  });

  test("does not replay generated evidence and version prose as legacy hard gates", () => {
    const spec = createRunSpecV3({
      prompt: "69 baile funk TikTok breakouts",
      requestedTrackCount: 69,
      typedSelectionPlan: typedPlan([
          { id: "genre", axis: "genre", operator: "require", values: ["baile funk", "funk"], kind: "hard", relaxationRank: null },
          { id: "evidence", axis: "evidence", operator: "require", values: ["strong TikTok evidence"], kind: "hard", relaxationRank: null },
          { id: "version", axis: "recording_version", operator: "require", values: ["the primary viral upload"], kind: "hard", relaxationRank: null },
          { id: "prefer-br", axis: "geography", operator: "prefer", values: ["Brazil"], kind: "soft", relaxationRank: 1 },
          { id: "avoid-br", axis: "geography", operator: "avoid", values: ["Brazil"], kind: "soft", relaxationRank: 2 },
      ]),
    });
    expect(spec.hardConstraints.map(({ axis }) => axis).sort()).toEqual(["genre"]);
    expect(spec.softPreferences.map(({ id }) => id)).toEqual(["prefer-br"]);
    expect(spec.membershipPredicates.filter(({ axis }) => axis === "genre")).toHaveLength(1);
    expect(spec.membershipPredicates.find(({ axis }) => axis === "genre")?.values)
      .toEqual(["funk carioca", "baile funk"]);
  });

  test("replays the Rio disco incident without turning listener context or generated prose into evidence gates", () => {
    const prompt = "Rio Disco Classics: An exact 49-track playlist of iconic disco songs that someone born around 1960 in Rio de Janeiro would likely have grown up hearing in discoteques and nightlife settings.";
    const spec = createRunSpecV3({
      prompt,
      requestedTrackCount: 49,
      typedSelectionPlan: typedPlan([
        { id: "scope_1", axis: "genre", operator: "require", values: ["disco"], kind: "hard", relaxationRank: null },
        { id: "scope_2", axis: "geography", operator: "require", values: ["Rio de Janeiro"], kind: "hard", geographyRelationship: "unspecified", relaxationRank: null },
        { id: "scope_3", axis: "era", operator: "within", values: ["1960s onward"], kind: "hard", relaxationRank: null },
        { id: "evidence_1", axis: "evidence", operator: "require", values: ["documented cultural relevance"], kind: "hard", relaxationRank: null },
        { id: "version_1", axis: "recording_version", operator: "require", values: ["prefer the historically canonical version"], kind: "hard", relaxationRank: null },
      ]),
    });

    expect(spec.requestedTrackCount).toBe(49);
    expect(spec.membershipPredicates).toEqual([
      expect.objectContaining({ axis: "genre", operator: "require", values: ["disco"] }),
    ]);
    expect(spec.hardConstraints.map(({ axis }) => axis)).toEqual(["genre"]);
    expect(spec.contextSignals).toContainEqual(expect.objectContaining({
      role: "context",
      axis: "geography",
      values: ["Rio de Janeiro"],
    }));
    expect(spec.catalogPolicies).toEqual(expect.arrayContaining([
      expect.objectContaining({ axis: "era", operator: "prefer", explicitUserAuthored: false }),
      expect.objectContaining({ axis: "recording_version", operator: "prefer", explicitUserAuthored: false }),
    ]));
    expect(spec.recordingPolicy.allowedVersions).toEqual(["canonical", "clean", "explicit"]);
    expect(spec.semanticClauses.filter(({ role }) => role === "membership").every(({ axis }) => (
      !["geography", "era", "recording_version", "evidence"].includes(axis)
    ))).toBe(true);
  });

  test("does not let generated compatibility prose change the explicit user-constraint hash", () => {
    const prompt = "49 iconic disco songs heard in Rio nightlife";
    const base = createRunSpecV3({ prompt, requestedTrackCount: 49 });
    const compatibility = createRunSpecV3({
      prompt,
      requestedTrackCount: 49,
      typedSelectionPlan: typedPlan([
        { id: "evidence_99", axis: "evidence", operator: "require", values: ["some generated evidence prose"], kind: "hard", relaxationRank: null },
        { id: "version_99", axis: "recording_version", operator: "require", values: ["some generated version prose"], kind: "hard", relaxationRank: null },
        { id: "scope_99", axis: "era", operator: "within", values: ["1960s onward"], kind: "hard", relaxationRank: null },
      ]),
    });
    expect(compatibility.explicitUserConstraintHash).toBe(base.explicitUserConstraintHash);
    expect(compatibility.semanticAudit?.hardConstraintHash).toBe(base.semanticAudit?.hardConstraintHash);
  });

  test.each([
    ["Only tracks by artists born in France", "geography", "France", "artist_origin"],
    ["Only tracks by artists living in Berlin", "geography", "Berlin", "artist_residence"],
    ["Only tracks recorded in Rio de Janeiro", "geography", "Rio de Janeiro", "recording_location"],
    ["Only Portuguese-language tracks", "language", "Portuguese", "language"],
  ] as const)("keeps an explicit geographic or language relationship hard: %s", (prompt, axis, value, relationship) => {
    const spec = createRunSpecV3({ prompt, requestedTrackCount: 25 });
    expect(spec.membershipPredicates).toContainEqual(expect.objectContaining({
      axis,
      values: [value],
      geographyRelationship: relationship,
    }));
    if (axis === "geography") {
      expect(spec.contextSignals.some((signal) => signal.values.includes(value))).toBe(false);
    }
  });

  test("enforces an explicit live-only request as catalog policy rather than evidence membership", () => {
    const spec = createRunSpecV3({ prompt: "25 jazz tracks, only live versions", requestedTrackCount: 25 });
    expect(spec.membershipPredicates.some(({ axis }) => axis === "recording_version" || axis === "content")).toBe(false);
    expect(spec.catalogPolicies).toContainEqual(expect.objectContaining({
      axis: "recording_version",
      role: "catalog_policy",
      explicitUserAuthored: true,
    }));
    expect(spec.recordingPolicy.allowedVersions).toEqual(["live"]);
  });

  test.each([
    ["Disco for a Paris dinner", "Paris"],
    ["Disco for driving through Los Angeles", "Los Angeles"],
    ["Disco popular with listeners in Brazil", "Brazil"],
  ] as const)("keeps listening setting geography as context: %s", (prompt, geography) => {
    const spec = createRunSpecV3({ prompt, requestedTrackCount: 25 });
    expect(spec.contextSignals).toContainEqual(expect.objectContaining({ values: [geography] }));
    expect(spec.membershipPredicates.some(({ axis }) => axis === "geography")).toBe(false);
    expect(spec.membershipPredicates).toContainEqual(expect.objectContaining({ axis: "genre", values: ["disco"] }));
  });

  test("separates house music from a lyrical theme about houses", () => {
    const genre = createRunSpecV3({ prompt: "50 influential house music tracks", requestedTrackCount: 50 });
    expect(genre.criticalAmbiguities).toEqual([]);
    expect(genre.intents).toEqual(expect.arrayContaining(["genre_scene", "editorial_ranking"]));
    expect(genre.membershipPredicates).toContainEqual(expect.objectContaining({
      axis: "genre",
      operator: "require",
      values: ["house music", "house"],
    }));

    const theme = createRunSpecV3({ prompt: "25 songs about houses and homes", requestedTrackCount: 25 });
    expect(theme.criticalAmbiguities).toEqual([]);
    expect(theme.intents).toContain("theme");
    expect(theme.membershipPredicates).toContainEqual(expect.objectContaining({
      axis: "theme",
      values: ["houses and homes"],
    }));

    const ambiguous = createRunSpecV3({ prompt: "Make me a house playlist", requestedTrackCount: 25 });
    expect(ambiguous.criticalAmbiguities.map(({ key }) => key)).toEqual(["house_semantics"]);
    expect(ambiguous.membershipPredicates.some(({ axis }) => axis === "genre" || axis === "theme")).toBe(false);
    const questions = criticalGuidanceQuestionsV3(ambiguous);
    expect(questions).toHaveLength(1);
    expect(questions[0]?.options.map(({ id }) => id)).toEqual(["house_genre", "house_theme", "house_both"]);
    const answers = criticalAmbiguityAnswersFromGuidanceV3(ambiguous, [{
      questionId: "v3-critical:house_semantics",
      optionId: "house_genre",
    }]);
    expect(resolveRunSpecV3(ambiguous, answers)).toMatchObject({ confirmed: true });
  });

  test("critical guidance survives unrelated scout questions and supports bounded custom scope", () => {
    const spec = createRunSpecV3({ prompt: "French jazz", requestedTrackCount: 25 });
    const answers = criticalAmbiguityAnswersFromGuidanceV3(spec, [
      { questionId: "unrelated-scout-question", optionId: "anything" },
      { questionId: "v3-critical:french_jazz_scope", customText: "Artists active in Paris between 1945 and 1975" },
    ]);
    expect(answers).toEqual([{
      key: "french_jazz_scope",
      optionId: "custom",
      customValue: "Artists active in Paris between 1945 and 1975",
    }]);
    expect(resolveRunSpecV3(spec, answers).confirmed).toBe(true);
  });

  test("does not silently choose a meaning for French jazz", () => {
    const spec = createRunSpecV3({ prompt: "French jazz across the decades", requestedTrackCount: 100 });
    expect(spec.criticalAmbiguities.map(({ key }) => key)).toContain("french_jazz_scope");
    expect(spec.membershipPredicates).toContainEqual(expect.objectContaining({ axis: "genre", values: ["jazz"] }));

    const plan = resolveRunSpecV3(spec, [{
      key: "french_jazz_scope",
      optionId: "french_scene",
    }]);
    expect(plan.confirmed).toBe(true);
    expect(plan.membershipPredicates).toContainEqual(expect.objectContaining({
      axis: "scene",
      values: ["French jazz scene"],
      source: "guided_answer",
    }));
  });

  test("requires an explicit relationship for possessive editorial requests", () => {
    const spec = createRunSpecV3({
      prompt: "Paulinho da Costa's 176 most influential songs",
      requestedTrackCount: 176,
    });
    expect(spec.criticalAmbiguities.map(({ key }) => key)).toContain("possessive_relationship");
    expect(spec.intents).toContain("editorial_ranking");

    const plan = resolveRunSpecV3(spec, [{
      key: "possessive_relationship",
      optionId: "subject_performed",
    }]);
    expect(plan.confirmed).toBe(true);
    expect(plan.intents).toContain("factual_relationship");
    expect(plan.engines).toContain("factual_relationship");
    expect(plan.membershipPredicates).toContainEqual(expect.objectContaining({
      axis: "factual_relationship",
      values: ["subject_performed"],
    }));
  });

  test("distinguishes funk carioca from Brazilian soul-and-funk traditions", () => {
    const ambiguous = createRunSpecV3({ prompt: "Brazilian funk essentials", requestedTrackCount: 50 });
    expect(ambiguous.criticalAmbiguities.map(({ key }) => key)).toContain("brazilian_funk_semantics");

    const baile = createRunSpecV3({ prompt: "Baile funk and funk carioca essentials", requestedTrackCount: 50 });
    expect(baile.criticalAmbiguities).toEqual([]);
    expect(baile.membershipPredicates).toContainEqual(expect.objectContaining({
      axis: "genre",
      values: ["funk carioca", "baile funk"],
    }));
    expect(evaluateCandidateMembershipV3(genreCandidateMemberships(["funk carioca"]), baile.membershipPredicates).eligible).toBe(true);
    expect(evaluateCandidateMembershipV3(genreCandidateMemberships(["baile funk"]), baile.membershipPredicates).eligible).toBe(true);
    expect(evaluateCandidateMembershipV3(genreCandidateMemberships(["Brazilian funk"]), baile.membershipPredicates).eligible).toBe(false);

    const seventies = createRunSpecV3({ prompt: "1970s Brazilian soul and funk", requestedTrackCount: 50 });
    expect(seventies.criticalAmbiguities).toEqual([]);
    expect(seventies.membershipPredicates).toContainEqual(expect.objectContaining({
      axis: "genre",
      values: ["Brazilian soul and funk"],
    }));
  });

  test("routes multi-intent requests deterministically and excludes similarity seeds", () => {
    const spec = createRunSpecV3({
      prompt: "Dark dance tracks similar to Beyoncé, but other artists only",
      requestedTrackCount: 25,
      storefront: "US",
    });
    expect(spec.storefront).toBe("us");
    expect(spec.intents).toEqual(expect.arrayContaining(["similarity", "mood_activity"]));
    expect(spec.engines).toEqual(expect.arrayContaining(["similarity", "mood_activity_theme"]));
    expect(spec.membershipPredicates).toContainEqual(expect.objectContaining({
      axis: "artist",
      operator: "exclude",
      values: ["beyonce"],
    }));
    expect(spec.rankingObjectives).toContainEqual(expect.objectContaining({ dimension: "similarity" }));
  });

  test("treats ordinary multi-genre requests as a playlist-level union", () => {
    const spec = createRunSpecV3({
      prompt: "50 disco and house tracks",
      requestedTrackCount: 50,
    });
    expect(spec.criticalAmbiguities).toEqual([]);
    const genrePredicates = spec.membershipPredicates.filter(({ axis, operator }) => (
      axis === "genre" && operator === "require"
    ));
    expect(genrePredicates).toHaveLength(1);
    expect(genrePredicates[0]).toMatchObject({ values: ["disco", "house music", "house"] });
    expect(evaluateCandidateMembershipV3(genreCandidateMemberships(["disco"]), spec.membershipPredicates).eligible).toBe(true);
    expect(evaluateCandidateMembershipV3(genreCandidateMemberships(["house"]), spec.membershipPredicates).eligible).toBe(true);
    expect(evaluateCandidateMembershipV3(genreCandidateMemberships(["techno"]), spec.membershipPredicates).eligible).toBe(false);
    expect(spec.requestedTrackCount).toBe(50);
  });

  test("requires both genre bindings only for an explicit fusion", () => {
    const spec = createRunSpecV3({
      prompt: "25 disco and house fusion tracks",
      requestedTrackCount: 25,
    });
    const genrePredicates = spec.membershipPredicates.filter(({ axis, operator }) => (
      axis === "genre" && operator === "require"
    ));
    expect(genrePredicates.map(({ values }) => values)).toEqual([["disco"], ["house music", "house"]]);
    expect(evaluateCandidateMembershipV3(genreCandidateMemberships(["disco"]), spec.membershipPredicates).eligible).toBe(false);
    expect(evaluateCandidateMembershipV3(genreCandidateMemberships(["disco", "house"]), spec.membershipPredicates).eligible).toBe(true);
  });

  test.each([
    ["Brazilian disco songs", "disco", "Brazilian disco"],
    ["American drill tracks", "drill", "American drill"],
    ["Berlin techno across the major eras", "techno", "Berlin techno"],
    ["Detroit techno essentials", "techno", "Detroit techno"],
    ["Chicago house classics", "house", "Chicago house"],
    ["UK drill essentials", "drill", "UK drill"],
  ] as const)("represents a recognized geographic genre as one scene concept: %s", (prompt, _genre, scene) => {
    const spec = createRunSpecV3({ prompt, requestedTrackCount: 50 });
    expect(spec.membershipPredicates.some(({ axis }) => axis === "genre")).toBe(false);
    expect(spec.membershipPredicates).toContainEqual(expect.objectContaining({
      axis: "scene",
      operator: "require",
      values: [scene],
    }));
    expect(spec.membershipPredicates.some(({ axis }) => axis === "geography")).toBe(false);
  });

  test("keeps multiple geographic genre scenes as alternatives by default", () => {
    const spec = createRunSpecV3({
      prompt: "50 Detroit techno and Chicago house tracks",
      requestedTrackCount: 50,
    });
    expect(spec.membershipPredicates.some(({ axis }) => axis === "genre")).toBe(false);
    expect(spec.membershipPredicates).toContainEqual(expect.objectContaining({
      axis: "scene",
      operator: "require",
      values: ["Detroit techno", "Chicago house"],
    }));
  });

  test("asks which relationship defines an otherwise ambiguous French genre", () => {
    const spec = createRunSpecV3({ prompt: "50 French disco tracks", requestedTrackCount: 50 });
    expect(spec.criticalAmbiguities).toContainEqual(expect.objectContaining({
      key: "geographic_genre_scope",
      genreLabel: "disco",
      sceneValue: "French disco",
      originValue: "France",
      languageValue: "French",
    }));
    expect(spec.membershipPredicates).toContainEqual(expect.objectContaining({
      axis: "genre",
      values: ["disco"],
    }));
    expect(spec.membershipPredicates.some(({ axis }) => axis === "scene" || axis === "geography" || axis === "language"))
      .toBe(false);

    const question = criticalGuidanceQuestionsV3(spec)[0]!;
    expect(question.options.map(({ id }) => id)).toEqual([
      "geographic_artist_origin",
      "geographic_scene",
      "geographic_language",
    ]);
    const plan = resolveRunSpecV3(spec, [{
      key: "geographic_genre_scope",
      optionId: "geographic_scene",
    }]);
    expect(plan.confirmed).toBe(true);
    expect(plan.membershipPredicates).toContainEqual(expect.objectContaining({
      axis: "scene",
      values: ["French disco"],
      source: "guided_answer",
    }));
  });

  test("honors an explicit French artist-origin relationship without guidance", () => {
    const spec = createRunSpecV3({
      prompt: "50 jazz tracks by French artists",
      requestedTrackCount: 50,
    });
    expect(spec.criticalAmbiguities).toEqual([]);
    expect(spec.membershipPredicates).toContainEqual(expect.objectContaining({
      axis: "geography",
      values: ["France"],
    }));
  });

  test.each(["disco songs", "drill tracks", "techno across the major eras"])(
    "does not invent geographic scene scope for a generic genre: %s",
    (prompt) => {
      const spec = createRunSpecV3({ prompt, requestedTrackCount: 50 });
      expect(spec.membershipPredicates.some(({ axis }) => axis === "scene")).toBe(false);
    },
  );

  test("recognizes natural tracks-like phrasing without treating the seed as filler", () => {
    const spec = createRunSpecV3({
      prompt: "50 house music tracks like Beyonce but do not include Beyonce",
      requestedTrackCount: 50,
    });

    expect(spec.intents).toContain("similarity");
    expect(spec.engines).toContain("similarity");
    expect(spec.membershipPredicates).toContainEqual(expect.objectContaining({
      axis: "artist",
      operator: "exclude",
      values: ["beyonce"],
    }));
  });

  test("freezes the complete run contract at the executable owner boundary", () => {
    const spec = createRunSpecV3({ prompt: "Berlin techno", requestedTrackCount: 50 });
    expect(Object.isFrozen(spec)).toBe(true);
    expect(Object.isFrozen(spec.membershipPredicates)).toBe(true);
    expect(() => createRunSpecV3({
      prompt: "Berlin techno",
      requestedTrackCount: 1_001,
    })).toThrow(/between 1 and 1000/i);
  });

  test.each([150, 176, 300, 301, 1_000])(
    "preserves the authoritative requested count %i",
    (requestedTrackCount) => {
    const spec = createRunSpecV3({ prompt: "Detroit techno", requestedTrackCount });
    expect(spec.requestedTrackCount).toBe(requestedTrackCount);
    expect(resolveRunSpecV3(spec, []).requestedTrackCount).toBe(requestedTrackCount);
    },
  );
});
