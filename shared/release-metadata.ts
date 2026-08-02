import releaseManifest from "./releases.json" with { type: "json" };

export type AppRelease = {
  version: string;
  status: "candidate" | "released";
  releasedAt: string | null;
  title: string;
  notes: readonly string[];
};

export const releaseHistory = releaseManifest.releases.map((release) => ({
  ...release,
  status: "status" in release && release.status === "candidate"
    ? "candidate" as const
    : "released" as const,
})) as readonly AppRelease[];

if (releaseHistory.length === 0) {
  throw new Error("The gênio release manifest must contain at least one release");
}

export const currentRelease = releaseHistory[0]!;

export function formatReleaseDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
    year: "numeric",
  }).format(new Date(`${value}T00:00:00.000Z`));
}
