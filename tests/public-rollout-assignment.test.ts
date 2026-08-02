import { describe, expect, test } from "vitest";
import {
  assertPublicRolloutExecutionGroupV1,
  createPublicRolloutAssignmentV1,
  createV254DirectExposureAssignmentV1,
  publicRolloutAdmissionDispositionV1,
  parsePublicRolloutAssignmentV1,
  publicRolloutAssignmentStickyKeyV1,
  publicRolloutAssignmentPausedV1,
  publicRolloutCanonicalContractRequestedV1,
  publicRolloutIntentGroupForPromptV1,
  publicRolloutRuntimeDatabaseAuthorityV1,
  v254DirectExposureRuntimeDatabaseAuthorityV1,
  V254_DIRECT_EXPOSURE_ASSIGNMENT_VERSION,
} from "../server/public-rollout-assignment.ts";
import {
  PUBLIC_ROLLOUT_INTENT_PERCENT_FLAGS,
  type PublicRolloutConfiguration,
  type PublicRolloutIntentGroup,
} from "../shared/public-rollout-evidence.ts";
import { signedArtifactSha256 } from "../shared/signed-artifact.ts";
import { createV254DirectExposureRuntimeTransitionV1 } from "../shared/v254-direct-exposure-authority.ts";
import { semanticExecutionConfigurationHash } from "../server/runtime-release.ts";

