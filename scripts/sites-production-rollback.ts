import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { RELEASE_EVIDENCE_TTL_MS } from "../shared/release-evidence-constants.ts";
import {
  createSitesProductionRollbackReceiptV1,
  createSitesProductionRollbackTargetV1,
  SITES_PRODUCTION_ROLLBACK_PROBE_PARAMETER,
  type SitesProductionRollbackReceiptV1,
  type SitesProductionRollbackTargetV1,
  validateSitesProductionRollbackTargetV1,
  verifySitesProductionRollbackV1,
} from "../shared/sites-production-rollback.ts";
import { exactObject } from "../shared/signed-artifact.ts";

const CAPTURE_SOURCE_SCHEMA_V1 =
  "genio-sites-production-rollback-capture-source/v1";
const DEPLOYMENT_RESULT_SCHEMA_V1 =
  "genio-sites-production-rollback-deployment-result/v1";
const CAPTURE_CONFIRMATION = "--confirm-before-candidate-deployment";
const PRODUCE_CONFIRMATION = "--confirm-exact-saved-version-deployed";

type FetchResponse = {
  status: number;
  text(): Promise<string>;
};

export type RollbackFetch = (
  input: string,
  init: {
    method: "GET";
    cache: "no-store";
    redirect: "error";
    headers: Record<string, string>;
  },
) => Promise<FetchResponse>;

type Clock = () => string;
type NonceFactory = () => string;

export type SitesRollbackCaptureSourceV1 = {
  schemaVersion: typeof CAPTURE_SOURCE_SCHEMA_V1;
  controlPlaneObservedAt: string;
  projectId: string;
  productionUrl: string;
  plannedCandidate: {
    commitSha: string;
    buildVersion: string;
  };
  previous: {
    versionId: string;
    versionNumber: number;
    commitSha: string;
    archiveSha256: string;
    deploymentId: string;
    deploymentStatus: "ready" | "succeeded";
  };
};

export type SitesRollbackDeploymentResultV1 = {
  schemaVersion: typeof DEPLOYMENT_RESULT_SCHEMA_V1;
  projectId: string;
  productionUrl: string;
  candidate: SitesProductionRollbackReceiptV1["candidate"];
  rollback: SitesProductionRollbackReceiptV1["rollback"];
  pollObservations: SitesProductionRollbackReceiptV1["pollObservations"];
};

function readJson(path: string, label: string): Promise<unknown> {
  return readFile(path, "utf8").then((value) => {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      throw new Error(`${label} is not valid JSON`);
    }
  });
}

function strictTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function htmlAttribute(html: string, name: string): string | null {
  const match = new RegExp(
    `\\b${name}=(?:"([^"]+)"|'([^']+)'|([^\\s>]+))`,
    "iu",
  ).exec(html);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function buildIdentityFromHtml(html: string): {
  buildVersion: string;
  buildRevision: string;
} {
  const buildVersion = htmlAttribute(html, "data-build-version");
  const buildRevision = htmlAttribute(html, "data-build-revision");
  if (
    !buildVersion
    || !/^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/u.test(buildVersion)
    || !buildRevision
    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(buildRevision)
  ) {
    throw new Error(
      "Sites live page did not expose exact build version and revision markers",
    );
  }
  return { buildVersion, buildRevision };
}

function cacheBustedUrl(
  origin: string,
  parameter: string,
  nonce: string,
): string {
  const result = new URL(origin);
  result.searchParams.set(parameter, nonce);
  return result.toString();
}

async function fetchBuildIdentity(input: {
  origin: string;
  parameter: string;
  nonce: string;
  fetchImpl: RollbackFetch;
}): Promise<{
  requestUrl: string;
  responseStatus: number;
  buildVersion: string;
  buildRevision: string;
}> {
  const requestUrl = cacheBustedUrl(
    input.origin,
    input.parameter,
    input.nonce,
  );
  const response = await input.fetchImpl(requestUrl, {
    method: "GET",
    cache: "no-store",
    redirect: "error",
    headers: {
      "cache-control": "no-cache, no-store, max-age=0",
      pragma: "no-cache",
    },
  });
  if (response.status !== 200) {
    throw new Error(`Sites live identity probe returned HTTP ${response.status}`);
  }
  return {
    requestUrl,
    responseStatus: response.status,
    ...buildIdentityFromHtml(await response.text()),
  };
}

export function validateSitesRollbackCaptureSourceV1(
  value: unknown,
): SitesRollbackCaptureSourceV1 {
  const source = exactObject(value, [
    "schemaVersion",
    "controlPlaneObservedAt",
    "projectId",
    "productionUrl",
    "plannedCandidate",
    "previous",
  ], "Sites rollback capture source");
  if (source.schemaVersion !== CAPTURE_SOURCE_SCHEMA_V1) {
    throw new Error("Sites rollback capture source uses an unsupported schema");
  }
  const plannedCandidate = exactObject(source.plannedCandidate, [
    "commitSha",
    "buildVersion",
  ], "Sites rollback planned candidate");
  const previous = exactObject(source.previous, [
    "versionId",
    "versionNumber",
    "commitSha",
    "archiveSha256",
    "deploymentId",
    "deploymentStatus",
  ], "Sites rollback previous saved version");
  return {
    schemaVersion: CAPTURE_SOURCE_SCHEMA_V1,
    controlPlaneObservedAt: strictTimestamp(
      source.controlPlaneObservedAt,
      "Sites rollback controlPlaneObservedAt",
    ),
    projectId: source.projectId as string,
    productionUrl: source.productionUrl as string,
    plannedCandidate: {
      commitSha: plannedCandidate.commitSha as string,
      buildVersion: plannedCandidate.buildVersion as string,
    },
    previous: {
      versionId: previous.versionId as string,
      versionNumber: previous.versionNumber as number,
      commitSha: previous.commitSha as string,
      archiveSha256: previous.archiveSha256 as string,
      deploymentId: previous.deploymentId as string,
      deploymentStatus: previous.deploymentStatus as "ready" | "succeeded",
    },
  };
}

export async function captureSitesProductionRollbackTarget(input: {
  source: unknown;
  fetchImpl?: RollbackFetch;
  clock?: Clock;
  nonceFactory?: NonceFactory;
}): Promise<SitesProductionRollbackTargetV1> {
  const source = validateSitesRollbackCaptureSourceV1(input.source);
  const fetchImpl = input.fetchImpl ?? (globalThis.fetch as RollbackFetch);
  const clock = input.clock ?? (() => new Date().toISOString());
  const nonceFactory = input.nonceFactory ?? randomUUID;
  const live = await fetchBuildIdentity({
    origin: source.productionUrl,
    parameter: "__genio_rollback_capture",
    nonce: nonceFactory(),
    fetchImpl,
  });
  const capturedAt = strictTimestamp(clock(), "Sites rollback capture time");
  return createSitesProductionRollbackTargetV1({
    capturedAt,
    projectId: source.projectId,
    productionUrl: source.productionUrl,
    plannedCandidate: source.plannedCandidate,
    previous: {
      ...source.previous,
      controlPlaneObservedAt: source.controlPlaneObservedAt,
      liveObservedAt: capturedAt,
      liveBuildVersion: live.buildVersion,
      liveBuildRevision: live.buildRevision,
    },
  });
}

export function validateSitesRollbackDeploymentResultV1(
  value: unknown,
): SitesRollbackDeploymentResultV1 {
  const source = exactObject(value, [
    "schemaVersion",
    "projectId",
    "productionUrl",
    "candidate",
    "rollback",
    "pollObservations",
  ], "Sites rollback deployment result");
  if (source.schemaVersion !== DEPLOYMENT_RESULT_SCHEMA_V1) {
    throw new Error("Sites rollback deployment result uses an unsupported schema");
  }
  if (!Array.isArray(source.pollObservations)) {
    throw new Error("Sites rollback deployment result polls are invalid");
  }
  return {
    schemaVersion: DEPLOYMENT_RESULT_SCHEMA_V1,
    projectId: source.projectId as string,
    productionUrl: source.productionUrl as string,
    candidate: source.candidate as SitesProductionRollbackReceiptV1["candidate"],
    rollback: source.rollback as SitesProductionRollbackReceiptV1["rollback"],
    pollObservations:
      source.pollObservations as SitesProductionRollbackReceiptV1["pollObservations"],
  };
}

export async function produceSitesProductionRollbackReceipt(input: {
  target: unknown;
  deploymentResult: unknown;
  fetchImpl?: RollbackFetch;
  clock?: Clock;
  nonceFactory?: NonceFactory;
}): Promise<SitesProductionRollbackReceiptV1> {
  const target = validateSitesProductionRollbackTargetV1(input.target);
  const result = validateSitesRollbackDeploymentResultV1(
    input.deploymentResult,
  );
  const fetchImpl = input.fetchImpl ?? (globalThis.fetch as RollbackFetch);
  const clock = input.clock ?? (() => new Date().toISOString());
  const nonceFactory = input.nonceFactory ?? randomUUID;
  const liveObservations: SitesProductionRollbackReceiptV1["liveObservations"] =
    [];
  for (let index = 0; index < 2; index += 1) {
    const nonce = nonceFactory();
    const live = await fetchBuildIdentity({
      origin: result.productionUrl,
      parameter: SITES_PRODUCTION_ROLLBACK_PROBE_PARAMETER,
      nonce,
      fetchImpl,
    });
    liveObservations.push({
      observedAt: strictTimestamp(clock(), "Sites rollback live probe time"),
      requestUrl: live.requestUrl,
      cacheBustNonce: nonce,
      cacheMode: "no-store",
      responseStatus: 200,
      buildVersion: live.buildVersion,
      buildRevision: live.buildRevision,
    });
  }
  const generatedAt = strictTimestamp(
    clock(),
    "Sites rollback receipt generation time",
  );
  return createSitesProductionRollbackReceiptV1({
    generatedAt,
    expiresAt: new Date(
      Date.parse(generatedAt) + RELEASE_EVIDENCE_TTL_MS,
    ).toISOString(),
    target,
    projectId: result.projectId,
    productionUrl: result.productionUrl,
    candidate: result.candidate,
    rollback: result.rollback,
    pollObservations: result.pollObservations,
    liveObservations,
  });
}

type ParsedOptions = Map<string, string | true>;

function options(
  argv: readonly string[],
  approvedValues: ReadonlySet<string>,
  approvedFlags: ReadonlySet<string>,
): ParsedOptions {
  const result = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]!;
    if (!approvedValues.has(name) && !approvedFlags.has(name)) {
      throw new Error(`unsupported Sites rollback option ${name}`);
    }
    if (result.has(name)) throw new Error(`duplicate Sites rollback option ${name}`);
    if (approvedFlags.has(name)) {
      result.set(name, true);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Sites rollback option ${name} requires a value`);
    }
    result.set(name, value);
    index += 1;
  }
  return result;
}

function required(result: ParsedOptions, name: string): string {
  const value = result.get(name);
  if (typeof value !== "string" || !value) {
    throw new Error(`Sites rollback option ${name} is required`);
  }
  return value;
}

function requireFlag(result: ParsedOptions, name: string): void {
  if (result.get(name) !== true) {
    throw new Error(`Sites rollback confirmation ${name} is required`);
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

export async function runSitesProductionRollbackCli(
  argv: readonly string[],
): Promise<void> {
  const [command, ...rest] = argv;
  if (command === "capture") {
    const parsed = options(
      rest,
      new Set(["--source", "--output"]),
      new Set([CAPTURE_CONFIRMATION]),
    );
    requireFlag(parsed, CAPTURE_CONFIRMATION);
    const target = await captureSitesProductionRollbackTarget({
      source: await readJson(required(parsed, "--source"), "Sites capture source"),
    });
    await writeJson(required(parsed, "--output"), target);
    return;
  }
  if (command === "produce") {
    const parsed = options(
      rest,
      new Set(["--target", "--deployment-result", "--output"]),
      new Set([PRODUCE_CONFIRMATION]),
    );
    requireFlag(parsed, PRODUCE_CONFIRMATION);
    const receipt = await produceSitesProductionRollbackReceipt({
      target: await readJson(required(parsed, "--target"), "Sites rollback target"),
      deploymentResult: await readJson(
        required(parsed, "--deployment-result"),
        "Sites rollback deployment result",
      ),
    });
    await writeJson(required(parsed, "--output"), receipt);
    return;
  }
  if (command === "verify") {
    const parsed = options(
      rest,
      new Set([
        "--target",
        "--receipt",
        "--attestation",
        "--verification-key",
        "--trust-policy",
        "--expected-project-id",
        "--expected-production-url",
        "--expected-version-id",
        "--expected-version-number",
        "--expected-deployment-id",
        "--output",
      ]),
      new Set(),
    );
    const proof = verifySitesProductionRollbackV1({
      target: await readJson(required(parsed, "--target"), "Sites rollback target"),
      receipt: await readJson(
        required(parsed, "--receipt"),
        "Sites rollback receipt",
      ),
      attestation: await readJson(
        required(parsed, "--attestation"),
        "Sites rollback attestation",
      ),
      verificationKeySource: await readJson(
        required(parsed, "--verification-key"),
        "Sites control-plane verification key",
      ),
      trustPolicy: await readJson(
        required(parsed, "--trust-policy"),
        "Sites control-plane trust policy",
      ),
      expectedProjectId: required(parsed, "--expected-project-id"),
      expectedProductionUrl: required(parsed, "--expected-production-url"),
      expectedVersionId: required(parsed, "--expected-version-id"),
      expectedVersionNumber: Number(
        required(parsed, "--expected-version-number"),
      ),
      expectedDeploymentId: required(parsed, "--expected-deployment-id"),
    });
    await writeJson(required(parsed, "--output"), proof);
    return;
  }
  throw new Error("Sites rollback command must be capture, produce, or verify");
}

async function main(): Promise<void> {
  await runSitesProductionRollbackCli(process.argv.slice(2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}

export const SITES_ROLLBACK_CAPTURE_SOURCE_SCHEMA_V1 =
  CAPTURE_SOURCE_SCHEMA_V1;
export const SITES_ROLLBACK_DEPLOYMENT_RESULT_SCHEMA_V1 =
  DEPLOYMENT_RESULT_SCHEMA_V1;
