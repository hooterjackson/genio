import { createHash, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Client, type QueryResult } from "pg";
import {
  PUBLIC_ROLLOUT_INTENT_PERCENT_FLAGS,
  verifyPublicRolloutEvidence,
  verifyPublicRolloutRollbackWarrant,
  type PublicRolloutConfiguration,
  type PublicRolloutIntentGroup,
  type PublicRolloutPercentages,
  type VerifiedPublicRolloutEvidence,
  type VerifiedPublicRolloutRollbackWarrant,
} from "../shared/public-rollout-evidence.ts";
import {
  publicRolloutIntentCanaryKeyFingerprint,
} from "../shared/public-rollout-intent-canary.ts";

const SHA256 = /^[0-9a-f]{64}$/u;
const GROUP =
  /^(?:editorial_influence|genre_scene|mood_activity_theme|similarity|artist_catalogue|fixed_container|factual_relationship|exhaustive)$/u;
const PERCENTAGES = ["0", "1", "10", "50", "100"] as const;

export interface PublicRolloutDatabaseTransition {
  evidenceHash: string;
  previousEvidenceHash: string | null;
  operation: "advance" | "rollback_to_zero";
  intentGroup: string;
  fromPercent: string;
  toPercent: string;
  stage: string;
  generatedAt: string;
  expiresAt: string;
  promotionEvidenceHash: string;
  targetConfigurationHash: string;
  intentCanaryHash: string;
  rollbackWarrantHash: string;
  currentPercentages: PublicRolloutPercentages;
  targetConfiguration: PublicRolloutConfiguration;
}

export interface PublicRolloutDatabaseClient {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Record<string, unknown>>>;
}

export function publicRolloutIntentCanaryDatabaseTrust(
  environment: NodeJS.ProcessEnv,
  rolloutVerificationKey: Buffer,
): {
  verificationKey: Buffer;
  trust: { producerKeyId: string; producerKeySha256: string };
} {
  const keyBase64 =
    environment
      .RELEASE_PUBLIC_ROLLOUT_INTENT_CANARY_VERIFICATION_KEY_BASE64
      ?.trim() ?? "";
  let verificationKey: Buffer;
  try {
    verificationKey = Buffer.from(keyBase64, "base64");
    if (
      !keyBase64
      || verificationKey.toString("base64") !== keyBase64
      || createPublicKey(verificationKey).asymmetricKeyType !== "ed25519"
    ) {
      throw new Error("bad key");
    }
  } catch {
    throw new Error("signed public rollout database authority is invalid");
  }
  const trust = {
    producerKeyId:
      environment.RELEASE_PUBLIC_ROLLOUT_INTENT_CANARY_KEY_ID?.trim() ?? "",
    producerKeySha256:
      environment.RELEASE_PUBLIC_ROLLOUT_INTENT_CANARY_KEY_SHA256?.trim() ?? "",
  };
  if (
    !/^[0-9A-Za-z][0-9A-Za-z._:+/-]{2,159}$/u.test(trust.producerKeyId)
    || !SHA256.test(trust.producerKeySha256)
    || publicRolloutIntentCanaryKeyFingerprint(verificationKey)
      !== trust.producerKeySha256
    || publicRolloutIntentCanaryKeyFingerprint(rolloutVerificationKey)
      === trust.producerKeySha256
  ) {
    throw new Error("signed public rollout database authority is invalid");
  }
  return { verificationKey, trust };
}

