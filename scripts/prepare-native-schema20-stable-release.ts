import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  validateNativeSchema20FinalizationReceiptV1,
  type NativeSchema20FinalizationReceiptV1,
} from "./finalize-native-schema20-release.ts";

type JsonRecord = Record<string, unknown>;

const CONFIRMATION_FLAG = "--confirm-native-stable-release";
const SHA1 = /^[0-9a-f]{40}$/u;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

export interface NativeSchema20StableReleasePlanV1 {
  schemaVersion: "genio-native-schema20-stable-release/v1";
  candidate: {
    rcTag: string;
    stableTag: string;
    version: string;
    sourceRevision: string;
    imageDigest: string;
  };
  finalizationReceiptHash: string;
  burnInReceiptHash: string;
  burnInCompletedAt: string;
  sourceMetadataStatus: "candidate";
  releaseTitle: string;
  releaseNotes: string;
  planHash: string;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as JsonRecord)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stable(item)]),
  );
}

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}

function option(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name)?.trim() ?? "";
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function parseNativeSchema20StableReleaseArgs(
  argv: readonly string[],
): {
  finalizationReceiptPath: string;
  candidateTag: string;
  sourceRevision: string;
  version: string;
  outputPath: string;
  notesOutputPath: string;
} {
  if (argv.filter((value) => value === CONFIRMATION_FLAG).length !== 1) {
    throw new Error(
      `native stable publication requires ${CONFIRMATION_FLAG}`,
    );
  }
  const names = new Set([
    "--finalization-receipt",
    "--candidate-tag",
    "--source-revision",
    "--version",
    "--output",
    "--notes-output",
  ]);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index] ?? "";
    if (name === CONFIRMATION_FLAG) continue;
    const value = argv[index + 1] ?? "";
    if (
      !names.has(name)
      || !value
      || value.startsWith("--")
      || values.has(name)
    ) {
      throw new Error(`Invalid native stable argument: ${name || "(missing)"}`);
    }
    values.set(name, value);
    index += 1;
  }
  if (values.size !== names.size) {
    throw new Error("native stable publication requires every argument");
  }
  const version = option(values, "--version");
  const sourceRevision = option(values, "--source-revision").toLowerCase();
  const candidateTag = option(values, "--candidate-tag");
  if (!VERSION.test(version)) throw new Error("--version is invalid");
  if (!SHA1.test(sourceRevision)) {
    throw new Error("--source-revision is invalid");
  }
  if (
    !new RegExp(
      `^v${version.replaceAll(".", "\\.")}-rc\\.[1-9]\\d*$`,
      "u",
    ).test(candidateTag)
  ) {
    throw new Error("--candidate-tag is invalid");
  }
  return {
    finalizationReceiptPath: option(values, "--finalization-receipt"),
    candidateTag,
    sourceRevision,
    version,
    outputPath: option(values, "--output"),
    notesOutputPath: option(values, "--notes-output"),
  };
}

export function createNativeSchema20StableReleasePlan(input: {
  finalizationReceipt: NativeSchema20FinalizationReceiptV1;
  packageVersion: string;
  currentRelease: {
    version?: unknown;
    status?: unknown;
    releasedAt?: unknown;
  };
}): NativeSchema20StableReleasePlanV1 {
  const receipt = input.finalizationReceipt;
  if (input.packageVersion !== receipt.candidate.version) {
    throw new Error("package version does not match native finalization");
  }
  if (
    input.currentRelease.version !== receipt.candidate.version
    || input.currentRelease.status !== "candidate"
    || input.currentRelease.releasedAt !== null
  ) {
    throw new Error(
      "native stable publication requires the immutable candidate metadata",
    );
  }
  const stableTag = `v${receipt.candidate.version}`;
  const releaseNotes = [
    `gênio stable release ${stableTag}`,
    "",
    `RC: ${receipt.candidate.tag}`,
    `Source-Revision: ${receipt.candidate.sourceRevision}`,
    `Image-Digest: ${receipt.candidate.imageDigest}`,
    `Native-Finalization-SHA256: ${receipt.receiptHash}`,
    `Burn-In-SHA256: ${receipt.burnInReceiptHash}`,
    `Burn-In-Completed-At: ${receipt.burnInCompletedAt}`,
    "Source-Metadata: immutable candidate; operational stable status is "
      + "established by this evidence-bound tag and Release",
    "",
  ].join("\n");
  const unsigned = {
    schemaVersion: "genio-native-schema20-stable-release/v1" as const,
    candidate: {
      rcTag: receipt.candidate.tag,
      stableTag,
      version: receipt.candidate.version,
      sourceRevision: receipt.candidate.sourceRevision,
      imageDigest: receipt.candidate.imageDigest,
    },
    finalizationReceiptHash: receipt.receiptHash,
    burnInReceiptHash: receipt.burnInReceiptHash,
    burnInCompletedAt: receipt.burnInCompletedAt,
    sourceMetadataStatus: "candidate" as const,
    releaseTitle: stableTag,
    releaseNotes,
  };
  return Object.freeze({
    ...unsigned,
    planHash: sha256(unsigned),
  });
}

async function main(): Promise<void> {
  const args = parseNativeSchema20StableReleaseArgs(process.argv.slice(2));
  const [finalizationValue, packageValue, releaseManifestValue] =
    await Promise.all([
      readFile(args.finalizationReceiptPath, "utf8").then(JSON.parse),
      readFile(new URL("../package.json", import.meta.url), "utf8")
        .then(JSON.parse),
      readFile(new URL("../shared/releases.json", import.meta.url), "utf8")
        .then(JSON.parse),
    ]);
  const finalization = validateNativeSchema20FinalizationReceiptV1(
    finalizationValue,
    {
      candidateTag: args.candidateTag,
      sourceRevision: args.sourceRevision,
      version: args.version,
    },
  );
  const packageMetadata = packageValue as JsonRecord;
  const releaseManifest = releaseManifestValue as JsonRecord;
  const currentRelease = Array.isArray(releaseManifest.releases)
    ? releaseManifest.releases[0]
    : null;
  if (
    !currentRelease
    || typeof currentRelease !== "object"
    || Array.isArray(currentRelease)
  ) {
    throw new Error("release manifest has no current release");
  }
  const plan = createNativeSchema20StableReleasePlan({
    finalizationReceipt: finalization,
    packageVersion: String(packageMetadata.version ?? ""),
    currentRelease: currentRelease as JsonRecord,
  });
  await Promise.all([
    writeFile(args.outputPath, `${JSON.stringify(plan, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    }),
    writeFile(args.notesOutputPath, plan.releaseNotes, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    }),
  ]);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    stableTag: plan.candidate.stableTag,
    sourceRevision: plan.candidate.sourceRevision,
    finalizationReceiptHash: plan.finalizationReceiptHash,
    planHash: plan.planHash,
  })}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: "native_schema20_stable_release_preparation_failed",
      message: error instanceof Error
        ? error.message
        : "Native stable release preparation failed",
    })}\n`);
    process.exitCode = 1;
  });
}
