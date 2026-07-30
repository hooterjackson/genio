import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "vitest";
import type { QueryResult } from "pg";
import {
  applyPublicRolloutDatabaseTransition,
  publicRolloutDatabaseTransition,
  publicRolloutIntentCanaryDatabaseTrust,
  type PublicRolloutDatabaseClient,
} from "../scripts/apply-public-rollout-cohort.ts";
import {
  PUBLIC_ROLLOUT_INTENT_PERCENT_FLAGS,
  type PublicRolloutConfiguration,
  type PublicRolloutIntentGroup,
  type PublicRolloutPercentages,
  type VerifiedPublicRolloutEvidence,
  type VerifiedPublicRolloutRollbackWarrant,
} from "../shared/public-rollout-evidence.ts";
import { signedArtifactSha256 } from "../shared/signed-artifact.ts";
import {
  publicRolloutIntentCanaryKeyFingerprint,
} from "../shared/public-rollout-intent-canary.ts";

const verificationKey = Buffer.from("p".repeat(64));
const verificationKeySha256 = createHash("sha256")
  .update(verificationKey)
  .digest("hex");
const revision = "d".repeat(40);
const intentCanaryAuthorityPolicySha256 = "8".repeat(64);

function targetConfiguration(
  percentages: PublicRolloutPercentages,
): PublicRolloutConfiguration {
  return {
    PIPELINE_V2_OWNER_CANARY: "false",
    PIPELINE_V2_CURATED_PERCENT: "0",
    PIPELINE_V2_SIMILARITY_PERCENT: "0",
    PIPELINE_V2_FACTUAL_OWNER_CANARY: "false",
    PIPELINE_V2_FACTUAL_PERCENT: "0",
    PIPELINE_V3_ASSIGNMENT_ENABLED: "true",
    PIPELINE_V3_OWNER_CANARY: "true",
    PIPELINE_V3_CURATED_HOSTED_EVIDENCE_APPROVED: "true",
    PIPELINE_V3_OWNER_CANARY_GROUPS: "genre_scene",
    PIPELINE_V3_OWNER_CANARY_MAX_TRACKS: "50",
    ...percentages,
    PIPELINE_V3_PRODUCTION_EVIDENCE_APPROVED: "true",
    PIPELINE_V3_GENRE_SCENE_EVIDENCE_APPROVED: "true",
    PIPELINE_V3_GEOGRAPHIC_SCOPE_EVIDENCE_APPROVED: "false",
    PIPELINE_V3_FACTUAL_FEASIBILITY_APPROVED: "true",
    RELEASE_EXPECTED_DATABASE_CAPABILITY_VERSION: "2",
    RELEASE_EXPECTED_MANIFEST_CANARY_GUARDS_VERSION: "1",
    RELEASE_EXPECTED_CANONICAL_EXECUTION_HARDENING_VERSION: "1",
    PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION: "6",
    GUIDANCE_CONTRACT_V3_ENABLED: "false",
    GUIDANCE_CONTRACT_V3_OWNER_CANARY: "true",
    GUIDANCE_CONTRACT_V3_REGGAETON_ENABLED: "false",
  };
}

