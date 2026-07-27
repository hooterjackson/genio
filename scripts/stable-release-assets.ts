import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const STABLE_RELEASE_ASSET_NAMES = Object.freeze([
  "finalization-evidence.json",
  "protected-semantic-baseline.json",
  "stable-authorization.json",
  "stable-image-attestation.json",
  "stable-release-consumer.json",
] as const);

export interface StableReleaseAssetReconciliationPlan {
  schemaVersion: "genio-stable-release-asset-reconciliation/v1";
  releaseId: number;
  draft: boolean;
  missing: string[];
  replace: string[];
  verified: string[];
  expectedSha256: Record<string, string>;
  observedSha256: Record<string, string>;
}

interface GitHubReleaseAsset {
  id?: unknown;
  name?: unknown;
}

interface GitHubRelease {
  id?: unknown;
  draft?: unknown;
  assets?: unknown;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactReleaseInventory(value: unknown): {
  releaseId: number;
  draft: boolean;
  assetNames: string[];
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("GitHub Release inventory must be an object");
  }
  const release = value as GitHubRelease;
  if (!Number.isSafeInteger(release.id) || Number(release.id) <= 0) {
    throw new Error("GitHub Release inventory has no stable numeric identity");
  }
  if (typeof release.draft !== "boolean" || !Array.isArray(release.assets)) {
    throw new Error("GitHub Release inventory is missing draft or asset state");
  }
  const assetNames = release.assets.map((asset: GitHubReleaseAsset) => {
    if (!asset || typeof asset !== "object" || Array.isArray(asset)
      || typeof asset.name !== "string" || !asset.name) {
      throw new Error("GitHub Release inventory contains an invalid asset");
    }
    return asset.name;
  });
  if (new Set(assetNames).size !== assetNames.length) {
    throw new Error("GitHub Release inventory contains duplicate asset names");
  }
  const expected = new Set<string>(STABLE_RELEASE_ASSET_NAMES);
  const unexpected = assetNames.filter((name) => !expected.has(name));
  if (unexpected.length > 0) {
    throw new Error(
      `GitHub Release contains unexpected assets: ${unexpected.sort().join(", ")}`,
    );
  }
  return {
    releaseId: Number(release.id),
    draft: release.draft,
    assetNames,
  };
}

/**
 * Compare the exact local evidence bytes with the bytes downloaded from the
 * GitHub Release. Published releases are immutable and fail closed on any
 * difference. Drafts return only the missing/replacement operations needed to
 * converge, making an interrupted upload safely rerunnable.
 */
export async function planStableReleaseAssetReconciliation(input: {
  release: unknown;
  expectedDirectory: string;
  downloadedDirectory: string;
}): Promise<StableReleaseAssetReconciliationPlan> {
  const inventory = exactReleaseInventory(input.release);
  const present = new Set(inventory.assetNames);
  const missing: string[] = [];
  const replace: string[] = [];
  const verified: string[] = [];
  const expectedSha256: Record<string, string> = {};
  const observedSha256: Record<string, string> = {};

  for (const name of STABLE_RELEASE_ASSET_NAMES) {
    const expected = await readFile(`${input.expectedDirectory}/${name}`);
    expectedSha256[name] = sha256(expected);
    if (!present.has(name)) {
      missing.push(name);
      continue;
    }
    let observed: Buffer;
    try {
      observed = await readFile(`${input.downloadedDirectory}/${name}`);
    } catch {
      throw new Error(
        `GitHub Release asset ${name} was inventoried but not downloaded`,
      );
    }
    observedSha256[name] = sha256(observed);
    if (observedSha256[name] === expectedSha256[name]) verified.push(name);
    else replace.push(name);
  }

  if (!inventory.draft && (missing.length > 0 || replace.length > 0)) {
    throw new Error(
      "published stable release assets differ from the verified immutable evidence",
    );
  }
  return {
    schemaVersion: "genio-stable-release-asset-reconciliation/v1",
    releaseId: inventory.releaseId,
    draft: inventory.draft,
    missing,
    replace,
    verified,
    expectedSha256,
    observedSha256,
  };
}

function option(args: readonly string[], name: string): string {
  const matches = args.flatMap((value, index) => (
    value === name ? [index] : []
  ));
  if (matches.length !== 1) throw new Error(`${name} must be supplied once`);
  const value = args[matches[0]! + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

export async function runStableReleaseAssetPlanner(
  args: readonly string[],
): Promise<void> {
  const known = new Set([
    "--release",
    "--expected-directory",
    "--downloaded-directory",
    "--output",
  ]);
  for (let index = 0; index < args.length; index += 2) {
    if (!known.has(args[index] ?? "") || !args[index + 1]) {
      throw new Error("stable release asset planner received invalid arguments");
    }
  }
  const releasePath = option(args, "--release");
  const outputPath = option(args, "--output");
  const plan = await planStableReleaseAssetReconciliation({
    release: JSON.parse(await readFile(releasePath, "utf8")),
    expectedDirectory: option(args, "--expected-directory"),
    downloadedDirectory: option(args, "--downloaded-directory"),
  });
  await writeFile(outputPath, `${JSON.stringify(plan, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

if (process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runStableReleaseAssetPlanner(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
