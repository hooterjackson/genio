import { describe, expect, test } from "vitest";
import fixtureJson from "./fixtures/pipeline-v2-contract-scenarios.json";
import type { PlaylistBrief } from "../shared/types.ts";
import {
  canonicalBriefForRequest,
} from "../server/brief-policy.ts";
import {
  excludedReferenceArtists,
} from "../server/similarity-policy.ts";
import {
  briefShouldDiversifyArtists,
} from "../lib/playlist-selection.ts";
import {
  resolvePublicationCompleteness,
} from "../server/publication-completeness.ts";
import { publicationTerminalStatus } from "../server/publisher.ts";
import {
  contractTerminalOutcome,
  exactFillRawPlan,
  keywordCandidateSelectable,
  selectableYieldLowerBound,
  selectWithConstraintLadder,
  type ContractCandidate,
  type ContractConstraint,
  type ContractFailureOrigin,
} from "./helpers/pipeline-v2-contract.ts";

type Route = "catalog_curated" | "evidence_frontier";

interface ExactFillCase {
  id: string;
  target: number;
  selectable: number;
  observedAttempts: number;
  observedSelectable: number;
  minimumPlannedRaw: number;
  note: string;
}

interface RouteCase {
  id: string;
  prompt: string;
  requestedTrackCount: number | null;
  seedTitle: string;
  seedEntities: string[];
  seedRelationship: string;
  expectedRoute: Route;
  expectedIntent: string;
  expectedTerms: string[];
  forbiddenTerms: string[];
}

interface KeywordCase {
  id: string;
  requestIntent: string;
  artist: string;
  title: string;
  genreEvidence: boolean;
  expectedSelectable: boolean;
}

interface ConstraintCase {
  id: string;
  target: number;
  constraints: ContractConstraint[];
  candidates: ContractCandidate[];
  expectedState: "exact" | "partial";
  expectedRelaxed: string[];
  expectedSelected: string[];
}

interface TerminalCase {
  id: string;
  failureOrigin: ContractFailureOrigin;
  safeTrackCount: number;
  target: number;
  expectedStatus: "partial" | "failed";
  expectedPublicClass: string;
}

const fixture = fixtureJson as unknown as {
  schemaVersion: number;
  purpose: string;
  exactFillCases: ExactFillCase[];
  routeCases: RouteCase[];
  titleKeywordFalsePositives: KeywordCase[];
  constraintCases: ConstraintCase[];
  terminalCases: TerminalCase[];
};

function normalized(value: string): string {
  return value.normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/\s+/gu, " ")
    .trim();
}

function seedBrief(scenario: RouteCase): PlaylistBrief {
  const exhaustive = scenario.expectedRoute === "evidence_frontier";
  return {
    title: scenario.seedTitle,
    description: `A source-backed selection for ${scenario.seedTitle}.`,
    mode: exhaustive ? "exhaustive" : "curated",
    subjectEntities: scenario.seedEntities,
    relationship: scenario.seedRelationship,
    include: scenario.expectedIntent === "similarity"
      ? [`${scenario.seedEntities[0]} recordings`]
      : [`Recordings that ${scenario.seedRelationship}.`],
    exclude: [],
    versionPolicy: "Prefer one canonical released recording per song.",
    evidencePolicy: exhaustive
      ? "Require track-level evidence."
      : "Use reputable cited editorial and catalog sources.",
    orderingPolicy: "Interleave artists and albums in an editorial sequence.",
    targetSize: exhaustive ? null : { min: 50, max: 100 },
    ambiguities: [],
  };
}

function routeForBrief(brief: PlaylistBrief): Route {
  return brief.mode === "exhaustive" || brief.mode === "hybrid"
    ? "evidence_frontier"
    : "catalog_curated";
}