function databaseTransition(
  env: NodeJS.ProcessEnv,
  currentOverrides: Partial<PublicRolloutPercentages> = {},
  verifiedEvidenceHash =
    env.RELEASE_PUBLIC_ROLLOUT_EVIDENCE_HASH as string,
) {
  const current = {
    PIPELINE_V3_GENRE_SCENE_PERCENT: "0",
    PIPELINE_V3_MOOD_ACTIVITY_PERCENT: "0",
    PIPELINE_V3_SIMILARITY_PERCENT: "0",
    PIPELINE_V3_ARTIST_CATALOGUE_PERCENT: "0",
    PIPELINE_V3_FIXED_CONTAINER_PERCENT: "0",
    PIPELINE_V3_FACTUAL_PERCENT: "0",
    PIPELINE_V3_EXHAUSTIVE_PERCENT: "0",
    ...currentOverrides,
  } as PublicRolloutPercentages;
  const intentGroup =
    env.RELEASE_PUBLIC_ROLLOUT_INTENT_GROUP as PublicRolloutIntentGroup;
  const flag = PUBLIC_ROLLOUT_INTENT_PERCENT_FLAGS[intentGroup];
  current[flag] = env.RELEASE_PUBLIC_ROLLOUT_FROM_PERCENT as never;
  const target = { ...current };
  target[flag] = env.RELEASE_PUBLIC_ROLLOUT_TO_PERCENT as never;
  const configuration = targetConfiguration(target);
  const generatedAt = new Date().toISOString();
  const verified = {
    payloadHash: verifiedEvidenceHash,
    generatedAt,
    expiresAt: new Date(Date.parse(generatedAt) + 60_000).toISOString(),
    promotionEvidenceHash: "e".repeat(64),
    previousRolloutEvidenceHash:
      env.RELEASE_PREVIOUS_PUBLIC_ROLLOUT_EVIDENCE_HASH === "none"
        ? null
        : env.RELEASE_PREVIOUS_PUBLIC_ROLLOUT_EVIDENCE_HASH,
    previousRolloutStage: null,
    rollbackWarrantHash:
      env.RELEASE_PUBLIC_ROLLOUT_OPERATION === "rollback_to_zero"
        ? env.RELEASE_PUBLIC_ROLLOUT_ROLLBACK_WARRANT_HASH
        : null,
    intentCanaryHash:
      env.RELEASE_PUBLIC_ROLLOUT_INTENT_CANARY_HASH as string,
    operation: env.RELEASE_PUBLIC_ROLLOUT_OPERATION,
    intentGroup,
    fromPercent: env.RELEASE_PUBLIC_ROLLOUT_FROM_PERCENT,
    toPercent: env.RELEASE_PUBLIC_ROLLOUT_TO_PERCENT,
    currentPercentages: current,
    targetConfiguration: configuration,
    targetConfigurationHash: signedArtifactSha256(configuration),
    apiConfigurationHash: "1".repeat(64),
    soak: {
      startedAt: generatedAt,
      completedAt: generatedAt,
      durationSeconds: 60,
      healthySampleCount: 3,
      observationsHash: "f".repeat(64),
      observations: [],
      intentStageMetrics:
        env.RELEASE_PUBLIC_ROLLOUT_OPERATION === "advance"
          ? {
              windowStartedAt: generatedAt,
              windowCompletedAt: generatedAt,
              candidateAssignedCount: 0,
              exactCompletionCount: 0,
            }
          : null,
    },
  } as VerifiedPublicRolloutEvidence;
  const warrantTarget = targetConfiguration({
    ...current,
    [flag]: "0",
  });
  const warrant = {
    payloadHash: env.RELEASE_PUBLIC_ROLLOUT_ROLLBACK_WARRANT_HASH,
    generatedAt,
    candidate: {
      tag: "v2.4.0-rc.2",
      version: "2.4.0",
      sourceRevision: revision,
      imageDigest: `sha256:${"a".repeat(64)}`,
      promotionEvidenceHash: verified.promotionEvidenceHash,
    },
    advance: {
      payloadHash:
        verified.operation === "advance"
          ? verified.payloadHash
          : verified.previousRolloutEvidenceHash!,
      stage:
        verified.operation === "advance"
          ? `${intentGroup}:${verified.fromPercent}->${verified.toPercent}`
          : `${intentGroup}:10->${verified.fromPercent}`,
      intentGroup,
      fromPercent:
        verified.operation === "advance" ? verified.fromPercent : "10",
      toPercent:
        verified.operation === "advance"
          ? verified.toPercent
          : verified.fromPercent,
      targetConfigurationHash:
        verified.operation === "advance"
          ? verified.targetConfigurationHash
          : signedArtifactSha256(targetConfiguration(current)),
      intentCanaryHash: verified.intentCanaryHash,
      targetPercentages:
        verified.operation === "advance" ? target : current,
    },
    rollback: {
      operation: "rollback_to_zero",
      intentGroup,
      fromPercent:
        verified.operation === "advance"
          ? verified.toPercent
          : verified.fromPercent,
      toPercent: "0",
      currentPercentages:
        verified.operation === "advance" ? target : current,
      targetConfiguration: warrantTarget,
      targetConfigurationHash: signedArtifactSha256(warrantTarget),
    },
    promotion: {
      configurationHash: "1".repeat(64),
      runtimeHash: "2".repeat(64),
      productionCanaryEvidenceHash: "3".repeat(64),
      sitesVersion: "2.3.9",
      sitesRevision: "e".repeat(40),
    },
  } as VerifiedPublicRolloutRollbackWarrant;
  return publicRolloutDatabaseTransition(env, {
    verificationKeySha256,
    intentCanaryAuthorityPolicySha256,
    version: "2.4.0",
    revision,
    verifiedEvidence: verified,
    verifiedRollbackWarrant: warrant,
  });
}

