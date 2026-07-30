import { describe, expect, test } from "vitest";
import {
  assertPublicRolloutExecutionGroupV1,
  createPublicRolloutAssignmentV1,
  parsePublicRolloutAssignmentV1,
  publicRolloutCanonicalContractRequestedV1,
  publicRolloutAssignmentStickyKeyV1,
  publicRolloutRuntimeDatabaseAuthorityV1,
} from "../server/public-rollout-assignment.ts";
import type { PublicRolloutConfiguration } from "../shared/public-rollout-evidence.ts";
import { signedArtifactSha256 } from "../shared/signed-artifact.ts";

function environment(
  percent = "1",
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    RELEASE_ENVIRONMENT: "production",
    RELEASE_DEPLOYMENT_PHASE: "activate",
    RELEASE_PUBLIC_ROLLOUT_EVIDENCE_HASH: "a".repeat(64),
    RELEASE_PUBLIC_ROLLOUT_ROLLBACK_WARRANT_HASH: "f".repeat(64),
    RELEASE_PUBLIC_ROLLOUT_INTENT_CANARY_HASH: "e".repeat(64),
    RELEASE_PUBLIC_ROLLOUT_STAGE: `genre_scene:0->${percent}`,
    PIPELINE_V3_ASSIGNMENT_ENABLED: "true",
    PIPELINE_V3_PRODUCTION_EVIDENCE_APPROVED: "true",
    PIPELINE_V3_CURATED_HOSTED_EVIDENCE_APPROVED: "true",
    PIPELINE_V3_GENRE_SCENE_EVIDENCE_APPROVED: "true",
    PIPELINE_V3_GENRE_SCENE_PERCENT: percent,
    PIPELINE_V3_MOOD_ACTIVITY_PERCENT: "0",
    PIPELINE_V3_SIMILARITY_PERCENT: "0",
    PIPELINE_V3_ARTIST_CATALOGUE_PERCENT: "0",
    PIPELINE_V3_FIXED_CONTAINER_PERCENT: "0",
    PIPELINE_V3_FACTUAL_PERCENT: "0",
    PIPELINE_V3_EXHAUSTIVE_PERCENT: "0",
    GUIDANCE_CONTRACT_V3_ENABLED: "false",
    APPLE_STOREFRONT: "us",
    ...overrides,
  };
}

