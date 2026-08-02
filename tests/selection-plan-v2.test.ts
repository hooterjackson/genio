import { describe, expect, test } from "vitest";
import type { PlaylistBrief } from "../shared/types.ts";
import {
  assignPipelineV2,
  createSelectionPlanV2,
  pipelineRolloutStickyKey,
  pipelineV2Route,
  pipelineV2RolloutGroup,
} from "../server/selection-plan-v2.ts";

function brief(overrides: Partial<PlaylistBrief> = {}): PlaylistBrief {
  return {
    title: "House music",
    description: "A broad, source-backed house music survey.",
    mode: "curated",
    subjectEntities: ["House music"],
    relationship: "is a recording in the house music genre",
    include: ["Recordings musically classified as house music."],
    exclude: ["Do not include songs merely about physical houses."],
    versionPolicy: "Prefer one canonical studio recording.",
    evidencePolicy: "Require track-scope editorial evidence.",
    orderingPolicy: "Smooth listening flow with artists intermixed.",
    targetSize: { min: 50, max: 50 },
    ambiguities: [],
    ...overrides,
  };
}

describe("Pipeline V2 selection plan", () => {
  test("keeps the 2010 rap incident unresolved on time width while preserving rap membership", () => {
    const prompt = "create me a playlist fromm the 2010 rap";
    const plan = createSelectionPlanV2({
      prompt,
      brief: brief({
        title: "2010 Rap",
        description: "Rap from the requested period.",
        subjectEntities: ["rap"],
        relationship: "is rap from the requested period",
        include: ["rap recordings"],
        exclude: [],
      }),
    });

    expect(plan.intents).toContain("genre_scene");
    expect(plan.constraints).toContainEqual(expect.objectContaining({
      axis: "genre",
      kind: "hard",
      values: ["rap"],
    }));
    expect(plan.constraints).not.toContainEqual(expect.objectContaining({
      axis: "era",
      kind: "hard",
    }));
  });

  test("treats lowercase us as narrative context and recognizes R&B membership", () => {
    const prompt = "i met a girl from long island in del mar 10 years ago and i want r&b music from that time period that relates to us meeting";
    const plan = createSelectionPlanV2({
      prompt,
      brief: brief({
        title: "A Coastal R&B Memory",
        description: "R&B related to a meeting ten years ago.",
        subjectEntities: ["R&B"],
        relationship: "evokes the memory of meeting",
        include: ["R&B recordings"],
        exclude: [],
      }),
    });

    expect(plan.constraints).toContainEqual(expect.objectContaining({
      axis: "genre",
      kind: "hard",
      values: ["R&B"],
    }));
    expect(plan.constraints).not.toContainEqual(expect.objectContaining({
      axis: "geography",
      values: expect.arrayContaining(["American"]),
    }));
  });

  test("does not invent genre-scene evidence for a pure late-night vibe request", () => {
    const prompt = "Late-Night Smoke: chill music for gaming and a smoke session";
    const plan = createSelectionPlanV2({
      prompt,
      brief: brief({
        title: "Late-Night Smoke",
        description: "Chill late-night music for gaming.",
        subjectEntities: ["late-night chill"],
        relationship: "fits a late-night gaming and smoke session",
        include: ["chill recordings"],
        exclude: [],
      }),
    });

    expect(plan.intents).toContain("mood_activity");
    expect(plan.intents).not.toContain("genre_scene");
    expect(plan.constraints).not.toContainEqual(expect.objectContaining({
      axis: "genre",
      kind: "hard",
    }));
  });

  test("keeps the production reggaeton request genre-bound while treating its vibe as soft", () => {
    const prompt = "Smooth Reggaeton Heat: A 50-track smooth reggaeton playlist centered on polished, sensual, danceable reggaeton and adjacent Latin urban tracks with a flirtatious, crowd-pleasing vibe.";
    const plan = createSelectionPlanV2({
      prompt,
      brief: brief({
        title: "Smooth Reggaeton Heat",
        description: "A 50-track smooth reggaeton playlist centered on polished, sensual, danceable reggaeton and adjacent Latin urban tracks with a flirtatious, crowd-pleasing vibe.",
        subjectEntities: ["reggaeton", "Latin urban"],
        relationship: "centered on",
        include: [
          "polished reggaeton",
          "sensual reggaeton",
          "danceable reggaeton",
          "adjacent Latin urban tracks",
          "flirtatious vibe",
          "crowd-pleasing club-friendly tracks",
        ],
        exclude: [],
      }),
    });

    expect(plan.intents).toEqual(["genre_scene"]);
    expect(plan.constraints).toContainEqual(expect.objectContaining({
      axis: "genre",
      kind: "hard",
      operator: "require",
      values: ["reggaeton", "Latin urban"],
    }));
    expect(plan.constraints).toContainEqual(expect.objectContaining({
      axis: "mood",
      kind: "soft",
      operator: "prefer",
      values: ["flirtatious vibe"],
    }));
    expect(plan.constraints).not.toContainEqual(expect.objectContaining({
      axis: "mood",
      kind: "hard",
    }));
  });

  test("house music remains a genre and receives broad-playlist diversity goals", () => {
    const plan = createSelectionPlanV2({ prompt: "50 essential house music tracks", brief: brief() });
    expect(plan.policyVersion).toBe("relevance_first_2026_07_r2");
    expect(plan.intents).toContain("genre_scene");
    expect(plan.intents).not.toContain("editorial_ranking");
    expect(plan.constraints).toContainEqual(expect.objectContaining({
      axis: "relationship",
      operator: "prefer",
      kind: "soft",
      values: ["essential"],
    }));
    expect(plan.constraints.some((constraint) => constraint.values.some((value) => value.includes("physical houses")))).toBe(true);
    expect(plan.diversityGoals.maximumTracksPerArtist).toBe(8);
    expect(pipelineV2Route(plan)).toBe("curated_catalog");
  });

  test("treats Brazilian listener and popularity context as a soft market preference", () => {
    const prompt = "Brazil Disco Nights: A 50-track playlist of iconic disco-era songs that a 65-year-old listener in Brazil may plausibly have heard while growing up and going to nightclubs. Emphasis is on widely recognizable disco and disco-adjacent hits from the global 1970s–early 1980s club era, with inclusion of internationally known tracks that were popular in Brazil or strongly associated with nightclub culture.";
    const plan = createSelectionPlanV2({
      prompt,
      brief: brief({
        title: "Brazil Disco Nights",
        description: "International disco-era club hits familiar to a listener in Brazil.",
        subjectEntities: ["disco", "global club hits", "Brazilian audience"],
        relationship: "was a widely recognizable disco-era club recording",
        include: ["International disco staples popular in Brazil"],
        exclude: [],
        targetSize: { min: 50, max: 50 },
      }),
    });

    expect(plan.constraints).toContainEqual(expect.objectContaining({
      axis: "genre",
      kind: "hard",
      operator: "require",
      values: ["disco"],
    }));
    expect(plan.constraints).toContainEqual(expect.objectContaining({
      id: expect.stringMatching(/^audience_market_preference_/u),
      axis: "geography",
      kind: "soft",
      operator: "prefer",
      values: ["Brazilian"],
      geographyRelationship: "unspecified",
    }));
    expect(plan.constraints).not.toContainEqual(expect.objectContaining({
      axis: "geography",
      kind: "hard",
      values: ["Brazilian"],
    }));
    expect(plan.geographyConstraints).not.toContainEqual({
      value: "Brazilian",
      relationship: "unspecified",
    });
  });

  test("keeps the visitor's original growing-up-in-Brazil wording out of hard track geography", () => {
    const plan = createSelectionPlanV2({
      prompt: "Iconic disco songs my father who is 65 might have listened to growing up in Brazil and going to night clubs",
      brief: brief({
        title: "Brazil Disco Nights",
        description: "International disco hits familiar to a 65-year-old listener who grew up in Brazil.",
        subjectEntities: ["disco", "global nightclub hits"],
        relationship: "was a recognizable disco-era club recording",
        include: ["International disco staples popular in Brazil"],
        exclude: [],
        targetSize: { min: 50, max: 50 },
      }),
    });

    expect(plan.constraints).toContainEqual(expect.objectContaining({
      axis: "genre",
      kind: "hard",
      values: ["disco"],
    }));
    expect(plan.constraints).not.toContainEqual(expect.objectContaining({
      axis: "geography",
      kind: "hard",
      values: ["Brazilian"],
    }));
    expect(plan.geographyConstraints).toEqual([]);
  });

  test.each([
    "50 Brazilian disco songs",
    "50 French jazz recordings",
    "50 American drill tracks",
    "50 disco recordings from Brazil",
  ])("keeps intrinsic music geography hard: %s", (prompt) => {
    const plan = createSelectionPlanV2({
      prompt,
      brief: brief({
        title: prompt,
        subjectEntities: [prompt],
        include: [],
        exclude: [],
      }),
    });
    expect(plan.constraints).toContainEqual(expect.objectContaining({
      axis: "geography",
      kind: "hard",
    }));
    expect(plan.geographyConstraints.length).toBeGreaterThan(0);
  });

  test.each([
    "25 classic house music tracks, not songs about literal houses or homes",
    "25 classic house music tracks; exclude songs about houses",
    "25 classic house music tracks — avoid lyrics about physical homes",
    "25 classic house music tracks rather than a theme about architecture",
  ])("a rejected literal interpretation does not create positive theme evidence: %s", (prompt) => {
    const plan = createSelectionPlanV2({
      prompt,
      brief: brief({
        title: "Classic House Music",
        description: "A source-backed survey of classic house music.",
        relationship: "is a recording in the house music genre",
        targetSize: { min: 25, max: 25 },
      }),
    });

    expect(plan.intents).toContain("genre_scene");
    expect(plan.intents).not.toContain("theme");
  });

  test("a literal-house exclusion is typed as theme rather than era", () => {
    const plan = createSelectionPlanV2({
      prompt: "25 classic house music tracks, not songs about literal houses",
      brief: brief({
        title: "Classic House Music",
        relationship: "is a recording in the house music genre",
        exclude: ["songs about literal houses"],
        targetSize: { min: 25, max: 25 },
      }),
    });

    expect(plan.constraints).toContainEqual(expect.objectContaining({
      axis: "theme",
      operator: "exclude",
      values: ["songs about literal houses"],
      kind: "hard",
    }));
    expect(plan.constraints).not.toContainEqual(expect.objectContaining({
      axis: "era",
      values: ["songs about literal houses"],
    }));
  });

  test.each([
    ["25 classic house music tracks, with no more than two tracks per artist", 2],
    ["25 classic house music tracks; at most 3 songs from any one artist", 3],
    ["25 classic house music tracks; limit each artist to four tracks", 4],
    ["25 classic house music tracks; 1 track from each artist", 1],
    ["25 classic house music tracks; five songs max per artist", 5],
    ["25 classic house music tracks; 2 tracks per artist", 2],
    ["25 classic house music tracks; at most two tracks from a single artist", 2],
  ])("preserves an explicit artist concentration ceiling as a hard rule: %s", (prompt, maximum) => {
    const plan = createSelectionPlanV2({
      prompt,
      brief: brief({ targetSize: { min: 25, max: 25 } }),
    });

    expect(plan.diversityGoals.maximumTracksPerArtist).toBe(maximum);
    expect(plan.constraints).toContainEqual(expect.objectContaining({
      id: "artist_concentration_hard",
      axis: "artist",
      operator: "maximum",
      values: [String(maximum)],
      kind: "hard",
      relaxationRank: null,
    }));
  });

  test("does not confuse an unrelated geographic quantity with an artist track ceiling", () => {
    const plan = createSelectionPlanV2({
      prompt: "25 house tracks by artists from no more than two countries",
      brief: brief({ targetSize: { min: 25, max: 25 } }),
    });

    expect(plan.diversityGoals.maximumTracksPerArtist).not.toBe(2);
    expect(plan.constraints).not.toContainEqual(expect.objectContaining({
      id: "artist_concentration_hard",
    }));
  });

  test.each([
    "25 songs about houses and homes",
    "25 house music tracks about houses and architecture",
    "Not only songs about homes, but also songs about belonging",
    "Do not exclude songs about domestic life",
  ])("an affirmative theme remains a theme intent: %s", (prompt) => {
    const plan = createSelectionPlanV2({
      prompt,
      brief: brief({
        title: "Songs About Home",
        description: "Songs with a documented thematic relationship to homes and domestic life.",
        subjectEntities: ["homes", "domestic life"],
        relationship: "has a lyrical or thematic relationship to homes",
        include: ["Songs about homes and domestic life."],
        exclude: [],
        targetSize: { min: 25, max: 25 },
      }),
    });

    expect(plan.intents).toContain("theme");
  });

  test("does not choose chronology when the brief explicitly rejects strict chronology", () => {
    const plan = createSelectionPlanV2({
      prompt: "25 classic house music tracks with a diverse mix of artists",
      brief: brief({
        orderingPolicy: "Use a smooth listening journey with artists and albums intermixed when supported, rather than strict chronology.",
        targetSize: { min: 25, max: 25 },
      }),
    });

    expect(plan.orderingPolicy.mode).toBe("smooth");
    expect(plan.orderingPolicy.mode).not.toBe("chronological");
  });

  test("iconic remains a soft ranking preference for a broad genre request", () => {
    const plan = createSelectionPlanV2({
      prompt: "Brazil disco nights: iconic Brazilian disco across eras",
      brief: brief({
        title: "Brazil Disco Nights",
        description: "Brazilian disco across eras.",
        subjectEntities: ["Brazilian disco"],
        relationship: "is a Brazilian disco recording",
        include: ["Brazilian disco across multiple eras."],
        exclude: [],
      }),
    });

    expect(plan.intents).toContain("genre_scene");
    expect(plan.intents).not.toContain("editorial_ranking");
    expect(plan.constraints).toEqual(expect.arrayContaining([
      expect.objectContaining({ axis: "genre", kind: "hard", values: expect.arrayContaining(["disco"]) }),
      expect.objectContaining({ axis: "geography", kind: "hard", values: expect.arrayContaining(["Brazilian"]) }),
      expect.objectContaining({ axis: "relationship", operator: "prefer", kind: "soft", values: ["iconic"] }),
    ]));
  });

  test.each(["influential", "foundational"])(
    "%s remains a strict editorial-ranking request",
    (descriptor) => {
      const plan = createSelectionPlanV2({
        prompt: `50 ${descriptor} Brazilian disco tracks`,
        brief: brief({
          title: "Brazilian Disco",
          subjectEntities: ["Brazilian disco"],
          relationship: `is ${descriptor} in Brazilian disco`,
          include: [`${descriptor} Brazilian disco recordings.`],
          exclude: [],
        }),
      });

      expect(plan.intents).toEqual(expect.arrayContaining(["genre_scene", "editorial_ranking"]));
    },
  );

  test.each(["best", "ranked", "top", "greatest", "canonical"])(
    "%s remains a soft curation preference rather than historical influence",
    (descriptor) => {
      const plan = createSelectionPlanV2({
        prompt: `50 ${descriptor} Brazilian disco tracks`,
        brief: brief({
          title: "Brazilian Disco",
          subjectEntities: ["Brazilian disco"],
          relationship: `is ${descriptor} in Brazilian disco`,
          include: [`${descriptor} Brazilian disco recordings.`],
          exclude: [],
        }),
      });

      expect(plan.intents).toContain("genre_scene");
      expect(plan.intents).not.toContain("editorial_ranking");
      expect(plan.constraints).toContainEqual(expect.objectContaining({
        axis: "relationship",
        operator: "prefer",
        kind: "soft",
        values: [descriptor],
      }));
    },
  );

  test("a physical-house theme is not silently constrained to the house-music genre", () => {
    const plan = createSelectionPlanV2({
      prompt: "Songs about a house or home",
      brief: brief({
        title: "Songs About Home",
        description: "Songs whose lyrics or themes concern houses and home.",
        subjectEntities: ["houses", "home"],
        relationship: "has lyrics or themes about a house or home",
        include: ["Songs about physical houses and home."],
        exclude: [],
      }),
    });

    expect(plan.intents).toContain("theme");
    expect(plan.intents).not.toContain("genre_scene");
    expect(plan.constraints.some((constraint) => (
      constraint.kind === "hard"
      && constraint.axis === "genre"
      && constraint.values.includes("house music")
    ))).toBe(false);
  });

  test("an exclusion cue cannot harden an unrelated generated exclusion", () => {
    const plan = createSelectionPlanV2({
      prompt: "House music, no remixes",
      brief: brief({
        exclude: ["Remixes", "Commercial pop music"],
      }),
    });

    expect(plan.constraints).toContainEqual(expect.objectContaining({
      axis: "recording_version",
      operator: "exclude",
      kind: "hard",
      values: ["Remixes"],
    }));
    expect(plan.constraints).toContainEqual(expect.objectContaining({
      operator: "avoid",
      kind: "soft",
      values: expect.arrayContaining(["Commercial pop music"]),
    }));
  });

  test("does not reinterpret excluded live and remix versions as preferences", () => {
    const plan = createSelectionPlanV2({
      prompt: "Brazilian disco and boogie from the 1970s and 1980s",
      brief: brief({
        versionPolicy: "Prefer one canonical studio recording; avoid later remixes and live versions.",
      }),
    });

    expect(plan.versionPolicy.preferred).toEqual(["canonical"]);
    expect(plan.versionPolicy.allowed).toEqual(["canonical", "remaster", "clean", "explicit", "unknown"]);
    expect(plan.versionPolicy.preferred).not.toEqual(expect.arrayContaining(["live", "remix"]));
    expect(plan.versionPolicy.allowed).not.toEqual(expect.arrayContaining(["live", "remix"]));
  });

  test("does not let a quantifier reverse an explicit version exclusion", () => {
    const plan = createSelectionPlanV2({
      prompt: "Build the exact named original studio recordings",
      brief: brief({
        versionPolicy:
          "Use only the original studio recordings explicitly named or unambiguously matching the canonical album versions; exclude all alternate versions.",
      }),
    });
    expect(plan.versionPolicy.allowed).toEqual(["canonical"]);
    expect(plan.versionPolicy.preferred).toEqual(["canonical"]);
    expect(plan.versionPolicy.allowed).not.toContain("alternate");
  });

  test("keeps fixed-list exclusions hard without inventing an open-world duplicate predicate", () => {
    const prompt = [
      "Build a playlist containing exactly these three original studio recordings, in this order:",
      "1. Michael Jackson — Billie Jean",
      "2. Madonna — La Isla Bonita",
      "3. Earth, Wind & Fire — September",
      "Exclude remixes, live versions, radio edits, covers, re-recordings, and duplicates.",
    ].join("\n");
    const plan = createSelectionPlanV2({
      prompt,
      brief: brief({
        targetSize: { min: 3, max: 3 },
        include: [
          "Michael Jackson — Billie Jean",
          "Madonna — La Isla Bonita",
          "Earth, Wind & Fire — September",
        ],
        exclude: [
          "remixes",
          "live versions",
          "radio edits",
          "covers",
          "re-recordings",
          "duplicates",
        ],
        orderingPolicy: "Preserve the exact listed order.",
      }),
    });
    for (const value of ["covers", "re-recordings"]) {
      expect(plan.constraints).toContainEqual(expect.objectContaining({
        axis: "recording_version",
        kind: "hard",
        operator: "exclude",
        values: [value],
      }));
    }
    expect(plan.constraints).not.toContainEqual(expect.objectContaining({
      axis: "relationship",
      kind: "hard",
      operator: "exclude",
      values: ["duplicates"],
    }));
    expect(plan.fixedTrackList).toEqual([
      { artist: "Michael Jackson", title: "Billie Jean" },
      { artist: "Madonna", title: "La Isla Bonita" },
      { artist: "Earth, Wind & Fire", title: "September" },
    ]);
  });

  test("does not extend an exclusion across an adversative inclusion", () => {
    const plan = createSelectionPlanV2({
      prompt: "Exclude remixes, but include live recordings.",
      brief: brief({
        exclude: ["remixes", "live recordings"],
      }),
    });
    expect(plan.constraints).toContainEqual(expect.objectContaining({
      kind: "hard",
      operator: "exclude",
      values: ["remixes"],
    }));
    expect(plan.constraints).not.toContainEqual(expect.objectContaining({
      kind: "hard",
      operator: "exclude",
      values: ["live recordings"],
    }));
  });

  test("does not let an avoidance cue cross an unless boundary and exclude canonical recordings", () => {
    const plan = createSelectionPlanV2({
      prompt: "Brazilian disco, boogie, and disco-funk from the 1970s and 1980s",
      brief: brief({
        versionPolicy: "Prefer original 1970s/1980s album or single versions; avoid later remixes, edits, or compilations unless needed to identify the canonical recording.",
      }),
      storefront: "us",
    });

    expect(plan.versionPolicy.preferred).toEqual(["canonical"]);
    expect(plan.versionPolicy.allowed).toContain("canonical");
    expect(plan.versionPolicy.allowed).not.toContain("remix");
    expect(plan.versionPolicy.allowed).not.toContain("radio_edit");
    expect(plan.versionPolicy.excludeCompilations).toBe(true);
  });

  test("keeps original-era recordings canonical when remasters are conditionally allowed", () => {
    const plan = createSelectionPlanV2({
      prompt: "Brazilian disco songs",
      brief: brief({
        versionPolicy: "Prefer original-era recordings; include later reissues or remasters only if they preserve the original track identity.",
      }),
      storefront: "us",
    });

    expect(plan.versionPolicy.preferred).toEqual(["canonical"]);
    expect(plan.versionPolicy.allowed).toEqual(["canonical", "remaster", "clean", "explicit", "unknown"]);
  });

  test("does not interpret a conditional only-if clause as a global version whitelist", () => {
    const plan = createSelectionPlanV2({
      prompt: "Original house recordings",
      brief: brief({
        versionPolicy: "Prefer original-era versions. Allow remasters only if the original recording identity is preserved.",
      }),
    });

    expect(plan.versionPolicy.allowed).toEqual(["canonical", "remaster", "clean", "explicit", "unknown"]);
    expect(plan.versionPolicy.preferred).toEqual(["canonical"]);
  });

  test("keeps canonical preferred and remasters as fallback for the production wording", () => {
    const plan = createSelectionPlanV2({
      prompt: "Brazilian disco songs",
      brief: brief({
        versionPolicy: "Avoid remasters unless no canonical recording is available.",
      }),
    });

    expect(plan.versionPolicy.preferred).toEqual(["canonical"]);
    expect(plan.versionPolicy.allowed).toEqual(["canonical", "remaster", "clean", "explicit", "unknown"]);
  });

  test("keeps original house versions preferred when later edits are conditional", () => {
    const plan = createSelectionPlanV2({
      prompt: "House music",
      brief: brief({
        versionPolicy: "Prefer original or definitive versions when multiple commonly cited versions exist; include later edits only if they are historically central or more widely recognized than the original.",
      }),
    });

    expect(plan.versionPolicy.preferred).toEqual(["canonical"]);
    expect(plan.versionPolicy.allowed).toEqual([
      "canonical",
      "remaster",
      "clean",
      "explicit",
      "unknown",
      "radio_edit",
    ]);
  });

  test("treats an only-if remaster as fallback rather than excluding canonical versions", () => {
    const plan = createSelectionPlanV2({
      prompt: "House music",
      brief: brief({
        versionPolicy: "Allow a remaster only if no canonical version is available.",
      }),
    });

    expect(plan.versionPolicy.preferred).toEqual(["canonical"]);
    expect(plan.versionPolicy.allowed).toEqual(["canonical", "remaster", "clean", "explicit", "unknown"]);
  });

  test("preserves an exclusive remaster request whose identity clause is descriptive", () => {
    const plan = createSelectionPlanV2({
      prompt: "Remasters only",
      brief: brief({
        versionPolicy: "Only remasters that preserve the original recording identity.",
      }),
    });

    expect(plan.versionPolicy.preferred).toEqual(["remaster"]);
    expect(plan.versionPolicy.allowed).toEqual(["remaster"]);
  });

  test("retains an actual original-era-only request as exclusive", () => {
    const plan = createSelectionPlanV2({
      prompt: "Original versions only",
      brief: brief({
        versionPolicy: "Original-era versions only.",
      }),
    });

    expect(plan.versionPolicy.preferred).toEqual(["canonical"]);
    expect(plan.versionPolicy.allowed).toEqual(["canonical"]);
  });

  test("does not turn an unrelated only cue into a global version whitelist", () => {
    const plan = createSelectionPlanV2({
      prompt: "House tracks with clean lyrics only when an explicit recording exists",
      brief: brief({
        versionPolicy: "Prefer canonical recordings. Use clean versions only when the canonical recording is explicit.",
      }),
    });

    expect(plan.versionPolicy.allowed).toContain("canonical");
    expect(plan.versionPolicy.allowed).toContain("clean");
  });

  test("keeps compilations when an exclusion cue is explicitly negated", () => {
    const plan = createSelectionPlanV2({
      prompt: "Brazilian disco including compilations",
      brief: brief({
        versionPolicy: "Prefer canonical recordings; do not exclude compilations.",
      }),
    });

    expect(plan.versionPolicy.excludeCompilations).toBe(false);
  });

  test("preserves mixed positive and negative version directives", () => {
    const plan = createSelectionPlanV2({
      prompt: "House music with live performances but no remixes",
      brief: brief({
        versionPolicy: "Prefer live versions but exclude remixes.",
      }),
    });

    expect(plan.versionPolicy.preferred).toEqual(["live"]);
    expect(plan.versionPolicy.allowed).toContain("live");
    expect(plan.versionPolicy.allowed).not.toContain("remix");
  });

  test("keeps negated inclusion phrases negative", () => {
    const plan = createSelectionPlanV2({
      prompt: "Studio recordings only",
      brief: brief({
        versionPolicy: "Do not include live versions or remixes.",
      }),
    });

    expect(plan.versionPolicy.preferred).toEqual(["canonical", "remaster"]);
    expect(plan.versionPolicy.allowed).not.toEqual(expect.arrayContaining(["live", "remix"]));
  });

  test("retains explicitly requested noncanonical versions", () => {
    const plan = createSelectionPlanV2({
      prompt: "Include live versions, remixes, and radio edits",
      brief: brief({
        versionPolicy: "Include live versions, remixes, and radio edits.",
      }),
    });

    expect(plan.versionPolicy.preferred).toEqual(["live", "remix", "radio_edit"]);
    expect(plan.versionPolicy.allowed).toEqual(expect.arrayContaining(["live", "remix", "radio_edit"]));
  });

  test("composite similarity constraints survive without including the reference artist by default", () => {
    const plan = createSelectionPlanV2({
      prompt: "Songs like Radiohead, focused on production and harmony, but no Radiohead and only clean versions",
      brief: brief({
        title: "Radiohead-adjacent",
        subjectEntities: ["Radiohead"],
        relationship: "stylistically similar to the reference artist",
        include: ["Production and harmonic similarity."],
        exclude: ["Reference artist is a style seed; exclude recordings by: Radiohead"],
        versionPolicy: "Clean versions only.",
      }),
    });
    expect(plan.intents).toContain("similarity");
    expect(plan.similarityDimensions).toEqual(expect.arrayContaining(["production", "harmony"]));
    expect(plan.referenceRecordings).toEqual(["Radiohead"]);
    expect(plan.contentPolicy.explicitContent).toBe("clean_only");
  });

  test("preserves genre, geography, language, and era as independent hard constraints", () => {
    const plan = createSelectionPlanV2({
      prompt: "American house music from the 1990s, sung in French",
      brief: brief({
        title: "French-language American house",
        subjectEntities: ["American French-language house music"],
        relationship: "is a house music recording from the American scene sung in French",
        include: ["American house music from the 1990s", "French-language recordings"],
        exclude: [],
      }),
    });
    const hard = plan.constraints.filter((constraint) => constraint.kind === "hard");
    expect(hard).toEqual(expect.arrayContaining([
      expect.objectContaining({ axis: "genre", operator: "require", values: expect.arrayContaining(["house music"]) }),
      expect.objectContaining({
        axis: "geography",
        operator: "require",
        values: expect.arrayContaining(["American"]),
        geographyRelationship: "unspecified",
      }),
      expect.objectContaining({
        axis: "language",
        operator: "require",
        values: expect.arrayContaining(["French"]),
        geographyRelationship: "language",
      }),
      expect.objectContaining({ axis: "era", operator: "within", values: ["1990s"] }),
    ]));
    expect(hard.filter((constraint) => constraint.axis === "genre")).toHaveLength(1);
    expect(hard.filter((constraint) => constraint.axis === "geography")).toHaveLength(1);
    expect(hard.filter((constraint) => constraint.axis === "language")).toHaveLength(1);
    expect(hard.filter((constraint) => constraint.axis === "era")).toHaveLength(1);
    expect(plan.constraints).toContainEqual(expect.objectContaining({
      axis: "relationship",
      operator: "prefer",
      values: ["is a house music recording from the American scene sung in French"],
      kind: "soft",
    }));
    expect(plan.geographyConstraints).toEqual(expect.arrayContaining([
      { value: "French", relationship: "language" },
      { value: "American", relationship: "unspecified" },
    ]));
  });

  test("does not harden model-inferred house-music cities absent from the prompt", () => {
    const plan = createSelectionPlanV2({
      prompt: "House music",
      brief: brief({
        subjectEntities: ["House music", "Chicago", "New York", "Detroit", "UK"],
        description: "A broad survey spanning Chicago, New York, Detroit, and UK house.",
        include: ["Foundational tracks from Chicago, New York, Detroit, and the UK."],
      }),
    });

    expect(plan.constraints.filter((constraint) => (
      constraint.kind === "hard"
      && ["geography", "language", "scene"].includes(constraint.axis)
    ))).toEqual([]);
    expect(plan.geographyConstraints).toEqual([]);
  });

  test("keeps visitor-requested Chicago house as hard geography", () => {
    const plan = createSelectionPlanV2({
      prompt: "Chicago house music",
      brief: brief({
        subjectEntities: ["House music", "Chicago", "New York", "Detroit", "UK"],
      }),
    });

    expect(plan.constraints).toContainEqual(expect.objectContaining({
      kind: "hard",
      axis: "geography",
      values: ["Chicago"],
      geographyRelationship: "unspecified",
    }));
    expect(plan.geographyConstraints).toContainEqual({ value: "Chicago", relationship: "unspecified" });
  });

  test("keeps a typed Chicago scene answer hard even when the prompt is broad", () => {
    const plan = createSelectionPlanV2({
      prompt: "House music",
      brief: brief({ subjectEntities: ["House music", "Chicago", "New York"] }),
      guidancePreferences: [{
        questionId: "q-house-scene",
        decisionKey: "house_scene_boundary",
        kind: "research_preference",
        value: "Require the Chicago label and venue scene.",
        orderingBehavior: null,
        geographyConstraint: { value: "Chicago", relationship: "label_or_venue_scene" },
        source: "option",
      }],
    });

    expect(plan.constraints).toContainEqual(expect.objectContaining({
      id: expect.stringMatching(/^guidance_scope_/u),
      kind: "hard",
      axis: "scene",
      values: ["Chicago"],
      geographyRelationship: "label_or_venue_scene",
    }));
    expect(plan.geographyConstraints).toContainEqual({
      value: "Chicago",
      relationship: "label_or_venue_scene",
    });
  });

  test.each([
    ["Jazz from the French scene", "label_or_venue_scene"],
    ["Jazz recorded in France", "recording_location"],
    ["Jazz by artists residing in France", "artist_residence"],
  ] as const)("retains the exact geography relation for %s", (prompt, relationship) => {
    const plan = createSelectionPlanV2({
      prompt,
      brief: brief({
        title: prompt,
        subjectEntities: [prompt],
        relationship: "matches the requested French jazz relationship",
        include: [prompt],
        exclude: [],
      }),
    });
    expect(plan.geographyConstraints).toContainEqual({ value: "French", relationship });
    expect(plan.constraints).toContainEqual(expect.objectContaining({
      kind: "hard",
      values: ["French"],
      geographyRelationship: relationship,
    }));
  });

  test("a guided relationship answer replaces only the matching ambiguous geography rule", () => {
    const plan = createSelectionPlanV2({
      prompt: "French jazz",
      brief: brief({
        title: "French jazz",
        subjectEntities: ["French jazz"],
        relationship: "matches the confirmed French relationship",
        include: [],
        exclude: [],
      }),
      guidancePreferences: [{
        questionId: "q1",
        decisionKey: "french_jazz_relationship_boundary",
        kind: "research_preference",
        value: "Require recordings documented as recorded in France.",
        orderingBehavior: null,
        geographyConstraint: { value: "French", relationship: "recording_location" },
        source: "option",
      }],
    });
    expect(plan.geographyConstraints).toContainEqual({ value: "French", relationship: "recording_location" });
    expect(plan.geographyConstraints).not.toContainEqual({ value: "French", relationship: "unspecified" });
  });

  test("drops a generated complement instead of parsing its unless-clause as a scene", () => {
    const generatedComplement = "Non-French jazz unless clearly tied to the French jazz scene.";
    const plan = createSelectionPlanV2({
      prompt: "French jazz",
      brief: brief({
        title: "French jazz",
        subjectEntities: ["French jazz"],
        relationship: "is a French jazz recording",
        include: [],
        exclude: [generatedComplement],
      }),
    });

    expect(plan.constraints).toEqual(expect.arrayContaining([
      expect.objectContaining({ axis: "genre", kind: "hard", values: ["jazz"] }),
      expect.objectContaining({ axis: "geography", kind: "hard", values: ["French"] }),
    ]));
    expect(plan.constraints.some((constraint) => (
      constraint.values.some((value) => value.includes("non-French jazz"))
    ))).toBe(false);
    expect(plan.constraints.some((constraint) => (
      constraint.axis === "scene"
      && constraint.values.some((value) => value.includes("unless clearly tied"))
    ))).toBe(false);
  });

  test("a broad national answer preserves an existing ambiguous country scope", () => {
    const plan = createSelectionPlanV2({
      prompt: "Brazilian disco songs",
      brief: brief({
        title: "Brazilian disco",
        subjectEntities: ["Brazilian disco"],
        relationship: "is a Brazilian disco recording",
        include: [],
        exclude: [],
      }),
      guidancePreferences: [{
        questionId: "q3",
        decisionKey: "brazilian_scene_scope",
        kind: "research_preference",
        value: "broad_national_scope",
        orderingBehavior: null,
        geographyConstraint: { value: "Brazil", relationship: "artist_origin" },
        source: "option",
      }],
    });

    expect(plan.geographyConstraints).toContainEqual({ value: "Brazilian", relationship: "unspecified" });
    expect(plan.geographyConstraints).not.toContainEqual({ value: "Brazil", relationship: "artist_origin" });
    expect(plan.constraints).toContainEqual(expect.objectContaining({
      kind: "soft",
      operator: "prefer",
      values: ["broad_national_scope"],
    }));
  });

  test("an explicit artist-origin answer remains a hard relationship boundary", () => {
    const plan = createSelectionPlanV2({
      prompt: "French jazz",
      brief: brief({ title: "French jazz", subjectEntities: ["French jazz"], include: [], exclude: [] }),
      guidancePreferences: [{
        questionId: "q-france",
        decisionKey: "french_jazz_relationship_boundary",
        kind: "research_preference",
        value: "french_artists_first",
        orderingBehavior: null,
        geographyConstraint: { value: "France", relationship: "artist_origin" },
        source: "option",
      }],
    });

    expect(plan.geographyConstraints).toContainEqual({ value: "France", relationship: "artist_origin" });
    expect(plan.geographyConstraints).not.toContainEqual({ value: "French", relationship: "unspecified" });
  });

  test("represents explicit year ranges independently from decades", () => {
    const rangePlan = createSelectionPlanV2({
      prompt: "Detroit techno from 1992–1998",
      brief: brief({
        title: "Detroit techno 1992–1998",
        subjectEntities: ["Detroit techno"],
        include: ["Released from 1992–1998"],
        exclude: [],
      }),
    });
    expect(rangePlan.constraints).toContainEqual(expect.objectContaining({
      axis: "era",
      operator: "between",
      values: ["1992", "1998"],
      kind: "hard",
    }));
  });

  test.each([
    ["Brazilian disco from the 1970s through today", "1970"],
    ["Jazz from the 1950s to present", "1950"],
    ["Detroit techno from 1987 until now", "1987"],
    ["House music from 1992 through the current year", "1992"],
    ["Electronic music from 2004 to the present day", "2004"],
  ])("keeps an open-ended era in %s as a continuous hard range", (prompt, startYear) => {
    const plan = createSelectionPlanV2({
      prompt,
      brief: brief({
        title: prompt,
        subjectEntities: ["Music"],
        include: [],
        exclude: [],
      }),
    });

    expect(plan.constraints.filter((constraint) => (
      constraint.kind === "hard" && constraint.axis === "era"
    ))).toEqual([
      expect.objectContaining({
        operator: "between",
        values: [startYear, String(new Date().getUTCFullYear())],
      }),
    ]);
  });

  test("keeps a two-decade request as one non-relaxable era range", () => {
    const plan = createSelectionPlanV2({
      prompt: "Brazilian disco, boogie, and disco-funk dance-floor songs from the 1970s and 1980s",
      brief: brief({
        title: "Brazilian disco and boogie",
        description: "A dance-floor survey spanning the 1970s and 1980s.",
        // The interpretation model may emit subject fragments that repeat
        // only one side of the user's alternative era range. They must enrich
        // the one prompt-derived range, never become additional conjunctive
        // hard rules requiring each track to be from both decades.
        subjectEntities: [
          "1970s Brazilian disco",
          "1980s Brazilian boogie",
          "1970s and 1980s Brazilian disco-funk",
        ],
        relationship: "belongs to the requested Brazilian dance-music scope",
        include: ["Disco, boogie, and disco-funk from Brazil in the 1970s and 1980s"],
        exclude: [],
        targetSize: { min: 25, max: 25 },
      }),
    });

    const hardEraConstraints = plan.constraints.filter((constraint) => (
      constraint.kind === "hard" && constraint.axis === "era"
    ));
    expect(hardEraConstraints).toEqual([
      expect.objectContaining({
        operator: "within",
        values: ["1970s", "1980s"],
      }),
    ]);
  });

  test("merges alternative hard scope fragments by genre, geography, language, and era", () => {
    const plan = createSelectionPlanV2({
      prompt: "Brazilian or French disco and funk from the 1970s and 1980s, with vocals in Portuguese or French",
      brief: brief({
        title: "Brazilian and French dance music",
        description: "A multilingual disco and funk survey across two scenes and decades.",
        subjectEntities: [
          "1970s Brazilian disco sung in Portuguese",
          "1980s French funk sung in French",
        ],
        relationship: "belongs to one of the requested dance-music scenes",
        include: [],
        exclude: [],
        targetSize: { min: 25, max: 25 },
      }),
    });

    const hardFor = (axis: "genre" | "geography" | "language" | "era") => plan.constraints.filter((constraint) => (
      constraint.kind === "hard" && constraint.axis === axis
    ));
    expect(hardFor("genre")).toEqual([
      expect.objectContaining({ operator: "require", values: ["disco", "funk"] }),
    ]);
    expect(hardFor("geography")).toEqual([
      expect.objectContaining({
        operator: "require",
        values: ["Brazilian", "French"],
        geographyRelationship: "unspecified",
      }),
    ]);
    expect(hardFor("language")).toEqual([
      expect.objectContaining({
        operator: "require",
        values: ["Portuguese", "French"],
        geographyRelationship: "language",
      }),
    ]);
    expect(hardFor("era")).toEqual([
      expect.objectContaining({ operator: "within", values: ["1970s", "1980s"] }),
    ]);
  });

  test("generated exclusions cannot contradict a user-requested two-decade range", () => {
    const plan = createSelectionPlanV2({
      prompt: "Brazilian disco, boogie, and disco-funk dance-floor songs from the 1970s and 1980s",
      brief: brief({
        title: "Brazilian disco and boogie",
        description: "A dance-floor survey spanning the 1970s and 1980s.",
        subjectEntities: ["Brazilian disco", "Brazilian boogie", "Brazilian disco-funk"],
        relationship: "belongs to the requested Brazilian dance-music scope",
        include: ["Disco, boogie, and disco-funk from Brazil in the 1970s and 1980s"],
        // These are model-authored mistakes, not visitor exclusions. Neither
        // may override the explicit positive era scope in the prompt.
        exclude: ["Avoid recordings from the 1970s", "Avoid recordings from the 1980s"],
        targetSize: { min: 25, max: 25 },
      }),
    });

    const requestedDecades = new Set(["1970s", "1980s"]);
    const contradictory = plan.constraints.filter((constraint) => (
      constraint.axis === "era"
      && (constraint.operator === "avoid" || constraint.operator === "exclude")
      && constraint.values.some((value) => requestedDecades.has(value))
    ));
    expect(contradictory).toEqual([]);
    expect(plan.constraints.filter((constraint) => (
      constraint.kind === "hard" && constraint.axis === "era"
    ))).toEqual([
      expect.objectContaining({
        operator: "within",
        values: ["1970s", "1980s"],
      }),
    ]);
  });

  test("factual credits route to the claim-first frontier and disable generic caps", () => {
    const plan = createSelectionPlanV2({
      prompt: "Every released song Paulinho da Costa performed on",
      brief: brief({
        title: "Paulinho da Costa credits",
        mode: "exhaustive",
        subjectEntities: ["Paulinho da Costa"],
        relationship: "performed percussion on the released recording",
        targetSize: null,
      }),
    });
    expect(plan.intents).toEqual(expect.arrayContaining(["exhaustive", "factual_relationship"]));
    expect(plan.diversityGoals.maximumTracksPerArtist).toBeNull();
    expect(pipelineV2Route(plan)).toBe("factual_frontier");
  });

  test("hybrid source-bounded scopes retain the exhaustive frontier contract", () => {
    const plan = createSelectionPlanV2({
      prompt: "Every documented Detroit techno track from 1985–1992",
      brief: brief({
        title: "Early Detroit techno",
        mode: "hybrid",
        subjectEntities: ["Detroit techno"],
        relationship: "belongs to the documented Detroit techno scene",
        include: ["Released from 1985–1992"],
        targetSize: { min: 100, max: 100 },
      }),
    });

    expect(plan.intents).toContain("exhaustive");
    expect(pipelineV2Route(plan)).toBe("factual_frontier");
  });

  test("production quality adjectives stay curated while producer credits route factual", () => {
    const qualityPlan = createSelectionPlanV2({
      prompt: "50 well-produced ambient tracks",
      brief: brief({
        title: "Well-produced ambient",
        subjectEntities: ["Ambient music"],
        relationship: "is a well-produced ambient recording",
        include: ["Detailed, polished production"],
      }),
    });
    expect(qualityPlan.intents).not.toContain("factual_relationship");
    expect(pipelineV2Route(qualityPlan)).toBe("curated_catalog");

    const activityPlan = createSelectionPlanV2({
      prompt: "50 songs to play at dinner during a listening session",
      brief: brief({
        title: "Dinner listening",
        subjectEntities: ["Dinner music"],
        relationship: "is music to play at dinner during a listening session",
        include: ["Relaxed pacing"],
      }),
    });
    expect(activityPlan.intents).not.toContain("factual_relationship");
    expect(pipelineV2Route(activityPlan)).toBe("curated_catalog");

    const producerCreditPlan = createSelectionPlanV2({
      prompt: "50 recordings produced by Quincy Jones",
      brief: brief({
        title: "Quincy Jones productions",
        subjectEntities: ["Quincy Jones"],
        relationship: "was produced by Quincy Jones",
        include: ["Documented producer credits"],
      }),
    });
    expect(producerCreditPlan.intents).toContain("factual_relationship");
    expect(pipelineV2Route(producerCreditPlan)).toBe("factual_frontier");
  });

  test("generated Essentials and representative prose cannot upgrade a plain genre request", () => {
    const plan = createSelectionPlanV2({
      prompt: "Brazilian disco songs",
      brief: brief({
        title: "Brazilian Disco Essentials",
        description: "Representative and important disco recordings by Brazilian artists.",
        subjectEntities: ["Brazilian disco"],
        relationship: "represents the most important Brazilian disco recordings",
        include: ["Iconic Brazilian disco classics"],
        exclude: [],
      }),
    });

    expect(plan.intents).toContain("genre_scene");
    expect(plan.intents).not.toEqual(expect.arrayContaining([
      "editorial_ranking",
      "artist_catalogue",
      "mood_activity",
    ]));
    expect(plan.constraints).toContainEqual(expect.objectContaining({
      axis: "relationship",
      kind: "soft",
      operator: "prefer",
    }));
  });

  test("fixed-count curated requests ignore generated exhaustive wording", () => {
    const plan = createSelectionPlanV2({
      prompt: "Brazilian disco songs",
      brief: brief({
        title: "Complete Brazilian Disco Catalogue",
        description: "All tracks in a complete Brazilian disco survey.",
        mode: "curated",
        subjectEntities: ["Brazilian disco"],
        relationship: "covers all Brazilian disco recordings",
        include: ["Every essential track"],
        exclude: [],
      }),
    });

    expect(plan.intents).not.toContain("exhaustive");
    expect(pipelineV2Route(plan)).toBe("curated_catalog");
  });

  test("natural possessive album requests retain a typed fixed-release scope", () => {
    const plan = createSelectionPlanV2({
      prompt: "songs from Michael Jackson's Thriller",
      brief: brief({
        title: "Michael Jackson — Thriller",
        description: "Songs from Michael Jackson's Thriller album.",
        subjectEntities: ["Michael Jackson", "Thriller"],
        relationship: "is included in the track list for the album Thriller by Michael Jackson",
        include: ["Tracks on the release Thriller."],
        targetSize: { min: 9, max: 9 },
      }),
    });

    expect(plan.scopeKind).toBe("fixed_release_container");
    expect(plan.diversityGoals.maximumTracksPerAlbum).toBeNull();
    expect(plan.orderingPolicy.avoidAdjacentSameAlbum).toBe(false);
  });

  test("directional geography prompts do not become fixed release containers", () => {
    const plan = createSelectionPlanV2({
      prompt: "songs from Brazil",
      brief: brief({
        title: "Songs from Brazil",
        description: "A broad survey of music made by Brazilian artists.",
        subjectEntities: ["Brazil"],
        relationship: "is music associated with Brazil",
        include: ["Artists and scenes from Brazil."],
      }),
    });

    expect(plan.scopeKind).toBe("broad_curated");
    expect(plan.diversityGoals.maximumTracksPerAlbum).not.toBeNull();
  });

  test("a soundtrack for an activity remains a broad curated request", () => {
    const plan = createSelectionPlanV2({
      prompt: "a soundtrack for my road trip",
      brief: brief({
        title: "Road Trip",
        description: "An energetic playlist for a long drive.",
        subjectEntities: ["road trip"],
        relationship: "fits an energetic road trip",
        include: ["Forward-moving songs for driving."],
      }),
    });

    expect(plan.scopeKind).toBe("broad_curated");
    expect(plan.diversityGoals.maximumTracksPerAlbum).not.toBeNull();
  });

  test("a broad survey across albums does not become one fixed container", () => {
    const plan = createSelectionPlanV2({
      prompt: "tracks from influential French jazz albums",
      brief: brief({
        title: "French Jazz Albums",
        description: "A broad survey across influential French jazz albums.",
        subjectEntities: ["French jazz"],
        relationship: "represents influential French jazz",
        include: ["Tracks drawn from multiple French jazz albums."],
      }),
    });

    expect(plan.scopeKind).toBe("broad_curated");
    expect(plan.diversityGoals.maximumTracksPerAlbum).not.toBeNull();
  });

  test("guided answers become typed, soft constraints without weakening hard rules", () => {
    const plan = createSelectionPlanV2({
      prompt: "French jazz",
      brief: brief({ title: "French jazz", subjectEntities: ["French jazz"], include: ["Artists in the French jazz scene."] }),
      guidancePreferences: [{
        questionId: "scene",
        decisionKey: "scene_definition",
        kind: "subscene_focus",
        value: "Prioritize the Paris postwar scene.",
        orderingBehavior: null,
        source: "option",
      }],
    });
    expect(plan.constraints.some((constraint) => constraint.kind === "hard" && constraint.axis === "evidence")).toBe(true);
    expect(plan.constraints.some((constraint) => constraint.kind === "soft" && constraint.axis === "scene")).toBe(true);
  });

  test("rollout enables only signed owner curated canaries after the explicit worker-safety gate", () => {
    const plan = createSelectionPlanV2({ prompt: "House music", brief: brief() });
    expect(assignPipelineV2({
      plan,
      signedOwnerCanary: false,
      stickyKey: "owner",
      env: {},
    })).toMatchObject({
      assigned: false,
      reason: "legacy_control",
    });
    expect(assignPipelineV2({
      plan,
      signedOwnerCanary: false,
      stickyKey: "owner",
      env: { PIPELINE_V2_OWNER_CANARY: "true" },
    })).toMatchObject({
      assigned: false,
      reason: "legacy_control",
    });
    expect(assignPipelineV2({
      plan,
      signedOwnerCanary: true,
      stickyKey: "owner",
      env: { PIPELINE_V2_OWNER_CANARY: "true" },
    })).toMatchObject({
      assigned: true,
      reason: "owner_canary",
    });
    const first = assignPipelineV2({
      plan,
      signedOwnerCanary: false,
      stickyKey: "visitor-a",
      env: { PIPELINE_V2_CURATED_PERCENT: "25" },
    });
    const repeated = assignPipelineV2({
      plan,
      signedOwnerCanary: false,
      stickyKey: "visitor-a",
      env: { PIPELINE_V2_CURATED_PERCENT: "25" },
    });
    expect(repeated).toEqual(first);
    expect(first.percentage).toBe(25);
  });

  test("rollout identity stays stable across prompts within one route and policy", () => {
    const housePlan = createSelectionPlanV2({ prompt: "House music", brief: brief() });
    const drillPlan = createSelectionPlanV2({
      prompt: "American drill",
      brief: brief({
        title: "American drill",
        subjectEntities: ["American drill"],
        relationship: "is a recording in the American drill genre",
      }),
    });
    expect(pipelineRolloutStickyKey("visitor-a", housePlan))
      .toBe(pipelineRolloutStickyKey("visitor-a", drillPlan));
    expect(pipelineRolloutStickyKey("visitor-b", housePlan))
      .not.toBe(pipelineRolloutStickyKey("visitor-a", housePlan));
  });

  test("similarity public traffic graduates independently from core curated traffic", () => {
    const housePlan = createSelectionPlanV2({ prompt: "House music", brief: brief() });
    const similarityPlan = createSelectionPlanV2({
      prompt: "Songs like Radiohead but do not include Radiohead",
      brief: brief({
        title: "Radiohead-adjacent",
        subjectEntities: ["Radiohead"],
        relationship: "is stylistically similar to Radiohead",
        include: ["Similar production, harmony, and vocal style."],
        exclude: ["Reference artist is a style seed; exclude recordings by: Radiohead"],
      }),
    });

    expect(pipelineV2RolloutGroup(housePlan)).toBe("curated_core");
    expect(pipelineV2RolloutGroup(similarityPlan)).toBe("curated_similarity");
    expect(pipelineRolloutStickyKey("visitor-a", housePlan))
      .not.toBe(pipelineRolloutStickyKey("visitor-a", similarityPlan));

    expect(assignPipelineV2({
      plan: similarityPlan,
      signedOwnerCanary: false,
      stickyKey: pipelineRolloutStickyKey("visitor-a", similarityPlan),
      env: { PIPELINE_V2_CURATED_PERCENT: "100", PIPELINE_V2_SIMILARITY_PERCENT: "0" },
    })).toMatchObject({ assigned: false, percentage: 0, reason: "legacy_control" });
    expect(assignPipelineV2({
      plan: similarityPlan,
      signedOwnerCanary: false,
      stickyKey: pipelineRolloutStickyKey("visitor-a", similarityPlan),
      env: { PIPELINE_V2_CURATED_PERCENT: "0", PIPELINE_V2_SIMILARITY_PERCENT: "100" },
    })).toMatchObject({ assigned: true, percentage: 100, reason: "sticky_rollout" });
  });

  test("factual V2 uses independent signed-canary and sticky rollout gates", () => {
    const plan = createSelectionPlanV2({
      prompt: "Every Paulinho da Costa credit",
      brief: brief({
        mode: "exhaustive",
        subjectEntities: ["Paulinho da Costa"],
        relationship: "performed percussion on the released recording",
        targetSize: null,
      }),
    });
    expect(assignPipelineV2({
      plan,
      signedOwnerCanary: false,
      stickyKey: "owner",
      env: {},
    })).toMatchObject({
      assigned: false,
      reason: "legacy_control",
    });
    expect(assignPipelineV2({
      plan,
      signedOwnerCanary: false,
      stickyKey: "owner",
      env: { PIPELINE_V2_FACTUAL_CANARY: "1" },
    })).toMatchObject({ assigned: false, percentage: 0, reason: "legacy_control" });
    expect(assignPipelineV2({
      plan,
      signedOwnerCanary: true,
      stickyKey: "owner",
      env: { PIPELINE_V2_FACTUAL_OWNER_CANARY: "true" },
    })).toMatchObject({ assigned: true, percentage: 100, reason: "owner_canary" });
    expect(assignPipelineV2({
      plan,
      signedOwnerCanary: false,
      stickyKey: "public-factual",
      env: { PIPELINE_V2_FACTUAL_PERCENT: "100", PIPELINE_V2_CURATED_PERCENT: "0" },
    })).toMatchObject({ assigned: true, percentage: 100, reason: "sticky_rollout" });
  });
});