class FakeClient implements PublicRolloutDatabaseClient {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  readonly states = new Map<string, Record<string, unknown>>();
  killSwitchDisabled: boolean | null = null;

  constructor(state: Record<string, unknown> | null = null) {
    if (state) {
      this.states.set("public_rollout_state:global", state);
      this.states.set("public_rollout_state:genre_scene", state);
    }
  }

  async query(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Record<string, unknown>>> {
    this.calls.push({ text, values });
    if (text.includes("schema_version")) {
      return {
        rows: [{ schema_version: "19", capability_version: "1" }],
        rowCount: 1,
      } as unknown as QueryResult<Record<string, unknown>>;
    }
    if (text.startsWith("SELECT value FROM settings")) {
      const state = this.states.get(String(values?.[0]));
      return {
        rows: state ? [{ value: JSON.stringify(state) }] : [],
        rowCount: state ? 1 : 0,
      } as unknown as QueryResult<Record<string, unknown>>;
    }
    if (text.includes("SELECT disabled")) {
      return {
        rows: this.killSwitchDisabled === null
          ? []
          : [{ disabled: this.killSwitchDisabled }],
        rowCount: this.killSwitchDisabled === null ? 0 : 1,
      } as unknown as QueryResult<Record<string, unknown>>;
    }
    if (text.includes("pipeline_cohort_kill_switches")) {
      this.killSwitchDisabled = Boolean(values?.[2]);
    }
    if (text.includes("INSERT INTO settings")) {
      this.states.set(
        String(values?.[0]),
        JSON.parse(String(values?.[1])),
      );
    }
    return { rows: [], rowCount: 1 } as unknown as QueryResult<Record<string, unknown>>;
  }
}

function environment(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const result = {
    RELEASE_ENVIRONMENT: "production",
    RELEASE_DEPLOYMENT_PHASE: "activate",
    RELEASE_PUBLIC_ROLLOUT_EVIDENCE_HASH: "a".repeat(64),
    RELEASE_PUBLIC_ROLLOUT_ROLLBACK_WARRANT_HASH: "f".repeat(64),
    RELEASE_PUBLIC_ROLLOUT_INTENT_CANARY_HASH: "e".repeat(64),
    RELEASE_PUBLIC_ROLLOUT_INTENT_CANARY_AUTHORITY_POLICY_SHA256:
      intentCanaryAuthorityPolicySha256,
    RELEASE_PREVIOUS_PUBLIC_ROLLOUT_EVIDENCE_HASH: "none",
    RELEASE_PUBLIC_ROLLOUT_OPERATION: "advance",
    RELEASE_PUBLIC_ROLLOUT_INTENT_GROUP: "genre_scene",
    RELEASE_PUBLIC_ROLLOUT_FROM_PERCENT: "0",
    RELEASE_PUBLIC_ROLLOUT_TO_PERCENT: "1",
    RELEASE_PUBLIC_ROLLOUT_STAGE: "genre_scene:0->1",
    RELEASE_PUBLIC_ROLLOUT_VERIFICATION_KEY_BASE64:
      verificationKey.toString("base64"),
    ...overrides,
  };
  result.RELEASE_PUBLIC_ROLLOUT_STAGE ??=
    `${result.RELEASE_PUBLIC_ROLLOUT_INTENT_GROUP}:`
    + `${result.RELEASE_PUBLIC_ROLLOUT_FROM_PERCENT}->`
    + `${result.RELEASE_PUBLIC_ROLLOUT_TO_PERCENT}`;
  if (!Object.hasOwn(overrides, "RELEASE_PUBLIC_ROLLOUT_STAGE")) {
    result.RELEASE_PUBLIC_ROLLOUT_STAGE =
      `${result.RELEASE_PUBLIC_ROLLOUT_INTENT_GROUP}:`
      + `${result.RELEASE_PUBLIC_ROLLOUT_FROM_PERCENT}->`
      + `${result.RELEASE_PUBLIC_ROLLOUT_TO_PERCENT}`;
  }
  return result;
}

describe("atomic signed public rollout database transition", () => {
  test("requires a protected intent-canary key independent from rollout authority", () => {
    const rolloutKeys = generateKeyPairSync("ed25519");
    const canaryKeys = generateKeyPairSync("ed25519");
    const rolloutPublicKey = Buffer.from(
      rolloutKeys.publicKey.export({ format: "pem", type: "spki" }),
    );
    const canaryPublicKey = Buffer.from(
      canaryKeys.publicKey.export({ format: "pem", type: "spki" }),
    );
    const protectedEnvironment = {
      RELEASE_PUBLIC_ROLLOUT_INTENT_CANARY_VERIFICATION_KEY_BASE64:
        canaryPublicKey.toString("base64"),
      RELEASE_PUBLIC_ROLLOUT_INTENT_CANARY_KEY_ID:
        "public-rollout-intent-canary-v1",
      RELEASE_PUBLIC_ROLLOUT_INTENT_CANARY_KEY_SHA256:
        publicRolloutIntentCanaryKeyFingerprint(canaryPublicKey),
    };
    expect(publicRolloutIntentCanaryDatabaseTrust(
      protectedEnvironment,
      rolloutPublicKey,
    )).toMatchObject({
      trust: {
        producerKeyId: "public-rollout-intent-canary-v1",
      },
    });
    expect(() => publicRolloutIntentCanaryDatabaseTrust({
      ...protectedEnvironment,
      RELEASE_PUBLIC_ROLLOUT_INTENT_CANARY_VERIFICATION_KEY_BASE64:
        rolloutPublicKey.toString("base64"),
      RELEASE_PUBLIC_ROLLOUT_INTENT_CANARY_KEY_SHA256:
        publicRolloutIntentCanaryKeyFingerprint(rolloutPublicKey),
    }, rolloutPublicKey)).toThrow(
      /signed public rollout database authority is invalid/u,
    );
  });

  test("enables only the signed intent and records the evidence lineage atomically", async () => {
    const transition = databaseTransition(environment());
    const client = new FakeClient();
    await expect(applyPublicRolloutDatabaseTransition(
      client,
      transition,
    )).resolves.toEqual({ applied: true, disabled: false });
    expect(client.calls.map(({ text }) => text)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^BEGIN ISOLATION LEVEL SERIALIZABLE/u),
      expect.stringContaining("pg_advisory_xact_lock"),
      expect.stringContaining("pipeline_cohort_kill_switches"),
      expect.stringContaining("INSERT INTO settings"),
      "COMMIT",
    ]));
    expect(client.calls.find(({ text }) => (
      text.includes("pipeline_cohort_kill_switches")
    ))?.values).toEqual([
      "signed-public-rollout:genre_scene",
      "genre_scene",
      false,
      null,
      `release-evidence:${"a".repeat(24)}`,
    ]);
    expect(client.states.get("public_rollout_state:global")).toMatchObject({
      evidenceHash: "a".repeat(64),
      rollbackWarrantHash: "f".repeat(64),
      operation: "advance",
      toPercent: "1",
    });
    expect(client.states.get(
      `public_rollout_rollback_warrant:${"f".repeat(64)}`,
    )).toMatchObject({
      advanceEvidenceHash: "a".repeat(64),
      rollbackToPercent: "0",
    });
  });

  test("requires the database state to match the immediately previous signed target", async () => {
    const transition = databaseTransition(environment({
      RELEASE_PUBLIC_ROLLOUT_EVIDENCE_HASH: "b".repeat(64),
      RELEASE_PREVIOUS_PUBLIC_ROLLOUT_EVIDENCE_HASH: "a".repeat(64),
      RELEASE_PUBLIC_ROLLOUT_FROM_PERCENT: "1",
      RELEASE_PUBLIC_ROLLOUT_TO_PERCENT: "10",
    }));
    const client = new FakeClient({
      evidenceHash: "9".repeat(64),
      toPercent: "1",
    });
    await expect(applyPublicRolloutDatabaseTransition(
      client,
      transition,
    )).rejects.toThrow(/does not match signed lineage/u);
    expect(client.calls.at(-1)?.text).toBe("ROLLBACK");
  });

  test("reuses the exact evidence idempotently but fails closed on kill-switch drift", async () => {
    const transition = databaseTransition(environment());
    const client = new FakeClient({
      evidenceHash: "a".repeat(64),
      toPercent: "1",
      rollbackWarrantHash: "f".repeat(64),
      intentCanaryHash: "e".repeat(64),
    });
    client.killSwitchDisabled = false;
    await expect(applyPublicRolloutDatabaseTransition(
      client,
      transition,
    )).resolves.toEqual({ applied: false, disabled: false });

    const drifted = new FakeClient({
      evidenceHash: "a".repeat(64),
      toPercent: "1",
      rollbackWarrantHash: "f".repeat(64),
      intentCanaryHash: "e".repeat(64),
    });
    drifted.killSwitchDisabled = true;
    await expect(applyPublicRolloutDatabaseTransition(
      drifted,
      transition,
    )).rejects.toThrow(/disagrees with its intent kill switch/u);
    expect(drifted.calls.at(-1)?.text).toBe("ROLLBACK");
  });

  test("sets the affected intent kill switch on signed rollback without changing in-flight runs", async () => {
    const transition = databaseTransition(environment({
      RELEASE_PUBLIC_ROLLOUT_EVIDENCE_HASH: "c".repeat(64),
      RELEASE_PREVIOUS_PUBLIC_ROLLOUT_EVIDENCE_HASH: "b".repeat(64),
      RELEASE_PUBLIC_ROLLOUT_OPERATION: "rollback_to_zero",
      RELEASE_PUBLIC_ROLLOUT_FROM_PERCENT: "50",
      RELEASE_PUBLIC_ROLLOUT_TO_PERCENT: "0",
    }));
    const client = new FakeClient({
      evidenceHash: "b".repeat(64),
      toPercent: "50",
      rollbackWarrantHash: "f".repeat(64),
      intentCanaryHash: "e".repeat(64),
    });
    await expect(applyPublicRolloutDatabaseTransition(
      client,
      transition,
    )).resolves.toEqual({ applied: true, disabled: true });
    expect(client.calls.find(({ text }) => (
      text.includes("pipeline_cohort_kill_switches")
    ))?.values?.[2]).toBe(true);
    expect(client.states.get("public_rollout_state:global")).toMatchObject({
      evidenceHash: "c".repeat(64),
      previousEvidenceHash: "b".repeat(64),
      rollbackWarrantHash: "f".repeat(64),
      operation: "rollback_to_zero",
      toPercent: "0",
    });
  });

  test("rejects rollback when the active database warrant hash differs", async () => {
    const transition = databaseTransition(environment({
      RELEASE_PUBLIC_ROLLOUT_EVIDENCE_HASH: "c".repeat(64),
      RELEASE_PREVIOUS_PUBLIC_ROLLOUT_EVIDENCE_HASH: "b".repeat(64),
      RELEASE_PUBLIC_ROLLOUT_OPERATION: "rollback_to_zero",
      RELEASE_PUBLIC_ROLLOUT_FROM_PERCENT: "50",
      RELEASE_PUBLIC_ROLLOUT_TO_PERCENT: "0",
    }));
    const client = new FakeClient({
      evidenceHash: "b".repeat(64),
      toPercent: "50",
      rollbackWarrantHash: "e".repeat(64),
      intentCanaryHash: "e".repeat(64),
    });
    await expect(applyPublicRolloutDatabaseTransition(
      client,
      transition,
    )).rejects.toThrow(/does not match the signed rollback warrant/u);
    expect(client.killSwitchDisabled).toBeNull();
    expect(client.calls.at(-1)?.text).toBe("ROLLBACK");
  });

  test("chains the first rollout of a second intent through global lineage", async () => {
    const transition = databaseTransition(environment({
      RELEASE_PUBLIC_ROLLOUT_EVIDENCE_HASH: "b".repeat(64),
      RELEASE_PREVIOUS_PUBLIC_ROLLOUT_EVIDENCE_HASH: "a".repeat(64),
      RELEASE_PUBLIC_ROLLOUT_INTENT_GROUP: "mood_activity_theme",
      RELEASE_PUBLIC_ROLLOUT_FROM_PERCENT: "0",
      RELEASE_PUBLIC_ROLLOUT_TO_PERCENT: "1",
    }), {
      PIPELINE_V3_GENRE_SCENE_PERCENT: "1",
    });
    const client = new FakeClient();
    client.states.set("public_rollout_state:global", {
      evidenceHash: "a".repeat(64),
      intentGroup: "genre_scene",
      toPercent: "1",
    });
    client.states.set("public_rollout_state:genre_scene", {
      evidenceHash: "a".repeat(64),
      intentGroup: "genre_scene",
      toPercent: "1",
    });
    await expect(applyPublicRolloutDatabaseTransition(
      client,
      transition,
    )).resolves.toEqual({ applied: true, disabled: false });
    expect(client.states.get("public_rollout_state:global"))
      .toMatchObject({
        evidenceHash: "b".repeat(64),
        previousEvidenceHash: "a".repeat(64),
        intentGroup: "mood_activity_theme",
      });
    expect(client.states.get("public_rollout_state:mood_activity_theme"))
      .toMatchObject({
        fromPercent: "0",
        toPercent: "1",
      });
    expect(client.states.get("public_rollout_state:genre_scene"))
      .toMatchObject({
        evidenceHash: "a".repeat(64),
        toPercent: "1",
      });
  });

  test("rejects direct arbitrary percentages and non-production execution", () => {
    expect(() => databaseTransition(environment({
      RELEASE_PUBLIC_ROLLOUT_TO_PERCENT: "25",
    }))).toThrow(/invalid/u);
    expect(() => databaseTransition(environment({
      RELEASE_PUBLIC_ROLLOUT_TO_PERCENT: "50",
    }))).toThrow(/not adjacent/u);
    expect(() => databaseTransition(environment({
      RELEASE_ENVIRONMENT: "staging",
    }))).toThrow(/invalid/u);
  });

  test("cannot turn editable Railway strings into rollout authority", () => {
    const forged = environment({
      RELEASE_PUBLIC_ROLLOUT_EVIDENCE_ENVELOPE_BASE64: undefined,
    });
    expect(() => publicRolloutDatabaseTransition(forged, {
      verificationKeySha256,
      intentCanaryAuthorityPolicySha256,
      version: "2.4.0",
      revision,
    })).toThrow(/database authority is invalid/u);
    expect(() => databaseTransition(environment({
      RELEASE_PUBLIC_ROLLOUT_EVIDENCE_HASH: "9".repeat(64),
    }), {}, "a".repeat(64))).toThrow(/transition is invalid/u);
    expect(() => publicRolloutDatabaseTransition(environment(), {
      verificationKeySha256: "0".repeat(64),
      intentCanaryAuthorityPolicySha256,
      version: "2.4.0",
      revision,
      verifiedEvidence: databaseTransition(environment()) as never,
    })).toThrow(/database authority is invalid/u);
    expect(() => publicRolloutDatabaseTransition(environment({
      RELEASE_PUBLIC_ROLLOUT_INTENT_CANARY_AUTHORITY_POLICY_SHA256:
        "9".repeat(64),
    }), {
      verificationKeySha256,
      intentCanaryAuthorityPolicySha256,
      version: "2.4.0",
      revision,
    })).toThrow(/database authority is invalid/u);
  });
});