export function publicRolloutDatabaseTransition(
  environment: NodeJS.ProcessEnv = process.env,
  embeddedAuthority?: {
    verificationKeySha256: string;
    intentCanaryAuthorityPolicySha256: string;
    version: string;
    revision: string;
    /** Pure-test injection; production main always verifies the envelope. */
    verifiedEvidence?: VerifiedPublicRolloutEvidence;
    /** Pure-test injection; production main always verifies the warrant. */
    verifiedRollbackWarrant?: VerifiedPublicRolloutRollbackWarrant;
  },
): PublicRolloutDatabaseTransition {
  const authority = embeddedAuthority ?? (() => {
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(".genio-build.json", "utf8"));
    } catch {
      throw new Error("immutable release authority could not be read");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("immutable release authority is invalid");
    }
    const record = value as Record<string, unknown>;
    return {
      verificationKeySha256:
        typeof record.releaseVerificationKeySha256 === "string"
          ? record.releaseVerificationKeySha256
          : "",
      intentCanaryAuthorityPolicySha256:
        typeof record.publicRolloutIntentCanaryAuthorityPolicySha256 === "string"
          ? record.publicRolloutIntentCanaryAuthorityPolicySha256
          : "",
      version: typeof record.version === "string" ? record.version : "",
      revision: typeof record.revision === "string" ? record.revision : "",
    };
  })();
  const keyBase64 =
    environment.RELEASE_PUBLIC_ROLLOUT_VERIFICATION_KEY_BASE64?.trim() ?? "";
  let verificationKey: Buffer;
  try {
    verificationKey = Buffer.from(keyBase64, "base64");
    if (
      !keyBase64
      || verificationKey.length < 32
      || verificationKey.toString("base64") !== keyBase64
    ) {
      throw new Error("bad key");
    }
  } catch {
    throw new Error("signed public rollout database authority is invalid");
  }
  if (
    environment.RELEASE_ENVIRONMENT !== "production"
    || environment.RELEASE_DEPLOYMENT_PHASE !== "activate"
    || !SHA256.test(authority.verificationKeySha256)
    || createHash("sha256").update(verificationKey).digest("hex")
      !== authority.verificationKeySha256
    || !SHA256.test(authority.intentCanaryAuthorityPolicySha256)
    || environment
      .RELEASE_PUBLIC_ROLLOUT_INTENT_CANARY_AUTHORITY_POLICY_SHA256?.trim()
      !== authority.intentCanaryAuthorityPolicySha256
    || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(
      authority.version,
    )
    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(authority.revision)
  ) {
    throw new Error("signed public rollout database authority is invalid");
  }
  const envelopeFromBase64 = (name: string): unknown => {
    const envelopeBase64 = environment[name]?.trim() ?? "";
    try {
      const envelopeBytes = Buffer.from(envelopeBase64, "base64");
      if (!envelopeBase64 || envelopeBytes.toString("base64") !== envelopeBase64) {
        throw new Error("bad envelope");
      }
      return JSON.parse(envelopeBytes.toString("utf8"));
    } catch {
      throw new Error("signed public rollout database authority is invalid");
    }
  };
  const verifiedPair = embeddedAuthority?.verifiedEvidence
    && embeddedAuthority.verifiedRollbackWarrant
    ? {
        evidence: embeddedAuthority.verifiedEvidence,
        warrant: embeddedAuthority.verifiedRollbackWarrant,
      }
    : (() => {
    const envelope = envelopeFromBase64(
      "RELEASE_PUBLIC_ROLLOUT_EVIDENCE_ENVELOPE_BASE64",
    );
    const warrantEnvelope = envelopeFromBase64(
      "RELEASE_PUBLIC_ROLLOUT_ROLLBACK_WARRANT_ENVELOPE_BASE64",
    );
    const payload = envelope && typeof envelope === "object"
      && !Array.isArray(envelope)
      ? (envelope as { payload?: unknown }).payload
      : null;
    const candidate = payload && typeof payload === "object"
      && !Array.isArray(payload)
      ? (payload as { candidate?: unknown }).candidate
      : null;
    const targetConfiguration = payload && typeof payload === "object"
      && !Array.isArray(payload)
      ? (payload as { targetConfiguration?: unknown }).targetConfiguration
      : null;
    const promotion = payload && typeof payload === "object"
      && !Array.isArray(payload)
      ? (payload as { promotion?: unknown }).promotion
      : null;
    const transition = payload && typeof payload === "object"
      && !Array.isArray(payload)
      ? (payload as { transition?: unknown }).transition
      : null;
    if (
      !candidate
      || typeof candidate !== "object"
      || Array.isArray(candidate)
      || !targetConfiguration
      || typeof targetConfiguration !== "object"
      || Array.isArray(targetConfiguration)
      || !promotion
      || typeof promotion !== "object"
      || Array.isArray(promotion)
      || !transition
      || typeof transition !== "object"
      || Array.isArray(transition)
    ) {
      throw new Error("signed public rollout database authority is invalid");
    }
    const candidateRecord = candidate as Record<string, unknown>;
    const targetRecord = targetConfiguration as Record<string, unknown>;
    const promotionRecord = promotion as Record<string, unknown>;
    const operation = (transition as Record<string, unknown>).operation;
    const intentCanaryEnvelope = operation === "advance"
      ? envelopeFromBase64(
          "RELEASE_PUBLIC_ROLLOUT_INTENT_CANARY_ENVELOPE_BASE64",
        )
      : undefined;
    let intentCanaryVerificationKey: Buffer | undefined;
    let intentCanaryTrust:
      | { producerKeyId: string; producerKeySha256: string }
      | undefined;
    if (operation === "advance") {
      const authority = publicRolloutIntentCanaryDatabaseTrust(
        environment,
        verificationKey,
      );
      intentCanaryVerificationKey = authority.verificationKey;
      intentCanaryTrust = authority.trust;
    }
    const evidence = verifyPublicRolloutEvidence(
      envelope,
      verificationKey,
      {
        expectedTag:
          typeof candidateRecord.tag === "string" ? candidateRecord.tag : "",
        expectedVersion: authority.version,
        expectedRevision: authority.revision,
        expectedImageDigest:
          typeof candidateRecord.imageDigest === "string"
            ? candidateRecord.imageDigest
            : "",
        expectedOwnerCanaryGroups:
          typeof targetRecord.PIPELINE_V3_OWNER_CANARY_GROUPS === "string"
            ? targetRecord.PIPELINE_V3_OWNER_CANARY_GROUPS
            : "",
        expectedOwnerCanaryMaximumTracks:
          typeof targetRecord.PIPELINE_V3_OWNER_CANARY_MAX_TRACKS === "string"
            ? targetRecord.PIPELINE_V3_OWNER_CANARY_MAX_TRACKS
            : "",
        ...(operation === "rollback_to_zero"
          ? { rollbackWarrant: warrantEnvelope }
          : {
            intentCanary: intentCanaryEnvelope,
            intentCanaryVerificationKey,
            intentCanaryTrust,
            intentCanaryAuthorityPolicyHash:
              authority.intentCanaryAuthorityPolicySha256,
          }),
      },
    );
    const warrant = verifyPublicRolloutRollbackWarrant(
      warrantEnvelope,
      verificationKey,
      {
        expectedTag:
          typeof candidateRecord.tag === "string" ? candidateRecord.tag : "",
        expectedVersion: authority.version,
        expectedRevision: authority.revision,
        expectedImageDigest:
          typeof candidateRecord.imageDigest === "string"
            ? candidateRecord.imageDigest
            : "",
        expectedPromotionEvidenceHash:
          typeof candidateRecord.promotionEvidenceHash === "string"
            ? candidateRecord.promotionEvidenceHash
            : "",
        expectedPromotionConfigurationHash:
          typeof promotionRecord.configurationHash === "string"
            ? promotionRecord.configurationHash
            : "",
        expectedPromotionRuntimeHash:
          typeof promotionRecord.runtimeHash === "string"
            ? promotionRecord.runtimeHash
            : "",
        expectedProductionCanaryEvidenceHash:
          typeof promotionRecord.productionCanaryEvidenceHash === "string"
            ? promotionRecord.productionCanaryEvidenceHash
            : "",
        expectedSitesVersion:
          typeof promotionRecord.sitesVersion === "string"
            ? promotionRecord.sitesVersion
            : "",
        expectedSitesRevision:
          typeof promotionRecord.sitesRevision === "string"
            ? promotionRecord.sitesRevision
            : "",
        ...(evidence.operation === "advance"
          ? { expectedAdvance: evidence }
          : { expectedRollback: evidence }),
      },
    );
    return { evidence, warrant };
  })();
  const verified = verifiedPair.evidence;
  const verifiedWarrant = verifiedPair.warrant;
  const evidenceHash = verified.payloadHash;
  const previous = verified.previousRolloutEvidenceHash;
  const operation = verified.operation;
  const intentGroup = verified.intentGroup;
  const fromPercent = verified.fromPercent;
  const toPercent = verified.toPercent;
  const stage = `${intentGroup}:${fromPercent}->${toPercent}`;
  const rollbackWarrantHash = verifiedWarrant.payloadHash;
  if (
    operation === "advance"
      ? verifiedWarrant.advance.payloadHash !== evidenceHash
        || verifiedWarrant.advance.intentGroup !== intentGroup
        || verifiedWarrant.advance.fromPercent !== fromPercent
        || verifiedWarrant.advance.toPercent !== toPercent
        || verifiedWarrant.advance.targetConfigurationHash
          !== verified.targetConfigurationHash
        || verifiedWarrant.advance.intentCanaryHash
          !== verified.intentCanaryHash
      : verified.rollbackWarrantHash !== rollbackWarrantHash
        || verifiedWarrant.advance.payloadHash !== previous
        || verifiedWarrant.rollback.intentGroup !== intentGroup
        || verifiedWarrant.rollback.fromPercent !== fromPercent
        || verifiedWarrant.rollback.toPercent !== toPercent
        || verifiedWarrant.rollback.targetConfigurationHash
          !== verified.targetConfigurationHash
        || verifiedWarrant.advance.intentCanaryHash
          !== verified.intentCanaryHash
  ) {
    throw new Error(
      "signed public rollout database transition does not match its rollback warrant",
    );
  }
  const fromIndex = PERCENTAGES.indexOf(
    fromPercent as typeof PERCENTAGES[number],
  );
  if (
    !SHA256.test(evidenceHash)
    || !SHA256.test(rollbackWarrantHash)
    || (previous !== null && !SHA256.test(previous))
    || !GROUP.test(intentGroup)
    || !(PERCENTAGES as readonly string[]).includes(fromPercent)
    || !(PERCENTAGES as readonly string[]).includes(toPercent)
    || environment.RELEASE_PUBLIC_ROLLOUT_EVIDENCE_HASH?.trim()
      !== evidenceHash
    || environment.RELEASE_PUBLIC_ROLLOUT_ROLLBACK_WARRANT_HASH?.trim()
      !== rollbackWarrantHash
    || environment.RELEASE_PUBLIC_ROLLOUT_INTENT_CANARY_HASH?.trim()
      !== verified.intentCanaryHash
    || environment.RELEASE_PUBLIC_ROLLOUT_STAGE?.trim() !== stage
    || environment.RELEASE_PUBLIC_ROLLOUT_OPERATION?.trim() !== operation
    || environment.RELEASE_PUBLIC_ROLLOUT_INTENT_GROUP?.trim() !== intentGroup
    || environment.RELEASE_PUBLIC_ROLLOUT_FROM_PERCENT?.trim() !== fromPercent
    || environment.RELEASE_PUBLIC_ROLLOUT_TO_PERCENT?.trim() !== toPercent
    || (
      environment.RELEASE_PREVIOUS_PUBLIC_ROLLOUT_EVIDENCE_HASH?.trim()
      !== (previous ?? "none")
    )
  ) {
    throw new Error("signed public rollout database transition is invalid");
  }
  if (
    operation === "advance"
      ? PERCENTAGES[fromIndex + 1] !== toPercent
      : fromPercent === "0" || toPercent !== "0"
  ) {
    throw new Error(
      "signed public rollout database transition is not adjacent or zero-safe",
    );
  }
  return {
    evidenceHash,
    previousEvidenceHash: previous,
    operation,
    intentGroup,
    fromPercent,
    toPercent,
    stage,
    generatedAt: verified.generatedAt,
    expiresAt: verified.expiresAt,
    promotionEvidenceHash: verified.promotionEvidenceHash,
    targetConfigurationHash: verified.targetConfigurationHash,
    intentCanaryHash: verified.intentCanaryHash,
    rollbackWarrantHash,
    currentPercentages: verified.currentPercentages,
    targetConfiguration: verified.targetConfiguration,
  };
}