function environment(
  percent = "1",
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    RELEASE_ENVIRONMENT: "production",
    RELEASE_DEPLOYMENT_PHASE: "activate",
    RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION: "20",
    RELEASE_EXPECTED_DATABASE_CAPABILITY_VERSION: "2",
    RELEASE_EXPECTED_MANIFEST_CANARY_GUARDS_VERSION: "1",
    RELEASE_EXPECTED_CANONICAL_EXECUTION_HARDENING_VERSION: "1",
    RELEASE_EXPECTED_PROOF_ARCHITECTURE_VERSION: "1",
    PIPELINE_V3_PROOF_ARCHITECTURE_MODE: "native",
    RELEASE_PUBLIC_ROLLOUT_EVIDENCE_HASH: "a".repeat(64),
    RELEASE_PUBLIC_ROLLOUT_ROLLBACK_WARRANT_HASH: "f".repeat(64),
    RELEASE_PUBLIC_ROLLOUT_INTENT_CANARY_HASH: "e".repeat(64),
    RELEASE_PUBLIC_ROLLOUT_STAGE: `genre_scene:0->${percent}`,
    PIPELINE_V3_ASSIGNMENT_ENABLED: "true",
    PIPELINE_V3_PRODUCTION_EVIDENCE_APPROVED: "true",
    PIPELINE_V3_CURATED_HOSTED_EVIDENCE_APPROVED: "true",
    PIPELINE_V3_GENRE_SCENE_EVIDENCE_APPROVED: "true",
    PIPELINE_V3_EDITORIAL_INFLUENCE_PERCENT: "0",
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
    PIPELINE_V3_EDITORIAL_INFLUENCE_PERCENT:
      authorityEnvironment.PIPELINE_V3_EDITORIAL_INFLUENCE_PERCENT ?? "0",
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
    RELEASE_EXPECTED_PROOF_ARCHITECTURE_VERSION: "1",
    PIPELINE_V3_PROOF_ARCHITECTURE_MODE: "native",
    PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION: "6",
    GUIDANCE_CONTRACT_V3_ENABLED:
      authorityEnvironment.GUIDANCE_CONTRACT_V3_ENABLED ?? "false",
    GUIDANCE_CONTRACT_V3_OWNER_CANARY: "true",
    GUIDANCE_CONTRACT_V3_REGGAETON_ENABLED: "false",
  } as PublicRolloutConfiguration;
  const intentGroup = authorityEnvironment.RELEASE_PUBLIC_ROLLOUT_STAGE!
    .split(":", 1)[0] as PublicRolloutIntentGroup;
  const intentFlag = PUBLIC_ROLLOUT_INTENT_PERCENT_FLAGS[intentGroup];
  const state = {
    schemaVersion: "genio-public-rollout-database-authority/v1",
    evidenceHash: authorityEnvironment.RELEASE_PUBLIC_ROLLOUT_EVIDENCE_HASH!,
    rollbackWarrantHash:
      authorityEnvironment.RELEASE_PUBLIC_ROLLOUT_ROLLBACK_WARRANT_HASH!,
    intentCanaryHash:
      authorityEnvironment.RELEASE_PUBLIC_ROLLOUT_INTENT_CANARY_HASH!,
    intentGroup,
    toPercent: configuration[intentFlag],
    stage: authorityEnvironment.RELEASE_PUBLIC_ROLLOUT_STAGE!,
    targetConfigurationHash: signedArtifactSha256(configuration),
    targetConfiguration: configuration,
  };
  return {
    global: state,
    intents: configuration[intentFlag] === "0"
      ? {}
      : { [intentGroup]: state },
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

function directExposureFixture() {
  const configEnvironment = environment("0", {
    PIPELINE_V3_EDITORIAL_INFLUENCE_PERCENT: "100",
    PIPELINE_V3_GENRE_SCENE_PERCENT: "0",
  });
  const targetConfiguration = {
    ...databaseAuthority(configEnvironment).global.targetConfiguration,
    // Direct public exposure removes the owner-only semantic bypass while it
    // raises only the editorial percentage. Percentage flags are intentionally
    // excluded from the semantic hash; the owner-route delta is therefore the
    // behavior-affecting pre/post fence exercised by this fixture.
    PIPELINE_V3_OWNER_CANARY: "false" as const,
    PIPELINE_V3_OWNER_CANARY_GROUPS: "",
  };
  const targetConfigurationHash = signedArtifactSha256(targetConfiguration);
  const currentConfiguration = {
    ...targetConfiguration,
    PIPELINE_V3_OWNER_CANARY: "true" as const,
    PIPELINE_V3_OWNER_CANARY_GROUPS: "editorial_influence",
    PIPELINE_V3_EDITORIAL_INFLUENCE_PERCENT: "0" as const,
  };
  const authorityPayloadHash = "1".repeat(64);
  const rollbackWarrantPayloadHash = "2".repeat(64);
  const preconditionsHash = "8".repeat(64);
  const rollbackPlanHash = "9".repeat(64);
  const candidate = {
    tag: "v2.5.4-rc.1",
    version: "2.5.4",
    sourceRevision: "a".repeat(40),
    imageReference: `ghcr.io/hooterjackson/genio@sha256:${"b".repeat(64)}`,
    imageDigest: `sha256:${"b".repeat(64)}`,
  };
  const preExposureSemanticConfigurationHash =
    semanticExecutionConfigurationHash({
      ...configEnvironment,
      ...currentConfiguration,
    });
  const postEnvironment = {
    ...configEnvironment,
    ...targetConfiguration,
    RELEASE_PUBLIC_ROLLOUT_EVIDENCE_HASH: undefined,
    RELEASE_PUBLIC_ROLLOUT_ROLLBACK_WARRANT_HASH: undefined,
    RELEASE_PUBLIC_ROLLOUT_INTENT_CANARY_HASH: undefined,
    RELEASE_PUBLIC_ROLLOUT_STAGE: undefined,
    RELEASE_V254_DIRECT_EXPOSURE_PRECONDITIONS_HASH: preconditionsHash,
    RELEASE_V254_DIRECT_EXPOSURE_ROLLBACK_PLAN_HASH: rollbackPlanHash,
    RELEASE_V254_DIRECT_EXPOSURE_STAGE:
      "editorial_influence:0->100:fully_exposed_unproven",
    RELEASE_V254_DIRECT_EXPOSURE_TARGET_CONFIGURATION_HASH:
      targetConfigurationHash,
  };
  const postExposureSemanticConfigurationHash =
    semanticExecutionConfigurationHash(postEnvironment);
  const service = (
    serviceId: string,
    serviceName: "needle-worker" | "needle-deep-worker" | "needle-api",
    deploymentId: string,
  ) => ({
    serviceId,
    serviceName,
    preExposureDeploymentId: deploymentId,
    targetImageReference: candidate.imageReference,
    targetImageDigest: candidate.imageDigest,
    targetSourceRevision: candidate.sourceRevision,
    preExposureSemanticConfigurationHash,
    postExposureSemanticConfigurationHash,
    rollbackDeploymentId: deploymentId,
    rollbackImageReference: candidate.imageReference,
    rollbackImageDigest: candidate.imageDigest,
    rollbackSourceRevision: candidate.sourceRevision,
    rollbackSemanticConfigurationHash: preExposureSemanticConfigurationHash,
  });
  const runtimeTransition = createV254DirectExposureRuntimeTransitionV1({
    candidate,
    preExposureSemanticConfigurationHash,
    postExposureSemanticConfigurationHash,
    services: {
      interactive: service(
        "11111111-1111-4111-8111-111111111111",
        "needle-worker",
        "44444444-4444-4444-8444-444444444444",
      ),
      deep: service(
        "22222222-2222-4222-8222-222222222222",
        "needle-deep-worker",
        "55555555-5555-4555-8555-555555555555",
      ),
      api: service(
        "33333333-3333-4333-8333-333333333333",
        "needle-api",
        "66666666-6666-4666-8666-666666666666",
      ),
    },
  });
  return {
    environment: postEnvironment,
    databaseAuthority: {
      active: {
        schemaVersion:
          "genio-v254-direct-exposure-database-authority/v1",
        state: "active",
        intentGroup: "editorial_influence",
        fromPercent: "0",
        toPercent: "100",
        exposureClass: "fully_exposed_unproven",
        organicReliabilityProven: false,
        authorityPayloadHash,
        rollbackWarrantPayloadHash,
        candidateHash: signedArtifactSha256(candidate),
        candidate,
        targetConfigurationHash,
        targetConfiguration,
        currentConfigurationHash: signedArtifactSha256(currentConfiguration),
        currentConfiguration,
        preconditionsHash,
        rollbackPlanHash,
        runtimeTransition,
      },
    },
  };
}

describe("persisted public canonical rollout assignment", () => {
  test("binds the direct 0-to-100 editorial exposure to its separate authority namespace", () => {
    const fixture = directExposureFixture();
    const runtime = v254DirectExposureRuntimeDatabaseAuthorityV1(fixture);
    expect(runtime).toMatchObject({
      stage: "editorial_influence:0->100:fully_exposed_unproven",
      exposureClass: "fully_exposed_unproven",
      organicReliabilityProven: false,
    });
    const assigned = createV254DirectExposureAssignmentV1({
      prompt: "Infuential irish music",
      requestedTrackCount: 25,
      stickyKey: "clean-non-owner",
      ...fixture,
    });
    expect(assigned).toMatchObject({
      version: V254_DIRECT_EXPOSURE_ASSIGNMENT_VERSION,
      intentGroup: "editorial_influence",
      percentage: 100,
      assigned: true,
    });
    expect(parsePublicRolloutAssignmentV1(assigned)).toEqual(assigned);
    expect(createV254DirectExposureAssignmentV1({
      prompt: "Smooth reggaeton",
      requestedTrackCount: 25,
      stickyKey: "unrelated-intent",
      ...fixture,
    })).toBeNull();
    expect(() => v254DirectExposureRuntimeDatabaseAuthorityV1({
      ...fixture,
      environment: {
        ...fixture.environment,
        RELEASE_PUBLIC_ROLLOUT_EVIDENCE_HASH: "a".repeat(64),
      },
    })).toThrow(/does not match database authority/u);
  });
  test("allows only a signed canary to bypass the public assignment pause", () => {
    const assigned = assignment("pause-fixture", environment("100"));
    expect(assigned.assigned).toBe(true);
    expect(publicRolloutAssignmentPausedV1({
      assignment: assigned,
      signedCanary: false,
      publicAssignmentPaused: true,
    })).toBe(true);
    expect(publicRolloutAssignmentPausedV1({
      assignment: assigned,
      signedCanary: true,
      publicAssignmentPaused: true,
    })).toBe(false);
    expect(publicRolloutAssignmentPausedV1({
      assignment: assigned,
      signedCanary: false,
      publicAssignmentPaused: false,
    })).toBe(false);
  });

  test("classifies and pauses editorial influence without signed rollout authority", () => {
    const intentGroup = publicRolloutIntentGroupForPromptV1({
      prompt: "Infuential irish music",
      requestedTrackCount: 25,
      environment: { APPLE_STOREFRONT: "us" },
    });
    expect(intentGroup).toBe("editorial_influence");
    expect(createPublicRolloutAssignmentV1({
      prompt: "Infuential irish music",
      requestedTrackCount: 25,
      stickyKey: "no-authority",
      environment: {},
      databaseAuthority: null,
    })).toBeNull();
    expect(publicRolloutAssignmentPausedV1({
      assignment: null,
      classifiedIntentGroup: intentGroup,
      signedCanary: false,
      publicAssignmentPaused: false,
      intentPublicAssignmentPaused: true,
    })).toBe(true);
    expect(publicRolloutAssignmentPausedV1({
      assignment: null,
      classifiedIntentGroup: intentGroup,
      signedCanary: true,
      publicAssignmentPaused: true,
      intentPublicAssignmentPaused: true,
    })).toBe(false);
    expect(publicRolloutAdmissionDispositionV1({
      assignment: null,
      classifiedIntentGroup: intentGroup,
      signedCanary: true,
      hardSwitchDisabled: true,
      publicAssignmentPaused: true,
      intentPublicAssignmentPaused: true,
    })).toBe("hard_disabled");
    expect(publicRolloutAdmissionDispositionV1({
      assignment: null,
      classifiedIntentGroup: intentGroup,
      signedCanary: false,
      hardSwitchDisabled: false,
      publicAssignmentPaused: false,
      intentPublicAssignmentPaused: true,
    })).toBe("public_paused");
    expect(publicRolloutAdmissionDispositionV1({
      assignment: null,
      classifiedIntentGroup: intentGroup,
      signedCanary: true,
      hardSwitchDisabled: false,
      publicAssignmentPaused: true,
      intentPublicAssignmentPaused: true,
    })).toBe("admit");
  });

  test("keeps public and ordinary-owner browsers in one cohort while isolating signed canaries", () => {
    expect(publicRolloutAssignmentStickyKeyV1({
      owner: false,
      clientBucket: "same-browser-bucket",
      releaseCanary: null,
    })).toBe("same-browser-bucket");
    expect(publicRolloutAssignmentStickyKeyV1({
      owner: true,
      clientBucket: "same-browser-bucket",
      releaseCanary: null,
    })).toBe("same-browser-bucket");
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
      releaseCanary: {
        canaryId: "owner-canary",
        environment: "production",
        operation: "brief",
      },
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

  test("assigns the repaired editorial-influence cohort independently", () => {
    const env = environment("0", {
      RELEASE_PUBLIC_ROLLOUT_STAGE: "editorial_influence:0->100",
      PIPELINE_V3_EDITORIAL_INFLUENCE_PERCENT: "100",
      PIPELINE_V3_GENRE_SCENE_PERCENT: "0",
    });
    expect(assignment(
      "irish-influence-public",
      env,
      "Infuential irish music",
    )).toMatchObject({
      intentGroup: "editorial_influence",
      percentage: 100,
      assigned: true,
    });
    expect(assignment(
      "irish-influence-without-policy-evidence",
      {
        ...env,
        PIPELINE_V3_GENRE_SCENE_EVIDENCE_APPROVED: "false",
      },
      "Infuential irish music",
    )).toMatchObject({
      intentGroup: "editorial_influence",
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

  test("keeps preserved rollout authority inert during bridge and expand", () => {
    const active = environment("100");
    for (const deploymentPhase of ["bridge", "expand"]) {
      expect(publicRolloutRuntimeDatabaseAuthorityV1({
        environment: {
          ...active,
          RELEASE_DEPLOYMENT_PHASE: deploymentPhase,
        },
        databaseAuthority: databaseAuthority(active),
      })).toBeNull();
    }
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
