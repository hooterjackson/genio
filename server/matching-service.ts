import type { CatalogMatchResult, EvidenceClaimInput, PlaylistBrief, TrackCandidateInput } from "../shared/types.ts";
import { lookupAppleCatalogByIsrc, searchAppleCatalog } from "./apple.ts";
import { rankCatalogMatches } from "../lib/matching.ts";

interface Candidate extends TrackCandidateInput {
  id: string;
  evidence: EvidenceClaimInput[];
  duplicateClusterKey?: string | null;
}

interface ExistingMatch {
  candidateId: string;
  status: CatalogMatchResult["status"];
  song: CatalogMatchResult["song"];
}

interface MatchingCheckpoint {
  nextIndex: number;
  storefront: string;
  complete: boolean;
  updatedAt: string;
}

export interface MatchingRepository {
  getRun(runId: string): Promise<{ brief: PlaylistBrief }>;
  updateRun(runId: string, patch: { status?: string; phase?: string; error?: string | null }): Promise<void>;
  listCandidates(runId: string): Promise<Candidate[]>;
  listMatches(runId: string): Promise<ExistingMatch[]>;
  saveMatch(runId: string, match: CatalogMatchResult): Promise<void>;
  getResearchCheckpoint(runId: string, phase: string): Promise<unknown | null>;
  saveResearchCheckpoint(runId: string, phase: string, checkpoint: unknown): Promise<void>;
}

const wait = (ms: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, ms);
});

function isEvidenceEligible(brief: PlaylistBrief, candidate: Candidate): boolean {
  const states = new Set(candidate.evidence.map((claim) => claim.state));
  if (states.has("disputed")) return false;
  return brief.mode === "curated"
    ? states.has("editorial") || states.has("verified") || states.has("corroborated")
    : states.has("verified") || states.has("corroborated");
}

function ineligibleEvidenceBasis(brief: PlaylistBrief, candidate: Candidate): string {
  const states = new Set(candidate.evidence.map((claim) => claim.state));
  if (states.has("disputed")) {
    return "Sources disagree about the asserted track relationship; visitor review is required";
  }
  if (states.has("inferred") && !states.has("verified") && !states.has("corroborated")) {
    return "Inferred evidence requires visitor approval";
  }
  if (brief.mode !== "curated" && states.has("editorial") && !states.has("verified") && !states.has("corroborated")) {
    return "Editorial evidence is eligible only for curated prompts";
  }
  return "Evidence does not meet this playlist's automatic inclusion policy";
}

export async function matchResearchRun(repository: MatchingRepository, runId: string, storefront: string, signal?: AbortSignal): Promise<void> {
  if (!/^[a-z]{2}$/i.test(storefront)) throw new Error("Apple storefront must be a two-letter code");
  const normalizedStorefront = storefront.toLowerCase();
  const run = await repository.getRun(runId);
  const checkpoint = await repository.getResearchCheckpoint(runId, "catalog_matching") as MatchingCheckpoint | null;
  if (checkpoint?.complete && checkpoint.storefront === normalizedStorefront) {
    await repository.updateRun(runId, { status: "visitor_review", phase: "exception_review", error: null });
    return;
  }
  const start = checkpoint?.storefront === normalizedStorefront ? checkpoint.nextIndex : 0;

  signal?.throwIfAborted();
  await repository.updateRun(runId, { status: "matching", phase: "catalog_matching", error: null });
  const candidates = await repository.listCandidates(runId);
  const existingMatches = await repository.listMatches(runId);
  const processedCandidateIds = new Set(candidates.slice(0, start).map((candidate) => candidate.id));
  const acceptedCatalogIds = new Set(existingMatches
    .filter((match) => processedCandidateIds.has(match.candidateId) && match.status === "accepted" && match.song?.id)
    .map((match) => match.song!.id));
  const clusterCounts = new Map<string, number>();
  for (const candidate of candidates) {
    if (candidate.duplicateClusterKey) {
      clusterCounts.set(candidate.duplicateClusterKey, (clusterCounts.get(candidate.duplicateClusterKey) ?? 0) + 1);
    }
  }
  for (let index = start; index < candidates.length; index += 1) {
    signal?.throwIfAborted();
    const candidate = candidates[index];
    let songs = candidate.isrc ? await lookupAppleCatalogByIsrc(normalizedStorefront, candidate.isrc, signal) : [];
    if (songs.length === 0) {
      songs = await searchAppleCatalog(normalizedStorefront, `${candidate.artist} ${candidate.title}`, signal);
    }
    signal?.throwIfAborted();
    let match = rankCatalogMatches(candidate.id, candidate, songs);
    const possibleDuplicate = Boolean(candidate.duplicateClusterKey && (clusterCounts.get(candidate.duplicateClusterKey) ?? 0) > 1);
    if (match.status === "accepted" && match.song && acceptedCatalogIds.has(match.song.id)) {
      match = {
        ...match,
        status: "duplicate",
        basis: `Stable Apple catalog ID ${match.song.id} was already accepted for this run`,
      };
    } else if (possibleDuplicate) {
      match = {
        ...match,
        status: "review",
        basis: `Possible duplicate cluster ${candidate.duplicateClusterKey}; metadata similarity does not prove recording identity`,
      };
    } else if (!isEvidenceEligible(run.brief, candidate)) {
      match = { ...match, status: "review", basis: ineligibleEvidenceBasis(run.brief, candidate) };
    }
    await repository.saveMatch(runId, match);
    if (match.status === "accepted" && match.song) acceptedCatalogIds.add(match.song.id);
    await repository.saveResearchCheckpoint(runId, "catalog_matching", {
      nextIndex: index + 1,
      storefront: normalizedStorefront,
      complete: index + 1 >= candidates.length,
      updatedAt: new Date().toISOString(),
    });
    if (index + 1 < candidates.length) await wait(80);
  }

  if (candidates.length === 0) {
    await repository.saveResearchCheckpoint(runId, "catalog_matching", {
      nextIndex: 0,
      storefront: normalizedStorefront,
      complete: true,
      updatedAt: new Date().toISOString(),
    });
  }
  await repository.updateRun(runId, { status: "visitor_review", phase: "exception_review" });
}

export async function processMatchingJob(repository: MatchingRepository, payload: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
  const runId = typeof payload.runId === "string" ? payload.runId : "";
  const storefront = typeof payload.storefront === "string" ? payload.storefront : process.env.APPLE_STOREFRONT ?? "br";
  if (!runId) throw new Error("Matching job payload is invalid");
  await matchResearchRun(repository, runId, storefront, signal);
}