describe("Pipeline V2 provider-free release contract", () => {
  test("fixture is versioned, unique, and covers every required contract axis", () => {
    expect(fixture.schemaVersion).toBe(1);
    expect(fixture.purpose).toContain("Provider-free");
    expect(fixture.exactFillCases.length).toBeGreaterThanOrEqual(4);
    expect(fixture.routeCases.map((scenario) => scenario.expectedIntent)).toEqual(expect.arrayContaining([
      "genre",
      "geographic_genre",
      "genre_history",
      "similarity",
      "factual_exhaustive_credit",
      "credited_artist_editorial",
    ]));
    expect(new Set([
      ...fixture.exactFillCases.map(({ id }) => id),
      ...fixture.routeCases.map(({ id }) => id),
      ...fixture.titleKeywordFalsePositives.map(({ id }) => id),
      ...fixture.constraintCases.map(({ id }) => id),
      ...fixture.terminalCases.map(({ id }) => id),
    ]).size).toBe(
      fixture.exactFillCases.length
      + fixture.routeCases.length
      + fixture.titleKeywordFalsePositives.length
      + fixture.constraintCases.length
      + fixture.terminalCases.length,
    );
  });

  test.each(fixture.exactFillCases)("$id sizes discovery from conservative selectable yield", (scenario) => {
    const plan = exactFillRawPlan(scenario);
    expect(plan, scenario.note).toBeGreaterThanOrEqual(scenario.minimumPlannedRaw);
    if (scenario.selectable >= scenario.target) expect(plan).toBe(0);
  });

  test("fixed target-plus-20-percent math is demonstrably insufficient at a common Apple yield", () => {
    const target = 50;
    const fixedRawGoal = Math.ceil(target * 1.2);
    const observedAppleYield = 0.78;
    expect(Math.floor(fixedRawGoal * observedAppleYield)).toBe(46);
    expect(Math.floor(fixedRawGoal * observedAppleYield)).toBeLessThan(target);

    const lowerBound = selectableYieldLowerBound(39, 50);
    const refill = exactFillRawPlan({
      target,
      selectable: 39,
      observedAttempts: 50,
      observedSelectable: 39,
    });
    expect(lowerBound).toBeLessThan(observedAppleYield);
    expect(39 + Math.floor(refill * lowerBound)).toBeGreaterThanOrEqual(target + 5);
  });

  test.each(fixture.routeCases)("$id preserves route, intent scope, and exact requested count", (scenario) => {
    const brief = canonicalBriefForRequest({
      prompt: scenario.prompt,
      requestedTrackCount: scenario.requestedTrackCount,
    }, seedBrief(scenario));
    const positiveScope = normalized([
      ...brief.subjectEntities,
      brief.relationship,
      ...brief.include,
    ].join(" "));

    expect(routeForBrief(brief)).toBe(scenario.expectedRoute);
    if (scenario.requestedTrackCount === null) {
      expect(brief.mode).toBe("exhaustive");
      expect(brief.targetSize).toBeNull();
    } else {
      expect(brief.targetSize).toEqual({
        min: scenario.requestedTrackCount,
        max: scenario.requestedTrackCount,
      });
    }
    scenario.expectedTerms.forEach((term) => expect(positiveScope).toContain(normalized(term)));
    scenario.forbiddenTerms.forEach((term) => expect(positiveScope).not.toContain(normalized(term)));

    if (["genre", "geographic_genre", "genre_history"].includes(scenario.expectedIntent)) {
      expect(briefShouldDiversifyArtists(brief)).toBe(true);
    }
    if (scenario.expectedIntent === "similarity") {
      expect(excludedReferenceArtists(brief)).toEqual(["Radiohead"]);
    }
  });

  test.each(fixture.titleKeywordFalsePositives)(
    "$id does not promote title keyword overlap to genre evidence",
    (scenario) => {
      expect(keywordCandidateSelectable(scenario)).toBe(scenario.expectedSelectable);
    },
  );

  test("house intent policy persists an explicit title-keyword exclusion", () => {
    const scenario = fixture.routeCases.find(({ id }) => id === "RT-HOUSE-GENRE")!;
    const brief = canonicalBriefForRequest({
      prompt: scenario.prompt,
      requestedTrackCount: scenario.requestedTrackCount,
    }, seedBrief(scenario));
    expect(brief.exclude.join(" ")).toMatch(/not select.*merely because.*title.*houses.*homes/iu);
  });

  test.each(fixture.constraintCases)("$id relaxes only declared soft constraints", (scenario) => {
    const result = selectWithConstraintLadder(scenario);
    expect(result.state).toBe(scenario.expectedState);
    expect(result.relaxed).toEqual(scenario.expectedRelaxed);
    expect(result.selected).toEqual(scenario.expectedSelected);

    const hardIds = new Set(scenario.constraints
      .filter(({ kind }) => kind === "hard")
      .map(({ id }) => id));
    expect(result.relaxed.every((id) => !hardIds.has(id))).toBe(true);
    for (const selectedId of result.selected) {
      const selected = scenario.candidates.find(({ id }) => id === selectedId)!;
      expect(selected.violations.some((violation) => hardIds.has(violation))).toBe(false);
    }
  });

  test.each(fixture.terminalCases)("$id distinguishes safe partials from local contract failures", (scenario) => {
    const outcome = contractTerminalOutcome(scenario);
    expect(outcome).toEqual({
      status: scenario.expectedStatus,
      publicClass: scenario.expectedPublicClass,
    });
  });

  test("current publication accounting labels a bounded curated shortfall partial", () => {
    const completeness = resolvePublicationCompleteness({
      mode: "curated",
      targetMinimum: 50,
      manifestTrackCount: 39,
      omittedCandidateCount: 11,
      unresolvedCoverageCount: 0,
    });
    expect(completeness).toEqual({
      omittedCandidateCount: 11,
      unresolvedCoverageCount: 0,
    });
    expect(publicationTerminalStatus(completeness)).toBe("partial");
  });
});