function databaseAuthority(
  authorityEnvironment = environment(),
) {
  const configuration = {
    PIPELINE_V2_OWNER_CANARY: "false",
    PIPELINE_V2_CURATED_PERCENT: "100",
    PIPELINE_V2_SIMILARITY_PERCENT: "0",
    PIPELINE_V2_FACTUAL_OWNER_CANARY: "false",
    PIPELINE_V2_FACTUAL_PERCENT: "0",
    PIPELINE_V3_ASSIGNMENT_ENABLED: "true",
    PIPELINE_V3_OWNER_CANARY: "true",
    PIPELINE_V3_CURATED_HOSTED_EVIDENCE_APPROVED:
      authorityEnvironment.PIPELINE_V3_CURATED_HOSTED_EVIDENCE_APPROVED ?? "false",
    PIPELINE_V3_OWNER_CANARY_GROUPS: "genre_scene",
    PIPELINE_V3_OWNER_CANARY_MAX_TRACKS: "50",
    PIPELINE_V3_GENRE_SCENE_PERCENT:
      authorityEnvironment.PIPELINE_V3_GENRE_SCENE_PERCENT ?? "0",
    PIPELINE_V3_MOOD_ACTIVITY_PERCENT:
      authorityEnvironment.PIPELINE_V3_MOOD_ACTIVITY_PERCENT ?? "0",
    PIPELINE_V3_SIMILARITY_PERCENT:
      authorityEnvironment.PIPELINE_V3_SIMILARITY_PERCENT ?? "0",
    PIPELINE_V3_ARTIST_CATALOGUE_PERCENT:
      authorityEnvironment.PIPELINE_V3_ARTIST_CATALOGUE_PERCENT ?? "0",
    PIPELINE_V3_FIXED_CONTAINER_PERCENT:
      authorityEnvironment.PIPELINE_V3_FIXED_CONTAINER_PERCENT ?? "0",
    PIPELINE_V3_FACTUAL_PERCENT:
      authorityEnvironment.PIPELINE_V3_FACTUAL_PERCENT ?? "0",
    PIPELINE_V3_EXHAUSTIVE_PERCENT:
      authorityEnvironment.PIPELINE_V3_EXHAUSTIVE_PERCENT ?? "0",
    PIPELINE_V3_PRODUCTION_EVIDENCE_APPROVED:
      authorityEnvironment.PIPELINE_V3_PRODUCTION_EVIDENCE_APPROVED ?? "false",
    PIPELINE_V3_GENRE_SCENE_EVIDENCE_APPROVED:
      authorityEnvironment.PIPELINE_V3_GENRE_SCENE_EVIDENCE_APPROVED ?? "false",
    PIPELINE_V3_GEOGRAPHIC_SCOPE_EVIDENCE_APPROVED: "false",
    PIPELINE_V3_FACTUAL_FEASIBILITY_APPROVED:
      authorityEnvironment.PIPELINE_V3_FACTUAL_FEASIBILITY_APPROVED ?? "false",
    RELEASE_EXPECTED_DATABASE_CAPABILITY_VERSION: "2",
    RELEASE_EXPECTED_MANIFEST_CANARY_GUARDS_VERSION: "1",
    RELEASE_EXPECTED_CANONICAL_EXECUTION_HARDENING_VERSION: "1",
    PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION: "6",
    GUIDANCE_CONTRACT_V3_ENABLED:
      authorityEnvironment.GUIDANCE_CONTRACT_V3_ENABLED ?? "false",
    GUIDANCE_CONTRACT_V3_OWNER_CANARY: "true",
    GUIDANCE_CONTRACT_V3_REGGAETON_ENABLED: "false",
  } as PublicRolloutConfiguration;
  const state = {
    schemaVersion: "genio-public-rollout-database-authority/v1",
    evidenceHash: authorityEnvironment.RELEASE_PUBLIC_ROLLOUT_EVIDENCE_HASH!,
    rollbackWarrantHash:
      authorityEnvironment.RELEASE_PUBLIC_ROLLOUT_ROLLBACK_WARRANT_HASH!,
    intentCanaryHash:
      authorityEnvironment.RELEASE_PUBLIC_ROLLOUT_INTENT_CANARY_HASH!,
    intentGroup: "genre_scene",
    toPercent: configuration.PIPELINE_V3_GENRE_SCENE_PERCENT,
    stage: authorityEnvironment.RELEASE_PUBLIC_ROLLOUT_STAGE!,
    targetConfigurationHash: signedArtifactSha256(configuration),
    targetConfiguration: configuration,
  };
  return {
    global: state,
    intents: configuration.PIPELINE_V3_GENRE_SCENE_PERCENT === "0"
      ? {}
      : { genre_scene: state },
  };
}

function assignment(
  stickyKey: string,
  env = environment(),
  prompt = "Smooth reggaeton for a warm late-night dance floor",
  authorityEnvironment = env,
) {
  return createPublicRolloutAssignmentV1({
    prompt,
    requestedTrackCount: 50,
    stickyKey,
    environment: env,
    databaseAuthority: databaseAuthority(authorityEnvironment),
  })!;
}