export async function applyPublicRolloutDatabaseTransition(
  client: PublicRolloutDatabaseClient,
  transition: PublicRolloutDatabaseTransition,
): Promise<{ applied: boolean; disabled: boolean }> {
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    await client.query(
      "SELECT pg_advisory_xact_lock($1,$2)",
      [0x67656e69, 0x6f726f6c],
    );
    const readiness = await client.query(
      `SELECT
         (SELECT value FROM settings WHERE key='schema_version') schema_version,
         (SELECT value FROM settings
          WHERE key='release_manifest_canary_guards_version') capability_version,
         (SELECT value FROM settings
          WHERE key='proof_architecture_version') proof_architecture_version,
         (SELECT value FROM settings
          WHERE key='proof_architecture_authority') proof_architecture_authority`,
    );
    if (
      readiness.rows[0]?.schema_version !== "20"
      || readiness.rows[0]?.capability_version !== "1"
      || readiness.rows[0]?.proof_architecture_version !== "1"
      || readiness.rows[0]?.proof_architecture_authority !== "native"
    ) {
      throw new Error(
        "public rollout database is not schema-20/native-proof/capability-1 ready",
      );
    }
    const globalSettingKey = "public_rollout_state:global";
    const intentSettingKey =
      `public_rollout_state:${transition.intentGroup}`;
    const priorGlobal = await client.query(
      "SELECT value FROM settings WHERE key=$1 FOR UPDATE",
      [globalSettingKey],
    );
    const state = (
      value: unknown,
      label: string,
    ): Record<string, unknown> | null => {
      if (value === undefined) return null;
      if (typeof value !== "string") {
        throw new Error(`public rollout ${label} database state is corrupt`);
      }
      try {
        const parsed = JSON.parse(value);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("wrong state shape");
        }
        return parsed as Record<string, unknown>;
      } catch {
        throw new Error(`public rollout ${label} database state is corrupt`);
      }
    };
    const priorGlobalState = state(
      priorGlobal.rows[0]?.value,
      "global",
    );
    const priorIntentStates = new Map<
      PublicRolloutIntentGroup,
      Record<string, unknown> | null
    >();
    for (const intentGroup of Object.keys(
      PUBLIC_ROLLOUT_INTENT_PERCENT_FLAGS,
    ) as PublicRolloutIntentGroup[]) {
      const result = await client.query(
        "SELECT value FROM settings WHERE key=$1 FOR UPDATE",
        [`public_rollout_state:${intentGroup}`],
      );
      priorIntentStates.set(
        intentGroup,
        state(result.rows[0]?.value, `intent ${intentGroup}`),
      );
    }
    const priorIntentState = priorIntentStates.get(
      transition.intentGroup as PublicRolloutIntentGroup,
    ) ?? null;
    const alreadyApplied =
      priorGlobalState?.evidenceHash === transition.evidenceHash;
    if (!alreadyApplied) {
      for (const [intentGroup, flag] of Object.entries(
        PUBLIC_ROLLOUT_INTENT_PERCENT_FLAGS,
      ) as Array<[PublicRolloutIntentGroup, keyof PublicRolloutPercentages]>) {
        const expected = transition.currentPercentages[flag];
        const observed = String(
          priorIntentStates.get(intentGroup)?.toPercent ?? "0",
        );
        if (observed !== expected) {
          throw new Error(
            `public rollout ${intentGroup} database lineage does not match signed current percentages`,
          );
        }
      }
    }
    if (alreadyApplied) {
      if (
        priorIntentState?.evidenceHash !== transition.evidenceHash
        || priorIntentState.toPercent !== transition.toPercent
        || (
          priorGlobalState.targetConfigurationHash !== undefined
          && priorGlobalState.targetConfigurationHash
            !== transition.targetConfigurationHash
        )
        || priorGlobalState.rollbackWarrantHash
          !== transition.rollbackWarrantHash
        || priorGlobalState.intentCanaryHash
          !== transition.intentCanaryHash
      ) {
        throw new Error(
          "public rollout idempotency state disagrees with its intent lineage",
        );
      }
      const killSwitch = await client.query(
        `SELECT disabled
         FROM pipeline_cohort_kill_switches
         WHERE route='corpus_first_v3' AND intent_group=$1
         FOR UPDATE`,
        [transition.intentGroup],
      );
      const expectedDisabled = transition.operation === "rollback_to_zero";
      if (
        killSwitch.rows.length !== 1
        || killSwitch.rows[0]?.disabled !== expectedDisabled
      ) {
        throw new Error(
          "public rollout idempotency state disagrees with its intent kill switch",
        );
      }
    }
    if (!alreadyApplied && (
      transition.previousEvidenceHash === null
        ? priorGlobalState !== null
        : priorGlobalState?.evidenceHash !== transition.previousEvidenceHash
    )) {
      throw new Error("public rollout global database state does not match signed lineage");
    }
    if (
      !alreadyApplied
      && transition.operation === "rollback_to_zero"
      && (
        priorGlobalState?.rollbackWarrantHash
          !== transition.rollbackWarrantHash
        || priorIntentState?.rollbackWarrantHash
          !== transition.rollbackWarrantHash
        || priorGlobalState?.intentCanaryHash
          !== transition.intentCanaryHash
        || priorIntentState?.intentCanaryHash
          !== transition.intentCanaryHash
      )
    ) {
      throw new Error(
        "public rollout active database authority does not match the signed rollback warrant",
      );
    }
    if (!alreadyApplied && (
      (priorIntentState?.toPercent ?? "0") !== transition.fromPercent
    )) {
      throw new Error("public rollout intent database state does not match signed percentage");
    }
    const disabled = transition.operation === "rollback_to_zero";
    const persistedAuthority = {
      schemaVersion: "genio-public-rollout-database-authority/v1",
      evidenceHash: transition.evidenceHash,
      previousEvidenceHash: transition.previousEvidenceHash,
      operation: transition.operation,
      intentGroup: transition.intentGroup,
      fromPercent: transition.fromPercent,
      toPercent: transition.toPercent,
      stage: transition.stage,
      generatedAt: transition.generatedAt,
      expiresAt: transition.expiresAt,
      promotionEvidenceHash: transition.promotionEvidenceHash,
      targetConfigurationHash: transition.targetConfigurationHash,
      intentCanaryHash: transition.intentCanaryHash,
      rollbackWarrantHash: transition.rollbackWarrantHash,
      currentPercentages: transition.currentPercentages,
      targetConfiguration: transition.targetConfiguration,
    } as const;
    await client.query(
      `INSERT INTO pipeline_cohort_kill_switches(
         cohort_key,route,intent_group,disabled,reason_code,changed_by,changed_at)
       VALUES($1,'corpus_first_v3',$2,$3,$4,$5,now())
       ON CONFLICT(route,intent_group) DO UPDATE SET
         cohort_key=excluded.cohort_key,
         disabled=excluded.disabled,
         reason_code=excluded.reason_code,
         changed_by=excluded.changed_by,
         changed_at=now()`,
      [
        `signed-public-rollout:${transition.intentGroup}`,
        transition.intentGroup,
        disabled,
        disabled ? "signed_public_rollout_rollback" : null,
        `release-evidence:${transition.evidenceHash.slice(0, 24)}`,
      ],
    );
    // Assignment admission and the signed cohort authority must move in the
    // same serializable transaction. Otherwise a valid advance can remain
    // actionlessly paused, or a rollback can leave public assignment open
    // after its percentage and kill switch have returned to zero.
    for (const pauseKey of [
      "pipeline_v3_public_assignment_paused",
      `pipeline_v3_public_assignment_paused:${transition.intentGroup}`,
    ]) {
      await client.query(
        `INSERT INTO settings(key,value,updated_at)
         VALUES($1,$2,now())
         ON CONFLICT(key) DO UPDATE SET
           value=excluded.value,updated_at=excluded.updated_at`,
        [pauseKey, disabled ? "true" : "false"],
      );
    }
    await client.query(
      `INSERT INTO settings(key,value,updated_at)
       VALUES($1,$2,now())
       ON CONFLICT(key) DO UPDATE SET
         value=excluded.value,updated_at=excluded.updated_at`,
      [
        intentSettingKey,
        JSON.stringify({
          ...persistedAuthority,
        }),
      ],
    );
    await client.query(
      `INSERT INTO settings(key,value,updated_at)
       VALUES($1,$2,now())
       ON CONFLICT(key) DO UPDATE SET
         value=excluded.value,updated_at=excluded.updated_at`,
      [
        globalSettingKey,
        JSON.stringify(persistedAuthority),
      ],
    );
    await client.query(
      `INSERT INTO settings(key,value,updated_at)
       VALUES($1,$2,now())
       ON CONFLICT(key) DO UPDATE SET
         value=CASE
           WHEN settings.value=excluded.value THEN settings.value
           ELSE settings.value
         END,
         updated_at=CASE
           WHEN settings.value=excluded.value THEN settings.updated_at
           ELSE settings.updated_at
         END
       RETURNING value`,
      [
        `public_rollout_authority:${transition.evidenceHash}`,
        JSON.stringify(persistedAuthority),
      ],
    );
    await client.query(
      `INSERT INTO settings(key,value,updated_at)
       VALUES($1,$2,now())
       ON CONFLICT(key) DO UPDATE SET
         value=CASE
           WHEN settings.value=excluded.value THEN settings.value
           ELSE settings.value
         END,
         updated_at=CASE
           WHEN settings.value=excluded.value THEN settings.updated_at
           ELSE settings.updated_at
         END
       RETURNING value`,
      [
        `public_rollout_rollback_warrant:${transition.rollbackWarrantHash}`,
        JSON.stringify({
          schemaVersion: "genio-public-rollout-rollback-warrant-authority/v1",
          rollbackWarrantHash: transition.rollbackWarrantHash,
          advanceEvidenceHash: transition.operation === "advance"
            ? transition.evidenceHash
            : transition.previousEvidenceHash,
          intentGroup: transition.intentGroup,
          intentCanaryHash: transition.intentCanaryHash,
          rollbackToPercent: "0",
        }),
      ],
    );
    await client.query("COMMIT");
    return { applied: !alreadyApplied, disabled };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function main(): Promise<void> {
  const transition = publicRolloutDatabaseTransition();
  const databaseUrl =
    process.env.DATABASE_PUBLIC_URL?.trim()
    || process.env.DATABASE_URL?.trim()
    || "";
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await applyPublicRolloutDatabaseTransition(
      client,
      transition,
    );
    process.stdout.write(`${JSON.stringify({
      applied: result.applied,
      disabled: result.disabled,
      intentGroup: transition.intentGroup,
      toPercent: transition.toPercent,
      evidenceHash: transition.evidenceHash,
    })}\n`);
  } finally {
    await client.end();
  }
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
