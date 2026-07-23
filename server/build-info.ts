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

export function buildInformation(env: NodeJS.ProcessEnv = process.env): BuildInformation {
  const version = safeVersion(env.APP_VERSION)
    ?? safeVersion(env.npm_package_version)
    ?? safeVersion(packageMetadata.version)
    ?? "unknown";
  const revision = [
    // Immutable image promotions set SOURCE_COMMIT_SHA explicitly. Prefer it
    // over ambient platform Git metadata, which can describe the IaC checkout
    // rather than the digest-pinned application image actually running.
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
