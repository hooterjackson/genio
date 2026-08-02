import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";
import {
  verifyV254DirectExposureAuthorityAndWarrantV1,
  type V254DirectExposureExpectedV1,
} from "../shared/v254-direct-exposure-authority.ts";
import { signedArtifactSha256 } from "../shared/signed-artifact.ts";

type JsonRecord = Record<string, unknown>;
export type V254DirectExposureOperation =
  | "plan"
  | "arm"
  | "activate"
  | "rollback";

export const V254_DIRECT_EXPOSURE_ACTIVE_SETTING =
  "v254_direct_exposure_state:active";
export const V254_DIRECT_EXPOSURE_AUTHORITY_PREFIX =
  "v254_direct_exposure_authority:";
export const V254_DIRECT_EXPOSURE_WARRANT_PREFIX =
  "v254_direct_exposure_rollback_warrant:";
export const V254_DIRECT_EXPOSURE_TERMINAL_PREFIX =
  "v254_direct_exposure_terminal:";

const SHA1 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const SAFE_KEY_ID = /^[0-9A-Za-z][0-9A-Za-z._:+/-]{2,159}$/u;
const INTENT = "editorial_influence";
const ROUTE = "corpus_first_v3";

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as JsonRecord;
}

function option(argv: readonly string[], name: string): string {
  const indexes = argv.flatMap((value, index) => value === name ? [index] : []);
  if (indexes.length !== 1) throw new Error(`${name} must be provided exactly once`);
  const value = argv[indexes[0]! + 1]?.trim() ?? "";
  if (!value || value.startsWith("--") || value.includes("\0")) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

export interface V254DirectExposureApplyArgsV1 {
  operation: V254DirectExposureOperation;
  authorityPath: string;
  rollbackWarrantPath: string;
  verificationKeyPath: string;
  expectedKeyId: string;
  expectedKeySha256: string;
  expectedSourceRevision: string;
  expectedVersion: string;
  expectedImageDigest: string;
  outputPath: string;
}

export function parseV254DirectExposureApplyArgsV1(
  argv: readonly string[],
): V254DirectExposureApplyArgsV1 {
  const operation = argv[0];
  if (
    operation !== "plan"
    && operation !== "arm"
    && operation !== "activate"
    && operation !== "rollback"
  ) {
    throw new Error(
      "direct exposure operation must be plan, arm, activate, or rollback",
    );
  }
  const tail = argv.slice(1);
  const names = new Set([
    "--authority", "--rollback-warrant", "--verification-key",
    "--expected-key-id", "--expected-key-sha256",
    "--expected-source-revision", "--expected-version",
    "--expected-image-digest", "--output",
  ]);
  if (tail.length !== names.size * 2) {
    throw new Error("direct exposure apply arguments are incomplete");
  }
  for (let index = 0; index < tail.length; index += 2) {
    if (!names.has(tail[index] ?? "")) {
      throw new Error("unsupported direct exposure apply argument");
    }
  }
  const expectedKeyId = option(tail, "--expected-key-id");
  const expectedKeySha256 = option(tail, "--expected-key-sha256").toLowerCase();
  const expectedSourceRevision = option(
    tail,
    "--expected-source-revision",
  ).toLowerCase();
  const expectedVersion = option(tail, "--expected-version");
  const expectedImageDigest = option(tail, "--expected-image-digest").toLowerCase();
  if (
    !SAFE_KEY_ID.test(expectedKeyId)
    || !SHA256.test(expectedKeySha256)
    || !SHA1.test(expectedSourceRevision)
    || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(expectedVersion)
    || !IMAGE_DIGEST.test(expectedImageDigest)
  ) throw new Error("direct exposure expected binding is invalid");
  return {
    operation,
    authorityPath: option(tail, "--authority"),
    rollbackWarrantPath: option(tail, "--rollback-warrant"),
    verificationKeyPath: option(tail, "--verification-key"),
    expectedKeyId,
    expectedKeySha256,
    expectedSourceRevision,
    expectedVersion,
    expectedImageDigest,
    outputPath: option(tail, "--output"),
  };
}

function expectedFromSignedAuthority(
  authorityValue: unknown,
  args: V254DirectExposureApplyArgsV1,
): V254DirectExposureExpectedV1 {
  const envelope = record(authorityValue, "direct exposure signed authority");
  const payload = record(envelope.payload, "direct exposure authority payload");
  const candidate = record(payload.candidate, "direct exposure candidate");
  const promotion = record(payload.promotion, "direct exposure promotion");
  const proofs = record(payload.proofs, "direct exposure proofs");
  const owner = record(proofs.ownerApple, "direct exposure owner proof");
  const clean = record(proofs.cleanNonOwner, "direct exposure clean proof");
  const route = record(
    proofs.databaseRouteAuthority,
    "direct exposure database route proof",
  );
  if (
    candidate.sourceRevision !== args.expectedSourceRevision
    || candidate.version !== args.expectedVersion
    || candidate.imageDigest !== args.expectedImageDigest
  ) throw new Error("direct exposure artifact is for a different candidate");
  return {
    keyId: args.expectedKeyId,
    keySha256: args.expectedKeySha256,
    candidate: candidate as unknown as V254DirectExposureExpectedV1["candidate"],
    signedNativePromotionAuthorityHash:
      String(promotion.signedNativePromotionAuthorityHash ?? ""),
    nativePromotionReceiptHash:
      String(promotion.nativePromotionReceiptHash ?? ""),
    configurationHash: String(promotion.configurationHash ?? ""),
    runtimeHash: String(promotion.runtimeHash ?? ""),
    semanticBehaviorHash: String(promotion.semanticBehaviorHash ?? ""),
    sites: {
      projectId: String(promotion.sitesProjectId ?? ""),
      versionId: String(promotion.sitesVersionId ?? ""),
      deploymentId: String(promotion.sitesDeploymentId ?? ""),
      revision: String(promotion.sitesRevision ?? ""),
    },
    runtimeTransition:
      promotion.runtimeTransition as V254DirectExposureExpectedV1["runtimeTransition"],
    ownerAppleGateEvidenceHash: String(owner.gateEvidenceHash ?? ""),
    cleanNonOwnerGateEvidenceHash: String(clean.gateEvidenceHash ?? ""),
    databaseRouteReceiptHash: String(route.receiptHash ?? ""),
    currentConfiguration:
      payload.currentConfiguration as V254DirectExposureExpectedV1["currentConfiguration"],
    targetConfiguration:
      payload.targetConfiguration as V254DirectExposureExpectedV1["targetConfiguration"],
    verificationMode: args.operation === "rollback" ? "rollback" : "advance",
  };
}

export interface V254DirectExposureDatabaseClient {
  query(text: string, values?: readonly unknown[]): Promise<{
    rows: Array<Record<string, unknown>>;
    rowCount?: number | null;
  }>;
}

export async function applyV254DirectExposureDatabaseV1(input: {
  client: V254DirectExposureDatabaseClient;
  operation: V254DirectExposureOperation;
  verified: ReturnType<typeof verifyV254DirectExposureAuthorityAndWarrantV1>;
  authorityArtifactHash: string;
  warrantArtifactHash: string;
  authorityArtifact: unknown;
  warrantArtifact: unknown;
  now?: Date;
}) {
  const { client, verified } = input;
  const now = (input.now ?? new Date()).toISOString();
  const candidateHash = signedArtifactSha256(verified.candidate);
  const terminalKey = `${V254_DIRECT_EXPOSURE_TERMINAL_PREFIX}${candidateHash}`;
  const authorityKey = `${V254_DIRECT_EXPOSURE_AUTHORITY_PREFIX}${verified.authorityPayloadHash}`;
  const warrantKey = `${V254_DIRECT_EXPOSURE_WARRANT_PREFIX}${verified.rollbackWarrantPayloadHash}`;
  const plan = {
    schemaVersion: "genio-v254-direct-exposure-database-plan/v1",
    operation: input.operation,
    candidateHash,
    authorityPayloadHash: verified.authorityPayloadHash,
    rollbackWarrantPayloadHash: verified.rollbackWarrantPayloadHash,
    targetConfigurationHash: input.operation === "rollback"
      ? verified.currentConfigurationHash
      : verified.targetConfigurationHash,
    exposureClass: "fully_exposed_unproven",
    organicReliabilityProven: false,
  } as const;
  if (input.operation === "plan") return { ...plan, applied: false, terminal: false };
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    await client.query("SELECT pg_advisory_xact_lock($1,$2)", [
      0x67656e69,
      0x64323534,
    ]);
    const readiness = await client.query(
      `SELECT
         (SELECT value FROM settings WHERE key='schema_version') schema_version,
         (SELECT value FROM settings WHERE key='proof_architecture_authority') proof_authority`,
    );
    if (
      readiness.rows[0]?.schema_version !== "20"
      || readiness.rows[0]?.proof_authority !== "native"
    ) throw new Error("direct exposure requires schema-20 native authority");
    const states = await client.query(
      `SELECT key,value FROM settings
       WHERE key=ANY($1::text[])
          OR key LIKE 'public_rollout_state:%'
       FOR UPDATE`,
      [[
        V254_DIRECT_EXPOSURE_ACTIVE_SETTING,
        terminalKey,
        authorityKey,
        warrantKey,
      ]],
    );
    const byKey = new Map(states.rows.map((row) => [String(row.key), String(row.value)]));
    const activeRaw = byKey.get(V254_DIRECT_EXPOSURE_ACTIVE_SETTING) ?? null;
    const terminalRaw = byKey.get(terminalKey) ?? null;
    const standardStates = [...byKey.entries()].filter(([key]) => (
      key.startsWith("public_rollout_state:")
    ));
    for (const [, standardRaw] of standardStates) {
      let standard: JsonRecord;
      try { standard = record(JSON.parse(standardRaw), "standard rollout state"); }
      catch { throw new Error("standard rollout state is corrupt"); }
      if (String(standard.toPercent ?? "0") !== "0") {
        throw new Error("standard and direct rollout authorities are mutually exclusive");
      }
    }
    if (
      (input.operation === "arm" || input.operation === "activate")
      && terminalRaw !== null
    ) {
      throw new Error("this candidate was rolled back and cannot be re-armed");
    }
    let active: JsonRecord | null = null;
    if (activeRaw) {
      try { active = record(JSON.parse(activeRaw), "direct exposure active state"); }
      catch { throw new Error("direct exposure active state is corrupt"); }
    }
    const exactActive = active !== null
      && active.authorityPayloadHash === verified.authorityPayloadHash
      && active.rollbackWarrantPayloadHash
        === verified.rollbackWarrantPayloadHash
      && active.authorityArtifactHash === input.authorityArtifactHash
      && active.warrantArtifactHash === input.warrantArtifactHash
      && active.currentConfigurationHash === verified.currentConfigurationHash
      && active.targetConfigurationHash === verified.targetConfigurationHash
      && signedArtifactSha256(active.candidate) === candidateHash
      && active.preconditionsHash === verified.preconditionsHash
      && active.rollbackPlanHash === verified.rollbackPlanHash
      && signedArtifactSha256(active.runtimeTransition)
        === signedArtifactSha256(verified.runtimeTransition);
    if (active && !exactActive) {
      throw new Error("a different direct exposure authority is already active");
    }
    const activeState = active?.state;
    if (input.operation === "arm" && exactActive && activeState !== "armed") {
      throw new Error("direct exposure cannot be re-armed from its current state");
    }
    if (
      input.operation === "activate"
      && (!exactActive || (activeState !== "armed" && activeState !== "active"))
    ) throw new Error("direct exposure must be armed before activation");
    if (
      input.operation === "rollback"
      && (!exactActive || !["armed", "active", "rolled_back"].includes(
        String(activeState ?? ""),
      ))
    ) throw new Error("rollback warrant does not match direct exposure state");
    const desiredState = input.operation === "arm"
      ? "armed"
      : input.operation === "activate"
        ? "active"
        : "rolled_back";
    const alreadyApplied = exactActive && activeState === desiredState;
    const disabled = desiredState !== "active";
    await client.query(
      `INSERT INTO pipeline_cohort_kill_switches(
         cohort_key,route,intent_group,disabled,reason_code,changed_by,changed_at)
       VALUES($1,$2,$3,$4,$5,$6,now())
       ON CONFLICT(route,intent_group) DO UPDATE SET
         cohort_key=excluded.cohort_key,disabled=excluded.disabled,
         reason_code=excluded.reason_code,changed_by=excluded.changed_by,
         changed_at=excluded.changed_at`,
      [
        "v254-direct-exposure:editorial-influence",
        ROUTE,
        INTENT,
        disabled,
        disabled ? "v254_direct_exposure_terminal_rollback" : null,
        `direct-exposure:${verified.authorityPayloadHash.slice(0, 24)}`,
      ],
    );
    for (const key of [
      "pipeline_v3_public_assignment_paused",
      `pipeline_v3_public_assignment_paused:${INTENT}`,
    ]) {
      await client.query(
        `INSERT INTO settings(key,value,updated_at) VALUES($1,$2,now())
         ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()`,
        [key, disabled ? "true" : "false"],
      );
    }
    const persisted = {
      schemaVersion: "genio-v254-direct-exposure-database-authority/v1",
      candidateHash,
      candidate: verified.candidate,
      authorityPayloadHash: verified.authorityPayloadHash,
      rollbackWarrantPayloadHash: verified.rollbackWarrantPayloadHash,
      authorityArtifactHash: input.authorityArtifactHash,
      warrantArtifactHash: input.warrantArtifactHash,
      state: desiredState,
      currentConfigurationHash: verified.currentConfigurationHash,
      currentConfiguration: verified.currentConfiguration,
      targetConfigurationHash: verified.targetConfigurationHash,
      targetConfiguration: verified.targetConfiguration,
      preconditionsHash: verified.preconditionsHash,
      rollbackPlanHash: verified.rollbackPlanHash,
      runtimeTransition: verified.runtimeTransition,
      intentGroup: INTENT,
      fromPercent: "0",
      toPercent: "100",
      exposureClass: "fully_exposed_unproven",
      organicReliabilityProven: false,
      retiredStandardAuthorityHash:
        active?.retiredStandardAuthorityHash
        ?? signedArtifactSha256(Object.fromEntries(standardStates)),
      armedAt: active?.armedAt ?? now,
      activatedAt: desiredState === "active"
        ? active?.activatedAt ?? now
        : active?.activatedAt ?? null,
      rolledBackAt: desiredState === "rolled_back" ? now : null,
    } as const;
    if (input.operation === "arm" && standardStates.length > 0) {
      await client.query(
        "DELETE FROM settings WHERE key LIKE 'public_rollout_state:%'",
      );
    }
    for (const [key, value, expectedArtifactHash] of [
      [authorityKey, {
        schemaVersion: "genio-v254-direct-exposure-durable-authority/v1",
        candidateHash,
        authorityPayloadHash: verified.authorityPayloadHash,
        authorityArtifactHash: input.authorityArtifactHash,
        signedEnvelope: input.authorityArtifact,
      }, input.authorityArtifactHash],
      [warrantKey, {
        schemaVersion: "genio-v254-direct-exposure-durable-warrant/v1",
        candidateHash,
        authorityPayloadHash: verified.authorityPayloadHash,
        rollbackWarrantPayloadHash: verified.rollbackWarrantPayloadHash,
        warrantArtifactHash: input.warrantArtifactHash,
        rollbackPlanHash: verified.rollbackPlanHash,
        rollbackPlan: verified.rollbackPlan,
        signedEnvelope: input.warrantArtifact,
      }, input.warrantArtifactHash],
    ] as const) {
      const existingRaw = byKey.get(key) ?? null;
      if (existingRaw) {
        let existing: JsonRecord;
        try { existing = record(JSON.parse(existingRaw), "durable direct artifact"); }
        catch { throw new Error("durable direct artifact is corrupt"); }
        const existingEnvelopeHash = signedArtifactSha256(
          existing.signedEnvelope,
        );
        if (existingEnvelopeHash !== expectedArtifactHash) {
          throw new Error("conflicting direct exposure artifact bytes");
        }
      }
      await client.query(
        `INSERT INTO settings(key,value,updated_at) VALUES($1,$2,now())
         ON CONFLICT(key) DO NOTHING`,
        [key, JSON.stringify(value)],
      );
    }
    if (desiredState === "rolled_back" && !alreadyApplied) {
      await client.query(
        `INSERT INTO settings(key,value,updated_at) VALUES($1,$2,now())
         ON CONFLICT(key) DO UPDATE SET
           value=CASE WHEN settings.value=excluded.value THEN settings.value
                      ELSE settings.value END`,
        [terminalKey, JSON.stringify({ ...persisted, terminal: true })],
      );
    }
    if (!alreadyApplied) {
      await client.query(
        `INSERT INTO settings(key,value,updated_at) VALUES($1,$2,now())
         ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()`,
        [V254_DIRECT_EXPOSURE_ACTIVE_SETTING, JSON.stringify(persisted)],
      );
    }
    await client.query("COMMIT");
    return {
      ...plan,
      applied: !alreadyApplied,
      state: desiredState,
      terminal: desiredState === "rolled_back",
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function requireAbsent(path: string): Promise<void> {
  try { await access(path); throw new Error("direct exposure output exists"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

export async function runV254DirectExposureApplyV1(
  args: V254DirectExposureApplyArgsV1,
) {
  await requireAbsent(args.outputPath);
  let authority: unknown;
  let warrant: unknown;
  let verificationKey: Buffer;
  try {
    [authority, warrant, verificationKey] = await Promise.all([
      readFile(args.authorityPath, "utf8").then(JSON.parse),
      readFile(args.rollbackWarrantPath, "utf8").then(JSON.parse),
      readFile(args.verificationKeyPath),
    ]);
  } catch { throw new Error("direct exposure inputs are not readable"); }
  const expected = expectedFromSignedAuthority(authority, args);
  const verified = verifyV254DirectExposureAuthorityAndWarrantV1({
    authority,
    rollbackWarrant: warrant,
    verificationKey,
    expected,
  });
  const databaseUrl = process.env.DATABASE_URL?.trim() ?? "";
  if (!databaseUrl && args.operation !== "plan") {
    throw new Error("DATABASE_URL is required for direct exposure mutation");
  }
  const client = args.operation === "plan"
    ? ({ query: async () => ({ rows: [] }) } as V254DirectExposureDatabaseClient)
    : new pg.Client({ connectionString: databaseUrl });
  if (client instanceof pg.Client) await client.connect();
  try {
    const receipt = await applyV254DirectExposureDatabaseV1({
      client,
      operation: args.operation,
      verified,
      authorityArtifactHash: signedArtifactSha256(authority),
      warrantArtifactHash: signedArtifactSha256(warrant),
      authorityArtifact: authority,
      warrantArtifact: warrant,
    });
    const receiptFields = Object.fromEntries(
      Object.entries(receipt).filter(([key]) => key !== "schemaVersion"),
    );
    const unsigned = {
      schemaVersion: "genio-v254-direct-exposure-apply-receipt/v1",
      ...receiptFields,
      completedAt: new Date().toISOString(),
    };
    const output = {
      ...unsigned,
      receiptHash: createHash("sha256")
        .update(JSON.stringify(unsigned))
        .digest("hex"),
    };
    await writeFile(args.outputPath, `${JSON.stringify(output, null, 2)}\n`, {
      encoding: "utf8", mode: 0o600, flag: "wx",
    });
    return output;
  } finally {
    if (client instanceof pg.Client) await client.end();
  }
}

async function main(): Promise<void> {
  const args = parseV254DirectExposureApplyArgsV1(process.argv.slice(2));
  const output = await runV254DirectExposureApplyV1(args);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    operation: args.operation,
    receiptHash: output.receiptHash,
  })}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(() => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: "v254_direct_exposure_failed_closed",
      message: "Direct exposure operation failed closed",
    })}\n`);
    process.exitCode = 1;
  });
}
