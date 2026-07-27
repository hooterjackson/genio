import { readFileSync } from "node:fs";
import packageMetadata from "../package.json" with { type: "json" };

export interface BuildInformation {
  identifier: string;
  version: string;
  revision: string | null;
}

function safeVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/u.test(normalized) ? normalized : null;
}

function safeRevision(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return /^[0-9a-f]{7,64}$/u.test(normalized) ? normalized : null;
}

function embeddedBuildInformation(): {
  version: string;
  revision: string | null;
} | null {
  let source: string;
  try {
    source = readFileSync(
      new URL("../.genio-build.json", import.meta.url),
      "utf8",
    );
  } catch (error) {
    if (
      error
      && typeof error === "object"
      && "code" in error
      && error.code === "ENOENT"
    ) return null;
    throw error;
  }
  const value = JSON.parse(source) as Record<string, unknown>;
  if (value.schemaVersion !== "genio-embedded-build/v1") {
    throw new Error("Embedded build identity uses an unsupported schema");
  }
  const version = safeVersion(value.version);
  const revision = safeRevision(value.revision);
  if (!version || (value.revision !== null && !revision)) {
    throw new Error("Embedded build identity is invalid");
  }
  return { version, revision };
}

export function buildInformation(env: NodeJS.ProcessEnv = process.env): BuildInformation {
  // A container image carries a build-time identity file. Its presence is
  // authoritative even when the revision is null, so a platform environment
  // variable cannot make an unversioned or mismatched image claim another SHA.
  const embedded = embeddedBuildInformation();
  if (embedded) {
    return {
      identifier: embedded.revision
        ? `${embedded.version}+${embedded.revision.slice(0, 12)}`
        : embedded.version,
      ...embedded,
    };
  }
  const version = safeVersion(env.APP_VERSION)
    ?? safeVersion(env.npm_package_version)
    ?? safeVersion(packageMetadata.version)
    ?? "unknown";
  const revision = [
    env.SOURCE_COMMIT_SHA,
    env.RAILWAY_GIT_COMMIT_SHA,
    env.GITHUB_SHA,
    env.COMMIT_SHA,
  ].map(safeRevision).find((value): value is string => Boolean(value)) ?? null;
  return {
    identifier: revision ? `${version}+${revision.slice(0, 12)}` : version,
    version,
    revision,
  };
}
