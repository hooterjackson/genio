import type { EvidenceClaimInput, SourceRecordInput } from "../shared/types.ts";

export const UNCLASSIFIED_PROVENANCE_ROOT = "unclassified";

type EvidenceSource = Pick<SourceRecordInput, "url" | "sourceClass" | "provenanceRoot">;

const HOST_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "api.discogs.com": "discogs.com",
  "m.discogs.com": "discogs.com",
  "beta.musicbrainz.org": "musicbrainz.org",
  "api.music.apple.com": "music.apple.com",
});

function canonicalHost(host: string): string {
  const normalized = host.trim().toLowerCase().replace(/^www\./u, "").replace(/\.$/u, "");
  return HOST_ALIASES[normalized] ?? normalized;
}

function hostnameFromToken(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  try {
    return canonicalHost(new URL(normalized.includes("://") ? normalized : `https://${normalized}`).hostname);
  } catch {
    return null;
  }
}

function lineageToken(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === UNCLASSIFIED_PROVENANCE_ROOT || normalized === "unknown") {
    return `lineage:${UNCLASSIFIED_PROVENANCE_ROOT}`;
  }
  const host = hostnameFromToken(normalized);
  if (host && !host.includes(" ")) return `host:${host}`;
  return `lineage:${normalized.replace(/\s+/gu, " ")}`;
}

function sourceHostToken(urlValue: string): string {
  try {
    return `host:${canonicalHost(new URL(urlValue).hostname)}`;
  } catch {
    return `source:${urlValue.trim().toLowerCase()}`;
  }
}

class DisjointSet {
  private readonly parent = new Map<string, string>();

  private root(value: string): string {
    const parent = this.parent.get(value);
    if (!parent) {
      this.parent.set(value, value);
      return value;
    }
    if (parent === value) return value;
    const root = this.root(parent);
    this.parent.set(value, root);
    return root;
  }

  union(left: string, right: string): void {
    const leftRoot = this.root(left);
    const rightRoot = this.root(right);
    if (leftRoot === rightRoot) return;
    // Choosing the same representative regardless of insertion order makes
    // lineage keys deterministic for reports and tests.
    const [first, second] = [leftRoot, rightRoot].sort();
    this.parent.set(second!, first!);
  }

  key(value: string): string {
    return this.root(value);
  }
}

/**
 * Derive the only generic-web lineage the server is willing to attest.
 *
 * A publisher hostname is not proof of an independent origin: a page can be a
 * mirror of another database. For generic web results, the model must point to
 * a distinct origin hostname that was itself returned by hosted search in the
 * same pass. Otherwise all such sources collapse into one unclassified root.
 * Structured adapters retain their server-owned provider family.
 */
export function deriveAttestedProvenanceRoot(
  sourceUrl: string,
  sourceClass: SourceRecordInput["sourceClass"],
  claimedRoot: unknown,
  knownUrls: ReadonlySet<string>,
): string {
  const sourceHost = canonicalHost(new URL(sourceUrl).hostname);
  if (sourceClass !== "web") return sourceHost;

  const claimedHost = typeof claimedRoot === "string" ? hostnameFromToken(claimedRoot) : null;
  if (!claimedHost || claimedHost === sourceHost) return UNCLASSIFIED_PROVENANCE_ROOT;
  const knownHosts = new Set([...knownUrls].map((urlValue) => {
    try { return canonicalHost(new URL(urlValue).hostname); } catch { return null; }
  }).filter((host): host is string => Boolean(host)));
  return knownHosts.has(claimedHost) ? claimedHost : UNCLASSIFIED_PROVENANCE_ROOT;
}

/**
 * Return a lineage component for every source URL. Unioning the serving host
 * with the asserted origin collapses mirrors that share one database and also
 * collapses circular chains such as A -> B and B -> A.
 */
export function provenanceLineageKeys(sources: readonly EvidenceSource[]): Map<string, string> {
  const lineages = new DisjointSet();
  for (const source of sources) {
    const servingHost = sourceHostToken(source.url);
    const claimedLineage = lineageToken(source.provenanceRoot);
    // Backward-compatible protection for records created before attested
    // lineage validation: a generic web page whose root merely repeats its
    // serving hostname has not demonstrated an independent origin.
    const origin = source.sourceClass === "web" && claimedLineage === servingHost
      ? lineageToken(UNCLASSIFIED_PROVENANCE_ROOT)
      : claimedLineage;
    lineages.union(servingHost, origin);
  }
  return new Map(sources.map((source) => [source.url, lineages.key(sourceHostToken(source.url))]));
}

export interface EvidenceIntegrityResolution {
  evidence: EvidenceClaimInput[];
  independentSupportingLineages: number;
  hasDisagreement: boolean;
}

/**
 * Apply the automatic-inclusion invariants to one recording candidate.
 * Corroboration needs two independent lineage components. A track-level
 * dispute makes all otherwise eligible positive assertions inferred so the
 * candidate stays visible for review but can never be silently auto-accepted.
 */
export function resolveEvidenceIntegrity(
  evidence: readonly EvidenceClaimInput[],
  sources: readonly EvidenceSource[],
): EvidenceIntegrityResolution {
  const lineageByUrl = provenanceLineageKeys(sources);
  const supportingLineages = new Set(evidence
    .filter((claim) => (claim.state === "verified" || claim.state === "corroborated") && claim.supportScope === "track")
    .map((claim) => lineageByUrl.get(claim.sourceUrl))
    .filter((lineage): lineage is string => Boolean(lineage)));
  const hasDisputedClaim = evidence.some((claim) => claim.state === "disputed" && claim.supportScope === "track");
  const hasEligiblePositiveClaim = evidence.some((claim) => (
    claim.state === "verified" || claim.state === "corroborated" || claim.state === "editorial"
  ));
  const hasDisagreement = hasDisputedClaim && hasEligiblePositiveClaim;

  return {
    evidence: evidence.map((claim) => {
      if (hasDisagreement && (claim.state === "verified" || claim.state === "corroborated" || claim.state === "editorial")) {
        return { ...claim, state: "inferred" };
      }
      if (claim.state === "corroborated" && supportingLineages.size < 2) {
        return { ...claim, state: "inferred" };
      }
      return { ...claim };
    }),
    independentSupportingLineages: supportingLineages.size,
    hasDisagreement,
  };
}
