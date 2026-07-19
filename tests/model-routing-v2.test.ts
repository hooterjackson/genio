import { describe, expect, test } from "vitest";
import type { PlaylistBrief } from "../shared/types.ts";
import {
  createFastRouteCheckpoint,
  curatedLunaModelSnapshot,
  curatedResearchModelRoute,
  curatedTerraModelSnapshot,
  parseFastRouteCheckpoint,
  researchExecutionPolicy,
  researchPolicyFingerprint,
} from "../server/research-policy.ts";

const curatedBrief: PlaylistBrief = {
  title: "Fixture",
  description: "Fixture",
  mode: "curated",
  subjectEntities: ["Fixture"],
  relationship: "is representative of",
  include: [],
  exclude: [],
  versionPolicy: "one canonical recording",
  evidencePolicy: "cited editorial sources",
  orderingPolicy: "editorial",
  targetSize: { min: 50, max: 50 },
  ambiguities: [],
};

describe("Pipeline V2 curated model routing", () => {
  test("uses the pinned Luna snapshot as the high-volume baseline", () => {
    const environment = {
      OPENAI_CURATED_LUNA_SNAPSHOT: "gpt-luna-2026-07-01",
      OPENAI_FAST_MODEL: "legacy-fast-alias",
    };
    expect(curatedLunaModelSnapshot(environment)).toBe("gpt-luna-2026-07-01");
    expect(curatedResearchModelRoute({}, environment)).toEqual({
      version: "curated_model_route_v1",
      tier: "luna",
      modelSnapshot: "gpt-luna-2026-07-01",
      reason: "luna_baseline",
      scoutConfidence: "medium",
      structuredRepairFailures: 0,
    });
  });

  test("routes to the pinned Terra snapshot only for explicit low scout confidence", () => {
    const environment = {
      OPENAI_CURATED_LUNA_SNAPSHOT: "luna-pinned",
      OPENAI_CURATED_TERRA_SNAPSHOT: "terra-pinned",
    };
    expect(curatedResearchModelRoute({ scoutConfidence: 0.59 }, environment)).toEqual({
      version: "curated_model_route_v1",
      tier: "terra",
      modelSnapshot: "terra-pinned",
      reason: "scout_low_confidence",
      scoutConfidence: "low",
      structuredRepairFailures: 0,
    });
    expect(curatedResearchModelRoute({ scoutConfidence: 0.6 }, environment).tier).toBe("luna");
  });

  test("routes to Terra after one failed structured repair but not after a successful repair", () => {
    const failed = curatedResearchModelRoute({
      scoutTelemetry: {
        generationMode: "scout_unavailable",
        proposedQuestionCount: 1,
        acceptedQuestionCount: 0,
        validationIssues: ["response:primary_invalid_json", "response:repair_invalid_json"],
      },
    });
    expect(failed).toMatchObject({
      tier: "terra",
      reason: "structured_repair_failed",
      structuredRepairFailures: 1,
    });

    const repaired = curatedResearchModelRoute({
      scoutTelemetry: {
        generationMode: "grounded_scout",
        proposedQuestionCount: 1,
        acceptedQuestionCount: 1,
        validationIssues: [
          "response:primary_incomplete_max_output_tokens",
          "response:repaired_structured_output",
        ],
      },
    });
    expect(repaired).toMatchObject({
      tier: "luna",
      reason: "luna_baseline",
      scoutConfidence: "high",
      structuredRepairFailures: 0,
    });
  });

  test("does not spend more by escalating a provider outage", () => {
    expect(curatedResearchModelRoute({
      scoutTelemetry: {
        generationMode: "scout_unavailable",
        proposedQuestionCount: 0,
        acceptedQuestionCount: 0,
        validationIssues: ["response:provider_http_503"],
      },
    })).toMatchObject({
      tier: "luna",
      reason: "luna_baseline",
      scoutConfidence: "medium",
    });
  });

  test("embeds and checkpoints the immutable route decision", () => {
    const policy = researchExecutionPolicy(curatedBrief, {
      OPENAI_CURATED_LUNA_SNAPSHOT: "luna-pinned",
      OPENAI_CURATED_TERRA_SNAPSHOT: "terra-pinned",
    }, null, {
      structuredRepairFailures: 1,
    });
    expect(policy).toMatchObject({
      kind: "fast_curated",
      model: "terra-pinned",
      modelRoute: {
        modelSnapshot: "terra-pinned",
        reason: "structured_repair_failed",
      },
    });
    if (policy.kind !== "fast_curated") throw new Error("Fixture must use curated policy");
    const checkpoint = createFastRouteCheckpoint(policy, new Date("2026-07-19T12:00:00.000Z"));
    expect(parseFastRouteCheckpoint(checkpoint)).toEqual(checkpoint);
    expect(parseFastRouteCheckpoint({
      ...checkpoint,
      modelRoute: { ...checkpoint.modelRoute, modelSnapshot: "different" },
    })).toBeNull();
    expect(researchPolicyFingerprint(curatedBrief, {}, null, {
      structuredRepairFailures: 1,
    })).not.toBe(researchPolicyFingerprint(curatedBrief, {}));
  });

  test("preserves an in-flight V1 checkpoint's pinned model and deadlines", () => {
    const legacy = {
      status: "queued",
      profile: "fast_curated_v3",
      model: "historical-fast-snapshot",
      confirmedAt: "2026-07-19T12:00:00.000Z",
      researchDeadlineAt: "2026-07-19T12:01:20.000Z",
      deadlineAt: "2026-07-19T12:02:00.000Z",
      matchingReserveMs: 40_000,
    };
    expect(parseFastRouteCheckpoint(legacy)).toMatchObject({
      ...legacy,
      modelRoute: {
        modelSnapshot: "historical-fast-snapshot",
        reason: "luna_baseline",
      },
    });
  });

  test("keeps legacy model variables as backward-compatible snapshot fallbacks", () => {
    expect(curatedLunaModelSnapshot({ OPENAI_FAST_MODEL: "legacy-luna" })).toBe("legacy-luna");
    expect(curatedTerraModelSnapshot({ OPENAI_DEEP_MODEL: "legacy-terra" })).toBe("legacy-terra");
    expect(curatedLunaModelSnapshot({})).toBe("gpt-5.6-luna");
    expect(curatedTerraModelSnapshot({})).toBe("gpt-5.6-terra");
  });
});