describe("persisted public canonical rollout assignment", () => {
  test("uses a protected production canary ID as its deterministic sticky key", () => {
    expect(publicRolloutAssignmentStickyKeyV1({
      owner: false,
      clientBucket: "public-bucket",
      releaseCanary: {
        canaryId: "genre-scene-1-percent",
        environment: "production",
        operation: "brief",
      },
    })).toBe("release-canary:genre-scene-1-percent");
    expect(publicRolloutAssignmentStickyKeyV1({
      owner: false,
      clientBucket: "public-bucket",
      releaseCanary: {
        canaryId: "staging-control",
        environment: "staging",
        operation: "brief",
      },
    })).toBeNull();
    expect(publicRolloutAssignmentStickyKeyV1({
      owner: true,
      clientBucket: "owner-bucket",
      releaseCanary: null,
    })).toBeNull();
  });

  test("selects only the sticky 1% genre cohort before canonical brief compilation", () => {
    let selected = null as ReturnType<typeof assignment> | null;
    let control = null as ReturnType<typeof assignment> | null;
    for (let index = 0; index < 5_000 && (!selected || !control); index += 1) {
      const current = assignment(`visitor-${index}`);
      if (current.assigned) selected = current;
      else control = current;
    }
    expect(selected).toMatchObject({
      intentGroup: "genre_scene",
      percentage: 1,
      assigned: true,
    });
    expect(control).toMatchObject({
      intentGroup: "genre_scene",
      percentage: 1,
      assigned: false,
    });
    expect(assignment("repeatable-visitor")).toEqual(
      assignment("repeatable-visitor"),
    );
  });

  test("keeps non-selected intents on control even while another intent is at 1%", () => {
    const result = assignment(
      "similarity-control",
      environment(),
      "Songs similar to Everything In Its Right Place by Radiohead",
    );
    expect(result).toMatchObject({
      intentGroup: "similarity",
      percentage: 0,
      assigned: false,
    });
  });

  test("lets the signed assignment override a broad Contract-3 fallback", () => {
    const similarityControl = assignment(
      "similarity-contract-control",
      environment("100"),
      "Influential music similar to Oasis but not Oasis",
    );
    expect(similarityControl).toMatchObject({
      intentGroup: "similarity",
      percentage: 0,
      assigned: false,
    });
    expect(publicRolloutCanonicalContractRequestedV1({
      assignment: similarityControl,
      fallbackRequested: true,
    })).toBe(false);
    expect(publicRolloutCanonicalContractRequestedV1({
      assignment: assignment(
        "selected-contract-three",
        environment("100"),
      ),
      fallbackRequested: false,
    })).toBe(true);
    expect(publicRolloutCanonicalContractRequestedV1({
      assignment: null,
      fallbackRequested: true,
    })).toBe(true);
  });

  test("persists the decision independently of later environment changes", () => {
    const original = assignment("persistent-visitor", environment("100"));
    expect(original.assigned).toBe(true);
    const parsed = parsePublicRolloutAssignmentV1(
      structuredClone(original),
    );
    expect(parsed).toEqual(original);
    expect(assignment(
      "persistent-visitor",
      environment("0", {
        RELEASE_PUBLIC_ROLLOUT_STAGE: "genre_scene:100->0",
      }),
    )?.assigned).toBe(false);
    expect(parsed?.assigned).toBe(true);
  });

  test("ignores forged percentage variables and routes only from the authoritative database target", () => {
    const forgedRuntime = environment("100", {
      RELEASE_PUBLIC_ROLLOUT_STAGE: "genre_scene:0->0",
    });
    const authoritativeControl = environment("0", {
      RELEASE_PUBLIC_ROLLOUT_STAGE: "genre_scene:0->0",
    });
    expect(assignment(
      "forged-runtime-percent",
      forgedRuntime,
      "Smooth reggaeton for a warm late-night dance floor",
      authoritativeControl,
    )).toMatchObject({
      percentage: 0,
      assigned: false,
    });
    const runtimeControl = environment("0", {
      RELEASE_PUBLIC_ROLLOUT_STAGE: "genre_scene:0->100",
    });
    const authoritativeSelected = environment("100", {
      RELEASE_PUBLIC_ROLLOUT_STAGE: "genre_scene:0->100",
    });
    expect(assignment(
      "database-selected",
      runtimeControl,
      "Smooth reggaeton for a warm late-night dance floor",
      authoritativeSelected,
    )).toMatchObject({
      percentage: 100,
      assigned: true,
    });
  });

  test("rejects assignment tampering and a confirmed intent change", () => {
    const original = assignment("tamper-check", environment("100"));
    expect(() => parsePublicRolloutAssignmentV1({
      ...original,
      assigned: false,
    })).toThrow(/hash does not match/u);
    expect(() => assertPublicRolloutExecutionGroupV1(
      original,
      "similarity",
    )).toThrow(/requires_successor/u);
    expect(() => assertPublicRolloutExecutionGroupV1(
      original,
      "genre_scene",
    )).not.toThrow();
    expect(() => assertPublicRolloutExecutionGroupV1(
      { ...original, assigned: false },
      "similarity",
    )).not.toThrow();
  });

  test("fails closed when the rollout marker or governed approval is invalid", () => {
    expect(() => assignment("bad-marker", environment("1", {
      RELEASE_PUBLIC_ROLLOUT_EVIDENCE_HASH: "not-a-hash",
    }))).toThrow(/database authority is invalid/u);
    expect(assignment("no-evidence", environment("100", {
      PIPELINE_V3_GENRE_SCENE_EVIDENCE_APPROVED: "false",
    }))).toMatchObject({
      percentage: 0,
      assigned: false,
    });
    expect(createPublicRolloutAssignmentV1({
      prompt: "Smooth reggaeton for a warm late-night dance floor",
      requestedTrackCount: 50,
      stickyKey: "owner-only",
      environment: {
        RELEASE_ENVIRONMENT: "production",
        RELEASE_DEPLOYMENT_PHASE: "activate",
      },
    })).toBeNull();
  });

  test("proves that all protected runtime markers match database authority", () => {
    const env = environment("100");
    expect(publicRolloutRuntimeDatabaseAuthorityV1({
      environment: env,
      databaseAuthority: databaseAuthority(env),
    })).toEqual({
      evidenceHash: "a".repeat(64),
      stage: "genre_scene:0->100",
      targetConfigurationHash:
        signedArtifactSha256(
          (databaseAuthority(env).global as {
            targetConfiguration: PublicRolloutConfiguration;
          }).targetConfiguration,
        ),
    });
  });

  test("fails health proof on partial, stale, or database-only rollout state", () => {
    const env = environment("100");
    expect(() => publicRolloutRuntimeDatabaseAuthorityV1({
      environment: {
        ...env,
        RELEASE_PUBLIC_ROLLOUT_EVIDENCE_HASH: "b".repeat(64),
      },
      databaseAuthority: databaseAuthority(env),
    })).toThrow(/runtime identity does not match its database authority/u);
    expect(() => publicRolloutRuntimeDatabaseAuthorityV1({
      environment: {
        RELEASE_ENVIRONMENT: "production",
        RELEASE_DEPLOYMENT_PHASE: "activate",
        RELEASE_PUBLIC_ROLLOUT_EVIDENCE_HASH: "a".repeat(64),
      },
      databaseAuthority: databaseAuthority(env),
    })).toThrow(/runtime identity does not match its database authority/u);
    expect(() => publicRolloutRuntimeDatabaseAuthorityV1({
      environment: {
        RELEASE_ENVIRONMENT: "production",
        RELEASE_DEPLOYMENT_PHASE: "activate",
      },
      databaseAuthority: databaseAuthority(env),
    })).toThrow(/runtime identity does not match its database authority/u);
    expect(publicRolloutRuntimeDatabaseAuthorityV1({
      environment: {
        RELEASE_ENVIRONMENT: "production",
        RELEASE_DEPLOYMENT_PHASE: "activate",
      },
      databaseAuthority: null,
    })).toBeNull();
  });
});
