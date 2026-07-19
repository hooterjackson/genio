import { describe, expect, test } from "vitest";
import fixtureJson from "./fixtures/frozen-holdout.json";
import { evaluateHoldoutRecovery } from "../lib/benchmarks.ts";
import { requiresFactualFrontier } from "../server/factual-frontier-policy.ts";
import {
  gapPassQualifiesForNoNewEvidence,
  researchCompletionReadiness,
} from "../server/research.ts";
import { researchExecutionPolicy } from "../server/research-policy.ts";
import type { PlaylistBrief } from "../shared/types.ts";

interface HoldoutTrack {
  artist: string;
  title: string;
}

const fixture = fixtureJson as unknown as {
  paulinho_da_costa: HoldoutTrack[];
  michael_jackson: HoldoutTrack[];
};

function factualBrief(overrides: Partial<PlaylistBrief> = {}): PlaylistBrief {
  return {
    title: "Paulinho da Costa credits",
    description: "Released recordings with documented performance credits.",
    mode: "curated",
    subjectEntities: ["Paulinho da Costa"],
    relationship: "performed percussion on the released recording",
    include: ["released recordings"],
    exclude: [],
    versionPolicy: "documented recording versions",
    evidencePolicy: "require explicit track-level performance credit evidence",
    orderingPolicy: "chronological",
    targetSize: { min: 100, max: 100 },
    ambiguities: [],
    ...overrides,
  };
}

const completedFrontier = [
  { sourceClass: "web", strategy: "hosted web search during source_discovery", cursor: null, status: "complete" as const, discoveredCount: 9, recoveredCount: 9, note: "stored sources" },
  { sourceClass: "web", strategy: "hosted web search during track_verification", cursor: null, status: "complete" as const, discoveredCount: 56, recoveredCount: 56, note: "track claims" },
  // A zero-new-evidence pass may still recover and inspect a source; "zero
  // new" refers to eligible recordings, not an empty provider response.
  { sourceClass: "web", strategy: "hosted web search during gap_analysis", cursor: null, status: "complete" as const, discoveredCount: 1, recoveredCount: 1, note: "zero-new gap pass" },
  { sourceClass: "musicbrainz", strategy: "discover release frozen-scope", cursor: null, status: "complete" as const, discoveredCount: 7, recoveredCount: 7, note: "release containers" },
  { sourceClass: "musicbrainz", strategy: "enumerate release frozen-scope", cursor: null, status: "complete" as const, discoveredCount: 80, recoveredCount: 80, note: "release tracks" },
];

const completedContainer = {
  id: "release-container",
  containerType: "release",
  providerId: "musicbrainz:release:frozen-scope",
  title: "Frozen released-discography scope",
  status: "complete",
  cursor: null,
  advertisedTotal: 80,
  recoveredTotal: 80,
};

describe("legacy factual-frontier compatibility gate", () => {
  test("routes factual relationships to claim-first research even when the brief is curated", () => {
    const brief = factualBrief();
    expect(requiresFactualFrontier(brief)).toBe(true);
    expect(researchExecutionPolicy(brief, {})).toEqual({
      kind: "deep",
      version: "deep_v1",
      model: "gpt-5.6-terra",
    });
  });

  test("recognizes factual aliases without treating incidental production adjectives as claims", () => {
    for (const relationship of [
      "collaborated on the released recording",
      "documents collaborations with Quincy Jones on released tracks",
      "appears on the released recording",
      "worked on the released recording",
      "recorded the song with Quincy Jones",
      "was credited as arranger",
      "contributed percussion to the track",
    ]) {
      expect(requiresFactualFrontier(factualBrief({ relationship })), relationship).toBe(true);
    }
    expect(requiresFactualFrontier({
      ...factualBrief({
        relationship: "is representative of the scene",
        evidencePolicy: "cited editorial sources",
        include: ["well-produced recordings"],
      }),
    })).toBe(false);
    expect(requiresFactualFrontier(factualBrief({
      relationship: "is a well-produced ambient recording",
      evidencePolicy: "cited editorial sources",
    }))).toBe(false);
    expect(requiresFactualFrontier(factualBrief({
      relationship: "was produced by Quincy Jones",
      evidencePolicy: "require an explicit producer credit",
    }))).toBe(true);
    expect(requiresFactualFrontier(factualBrief({
      relationship: "is a documented contribution by a woman who shaped Detroit techno",
      evidencePolicy: "cited editorial and scene-history sources",
    }))).toBe(false);
    expect(requiresFactualFrontier(factualBrief({
      relationship: "is music to play at dinner during a listening session",
      evidencePolicy: "cited mood and activity sources",
    }))).toBe(false);
  });

  test("hybrid briefs and typed routes agree on claim-first frontier work", () => {
    const hybrid = factualBrief({
      mode: "hybrid",
      relationship: "belongs to the documented Detroit techno scene",
      evidencePolicy: "require source-bounded scene evidence",
    });
    expect(requiresFactualFrontier(hybrid)).toBe(true);
  });

  test("requires reconciled release containers and the complete claim-first frontier", () => {
    const coverage = {
      candidateCount: 80,
      eligibleCandidateCount: 80,
      sourceCount: 9,
      containers: [completedContainer],
    };
    expect(researchCompletionReadiness(factualBrief(), coverage, completedFrontier).ready).toBe(true);
    expect(researchCompletionReadiness(factualBrief(), {
      ...coverage,
      containers: [{ ...completedContainer, recoveredTotal: 79 }],
    }, completedFrontier)).toMatchObject({
      ready: false,
      reasons: expect.arrayContaining(["1 exhaustive research containers are not terminal"]),
    });
    expect(researchCompletionReadiness(factualBrief(), coverage, completedFrontier.filter(
      ({ strategy }) => strategy !== "hosted web search during track_verification",
    )).ready).toBe(false);
  });

  test("counts only server-observed, zero-new gap work toward convergence", () => {
    expect(gapPassQualifiesForNoNewEvidence({
      phase: "gap_analysis",
      summary: "model claimed completion without an observed search",
      newCandidateCount: 0,
      frontierItems: [],
    })).toBe(false);
    expect(gapPassQualifiesForNoNewEvidence({
      phase: "gap_analysis",
      summary: "observed gap search",
      newCandidateCount: 0,
      frontierItems: [completedFrontier[2]!],
    })).toBe(true);
    expect(gapPassQualifiesForNoNewEvidence({
      phase: "gap_analysis",
      summary: "one new verified track survived",
      newCandidateCount: 1,
      frontierItems: [completedFrontier[2]!],
    })).toBe(false);
  });

  test("keeps both frozen factual holdouts at the 100% release gate", () => {
    expect(evaluateHoldoutRecovery(
      fixture.paulinho_da_costa,
      fixture.paulinho_da_costa,
    )).toMatchObject({ passed: true, recall: 1 });
    expect(evaluateHoldoutRecovery(
      fixture.michael_jackson,
      fixture.michael_jackson,
    )).toMatchObject({ passed: true, recall: 1 });
    expect(evaluateHoldoutRecovery(
      fixture.michael_jackson,
      fixture.michael_jackson.slice(0, -1),
    )).toMatchObject({ passed: false });
  });
});
