import { describe, expect, test } from "vitest";
import {
  EVIDENCE_GRAPH_PIPELINE_V3,
  EVIDENCE_GRAPH_POLICY_V3,
  EvidenceGraphLifecycleErrorV3,
  EvidenceGraphServiceV3,
  exactTrackScopeDecisionV3,
  sourceIsApprovedForReuseV3,
  type AppendObservationInputV3,
  type EvidenceGraphAssertionBundleV3,
  type EvidenceGraphAssertionV3,
  type EvidenceGraphCatalogIdentityV3,
  type EvidenceGraphObservationV3,
  type EvidenceGraphRepositoryV3,
  type EvidenceGraphSnapshotV3,
  type EvidenceGraphSourceDocumentV3,
  type EvidenceGraphUnitOfWorkV3,
  type InsertAssertionInputV3,
} from "../server/evidence-graph-service-v3.ts";

const NOW = new Date("2026-07-20T12:00:00.000Z");

function approvedSource(
  id: string,
  provenanceRoot: string,
  authority: "primary_track_credit" | "secondary_database" = "secondary_database",
): EvidenceGraphSourceDocumentV3 {
  return {
    id,
    url: `https://${id}.example/track`,
    contentHash: id.padEnd(64, "a").slice(0, 64).replace(/[^a-f0-9]/gu, "a"),
    title: `${id} source`,
    sourceClass: "editorial",
    provenanceRoot,
    accessMethod: "manual_entry",
    approvalState: "approved",
    authority,
    licenseState: "permission_recorded",
    licenseVersion: "permission-v1",
    termsVersion: "terms-v1",
    attribution: `${id} archive`,
    cachePolicy: "excerpt_only",
    retentionPolicy: "durable_public_corpus",
    freshnessPolicy: "immutable_revision",
    freshnessExpiresAt: null,
    sourceRevision: id.padEnd(64, "a").slice(0, 64).replace(/[^a-f0-9]/gu, "a"),
    approvedBy: "owner@example.com",
    approvedAt: NOW,
    takedownReason: null,
    takenDownAt: null,
    status: "active",
    retrievedAt: NOW,
    lastVerifiedAt: NOW,
    metadataJson: {},
  };
}

function graphObject(polarity: "supports" | "disputes" = "supports") {
  return {
    graph: {
      relationship: "is a disco recording",
      claimAxis: "genre",
      supportedValues: ["disco"],
      polarity,
      scope: "exact_recording",
    },
  };
}

function observationInput(
  sourceDocumentId: string,
  overrides: Partial<AppendObservationInputV3> = {},
): AppendObservationInputV3 {
  return {
    sourceDocumentId,
    subjectEntityId: "00000000-0000-4000-8000-000000000010",
    recordingId: "00000000-0000-4000-8000-000000000020",
    predicate: "genre_membership",
    objectJson: graphObject(),
    creditScope: "exact_recording",
    supportExcerpt: "The source explicitly identifies this exact track as disco.",
    confidence: 0.98,
    pipelineVersion: EVIDENCE_GRAPH_PIPELINE_V3,
    policyVersion: EVIDENCE_GRAPH_POLICY_V3,
    observedAt: NOW,
    ...overrides,
  };
}

class MemoryEvidenceGraphRepository implements EvidenceGraphRepositoryV3, EvidenceGraphUnitOfWorkV3 {
  readonly sources = new Map<string, EvidenceGraphSourceDocumentV3>();
  readonly observations = new Map<string, EvidenceGraphObservationV3>();
  readonly assertions = new Map<string, EvidenceGraphAssertionV3>();
  readonly assertionEvidence = new Map<string, Set<string>>();
  readonly catalogIdentities: EvidenceGraphCatalogIdentityV3[] = [];
  readonly snapshots = new Map<string, EvidenceGraphSnapshotV3>();
  readonly snapshotAssertions = new Map<string, string[]>();
  readonly snapshotCatalogIdentities = new Map<string, string[]>();

  async transaction<T>(callback: (unit: EvidenceGraphUnitOfWorkV3) => Promise<T>): Promise<T> {
    return callback(this);
  }

  async getSourceDocuments(ids: readonly string[]) {
    return ids.map((id) => this.sources.get(id)).filter((value): value is EvidenceGraphSourceDocumentV3 => Boolean(value));
  }

  async setSourceGovernance(input: {
    sourceDocumentId: string;
    status: string;
    policy: Parameters<EvidenceGraphUnitOfWorkV3["setSourceGovernance"]>[0]["policy"];
    lastVerifiedAt: Date;
  }) {
    const current = this.sources.get(input.sourceDocumentId);
    if (!current) throw new Error("source missing");
    const updated: EvidenceGraphSourceDocumentV3 = {
      ...current,
      status: input.status,
      approvalState: input.policy.approvalState,
      authority: input.policy.authority,
      licenseState: input.policy.licenseState,
      licenseVersion: input.policy.licenseVersion,
      termsVersion: input.policy.termsVersion,
      attribution: input.policy.attribution,
      cachePolicy: input.policy.cachePolicy,
      retentionPolicy: input.policy.retentionPolicy,
      freshnessPolicy: input.policy.freshnessPolicy,
      freshnessExpiresAt: input.policy.freshnessExpiresAt ? new Date(input.policy.freshnessExpiresAt) : null,
      approvedBy: input.policy.approvedBy,
      approvedAt: input.policy.approvedAt ? new Date(input.policy.approvedAt) : null,
      takedownReason: input.policy.takedownReason ?? null,
      takenDownAt: input.policy.takenDownAt ? new Date(input.policy.takenDownAt) : null,
      lastVerifiedAt: input.lastVerifiedAt,
    };
    this.sources.set(current.id, updated);
    return updated;
  }

  async insertObservation(input: Parameters<EvidenceGraphUnitOfWorkV3["insertObservation"]>[0]) {
    const existing = [...this.observations.values()].find(({ observationKey }) => observationKey === input.observationKey);
    if (existing) return existing;
    const observation: EvidenceGraphObservationV3 = {
      id: input.id,
      observationKey: input.observationKey,
      sourceDocumentId: input.sourceDocumentId,
      subjectEntityId: input.subjectEntityId ?? null,
      recordingId: input.recordingId ?? null,
      releaseId: input.releaseId ?? null,
      predicate: input.predicate,
      objectJson: input.objectJson,
      creditScope: input.creditScope ?? null,
      supportExcerpt: input.supportExcerpt,
      confidence: input.confidence,
      status: "quarantined",
      pipelineVersion: input.pipelineVersion,
      policyVersion: input.policyVersion,
      observedAt: input.observedAt,
    };
    this.observations.set(observation.id, observation);
    return observation;
  }

  async getObservations(ids: readonly string[]) {
    return ids.map((id) => this.observations.get(id)).filter((value): value is EvidenceGraphObservationV3 => Boolean(value));
  }

  async insertAssertion(input: InsertAssertionInputV3) {
    const existing = [...this.assertions.values()].find(({ assertionKey }) => assertionKey === input.assertionKey);
    if (existing) return existing;
    const assertion: EvidenceGraphAssertionV3 = {
      ...input,
      status: "active",
      validTo: null,
      promotedAt: input.validFrom,
      retractedAt: null,
    };
    this.assertions.set(assertion.id, assertion);
    return assertion;
  }

  async linkAssertionEvidence(assertionId: string, observationIds: readonly string[]) {
    this.assertionEvidence.set(assertionId, new Set([...(this.assertionEvidence.get(assertionId) ?? []), ...observationIds]));
  }

  async transitionObservations(
    ids: readonly string[],
    from: EvidenceGraphObservationV3["status"],
    to: EvidenceGraphObservationV3["status"],
  ) {
    for (const id of ids) {
      const row = this.observations.get(id);
      if (!row || row.status !== from) throw new Error("observation transition conflict");
      this.observations.set(id, { ...row, status: to });
    }
  }

  async getAssertion(id: string) {
    return this.assertions.get(id) ?? null;
  }

  async transitionAssertion(input: {
    assertionId: string;
    from: readonly EvidenceGraphAssertionV3["status"][];
    to: EvidenceGraphAssertionV3["status"];
    at: Date;
  }) {
    const row = this.assertions.get(input.assertionId);
    if (!row || !input.from.includes(row.status)) throw new Error("assertion transition conflict");
    this.assertions.set(row.id, {
      ...row,
      status: input.to,
      validTo: input.to === "active" ? null : input.at,
      retractedAt: input.to === "retracted" ? input.at : row.retractedAt,
    });
  }

  async listActiveAssertionBundles(): Promise<EvidenceGraphAssertionBundleV3[]> {
    return [...this.assertions.values()].filter(({ status }) => status === "active").map((assertion) => ({
      assertion,
      evidence: [...(this.assertionEvidence.get(assertion.id) ?? [])].flatMap((id) => {
        const observation = this.observations.get(id);
        const source = observation && this.sources.get(observation.sourceDocumentId);
        return observation && source ? [{ observation, source }] : [];
      }),
    }));
  }

  async listAvailableCatalogIdentities(recordingIds: readonly string[]) {
    const allowed = new Set(recordingIds);
    return this.catalogIdentities.filter(({ recordingId }) => allowed.has(recordingId));
  }

  async acquireSnapshotHashLock() {}

  async findLockedSnapshotByHash(contentHash: string) {
    return [...this.snapshots.values()].find((snapshot) => snapshot.status === "locked" && snapshot.contentHash === contentHash) ?? null;
  }

  async insertBuildingSnapshot(input: { id: string; parentSnapshotId: string | null }) {
    this.snapshots.set(input.id, {
      id: input.id,
      parentSnapshotId: input.parentSnapshotId,
      status: "building",
      contentHash: null,
      assertionCount: 0,
      catalogIdentityCount: 0,
      lockedAt: null,
    });
  }

  async addSnapshotAssertions(snapshotId: string, assertionIds: readonly string[]) {
    if (this.snapshots.get(snapshotId)?.status !== "building") throw new Error("locked membership is immutable");
    this.snapshotAssertions.set(snapshotId, [...assertionIds]);
  }

  async addSnapshotCatalogIdentities(snapshotId: string, catalogIdentityIds: readonly string[]) {
    if (this.snapshots.get(snapshotId)?.status !== "building") throw new Error("locked membership is immutable");
    this.snapshotCatalogIdentities.set(snapshotId, [...catalogIdentityIds]);
  }

  async lockSnapshot(input: {
    snapshotId: string;
    contentHash: string;
    assertionCount: number;
    catalogIdentityCount: number;
    lockedAt: Date;
  }) {
    const current = this.snapshots.get(input.snapshotId);
    if (!current || current.status !== "building") throw new Error("snapshot lock conflict");
    const locked: EvidenceGraphSnapshotV3 = {
      ...current,
      status: "locked",
      contentHash: input.contentHash,
      assertionCount: input.assertionCount,
      catalogIdentityCount: input.catalogIdentityCount,
      lockedAt: input.lockedAt,
    };
    this.snapshots.set(locked.id, locked);
    return locked;
  }
}

async function addObservation(
  service: EvidenceGraphServiceV3,
  sourceId: string,
  overrides: Partial<AppendObservationInputV3> = {},
) {
  return service.appendObservation(observationInput(sourceId, overrides));
}

describe("Pipeline V3 governed evidence graph service", () => {
  test("approves only governed HTTPS source revisions and persists the policy", async () => {
    const repository = new MemoryEvidenceGraphRepository();
    repository.sources.set("source-a", {
      ...approvedSource("source-a", "credits.example", "primary_track_credit"),
      approvalState: "pending",
      authority: "unknown",
      licenseState: "unknown",
      licenseVersion: null,
      termsVersion: null,
      attribution: null,
      retentionPolicy: "ninety_days",
      approvedBy: null,
      approvedAt: null,
      lastVerifiedAt: null,
    });
    const service = new EvidenceGraphServiceV3(repository, () => NOW);
    const source = await service.approveSourcePolicy({
      sourceDocumentId: "source-a",
      authority: "primary_track_credit",
      accessMethod: "manual_entry",
      licenseState: "permission_recorded",
      licenseVersion: "permission-v1",
      termsVersion: "terms-v1",
      attribution: "Credits Example",
      cachePolicy: "excerpt_only",
      retentionPolicy: "durable_public_corpus",
      freshnessPolicy: "immutable_revision",
      sourceRevision: repository.sources.get("source-a")!.contentHash,
      approvedBy: "owner@example.com",
    });
    expect(sourceIsApprovedForReuseV3(source)).toBe(true);
    expect(source).toMatchObject({
      approvalState: "approved",
      authority: "primary_track_credit",
      accessMethod: "manual_entry",
      termsVersion: "terms-v1",
      retentionPolicy: "durable_public_corpus",
      approvedAt: NOW,
    });
  });

  test("appends every observation to quarantine and fences historical V2 evidence", async () => {
    const repository = new MemoryEvidenceGraphRepository();
    repository.sources.set("source-a", approvedSource("source-a", "credits.example", "primary_track_credit"));
    const service = new EvidenceGraphServiceV3(repository, () => NOW);
    const historical = await addObservation(service, "source-a", {
      pipelineVersion: "catalog_first_v2",
      policyVersion: "relevance_first_2026_07_r2",
    });
    expect(historical.status).toBe("quarantined");
    await expect(service.promoteObservations({ observationIds: [historical.id], promotedBy: "reviewer" }))
      .rejects.toMatchObject({ code: "historical_pipeline_quarantine" });
    expect(repository.assertions.size).toBe(0);
  });

  test("requires exact track scope and never expands generic album or family evidence", () => {
    const input = observationInput("source-a");
    const exact: EvidenceGraphObservationV3 = {
      id: "observation-exact",
      observationKey: "exact",
      sourceDocumentId: input.sourceDocumentId,
      subjectEntityId: input.subjectEntityId ?? null,
      recordingId: input.recordingId ?? null,
      releaseId: input.releaseId ?? null,
      predicate: input.predicate,
      objectJson: input.objectJson,
      creditScope: input.creditScope ?? null,
      supportExcerpt: input.supportExcerpt,
      confidence: input.confidence,
      status: "quarantined",
      pipelineVersion: input.pipelineVersion,
      policyVersion: input.policyVersion,
      observedAt: input.observedAt ?? NOW,
    };
    expect(exactTrackScopeDecisionV3(exact)).toEqual({ eligible: true, reasonCodes: [] });
    expect(exactTrackScopeDecisionV3({ ...exact, creditScope: "release_unspecified_tracks" }))
      .toMatchObject({ eligible: false, reasonCodes: ["album_credit_track_scope_unspecified"] });
    expect(exactTrackScopeDecisionV3({ ...exact, creditScope: "recording_family" }))
      .toMatchObject({ eligible: false, reasonCodes: ["recording_family_not_exact_credit_scope"] });
  });

  test("does not treat copied sources as corroboration but promotes independent roots", async () => {
    const repository = new MemoryEvidenceGraphRepository();
    repository.sources.set("source-a", approvedSource("source-a", "shared-database.example"));
    repository.sources.set("source-copy", approvedSource("source-copy", "shared-database.example"));
    repository.sources.set("source-b", approvedSource("source-b", "independent-archive.example"));
    const service = new EvidenceGraphServiceV3(repository, () => NOW);
    const first = await addObservation(service, "source-a");
    const copied = await addObservation(service, "source-copy");
    await expect(service.promoteObservations({ observationIds: [first.id, copied.id], promotedBy: "reviewer" }))
      .rejects.toMatchObject({ code: "independent_corroboration_required" });
    const independent = await addObservation(service, "source-b");
    const assertion = await service.promoteObservations({
      observationIds: [first.id, independent.id],
      promotedBy: "reviewer",
    });
    expect(assertion.evidenceTier).toBe("corroborated");
    expect(repository.observations.get(first.id)?.status).toBe("promoted");
    expect(repository.observations.get(copied.id)?.status).toBe("quarantined");
  });

  test("records a dispute append-only and supersedes the positive assertion", async () => {
    const repository = new MemoryEvidenceGraphRepository();
    repository.sources.set("source-a", approvedSource("source-a", "credits.example", "primary_track_credit"));
    repository.sources.set("source-b", approvedSource("source-b", "correction.example", "primary_track_credit"));
    const service = new EvidenceGraphServiceV3(repository, () => NOW);
    const positiveObservation = await addObservation(service, "source-a");
    const positive = await service.promoteObservations({ observationIds: [positiveObservation.id], promotedBy: "reviewer" });
    const negativeObservation = await addObservation(service, "source-b", { objectJson: graphObject("disputes") });
    const dispute = await service.disputeAssertion({
      assertionId: positive.id,
      observationId: negativeObservation.id,
      promotedBy: "reviewer",
    });
    expect(dispute.evidenceTier).toBe("disputed");
    expect(dispute.metadataJson).toMatchObject({ disputesAssertionId: positive.id });
    expect(repository.assertions.get(positive.id)?.status).toBe("superseded");
    expect(repository.assertions.size).toBe(2);
  });

  test("allows the owner to reject a quarantined observation exactly once", async () => {
    const repository = new MemoryEvidenceGraphRepository();
    repository.sources.set("source-a", approvedSource("source-a", "credits.example", "primary_track_credit"));
    const service = new EvidenceGraphServiceV3(repository, () => NOW);
    const observation = await addObservation(service, "source-a");
    const rejected = await service.rejectObservation({
      observationId: observation.id,
      rejectedBy: "owner@example.com",
      reason: "The source excerpt does not support this normalized claim.",
    });
    expect(rejected.status).toBe("rejected");
    expect(repository.observations.get(observation.id)?.status).toBe("rejected");
    await expect(service.rejectObservation({
      observationId: observation.id,
      rejectedBy: "owner@example.com",
      reason: "Duplicate action",
    })).rejects.toMatchObject({ code: "observation_not_quarantined" });
  });

  test("retraction appends a lifecycle assertion instead of deleting evidence", async () => {
    const repository = new MemoryEvidenceGraphRepository();
    repository.sources.set("source-a", approvedSource("source-a", "credits.example", "primary_track_credit"));
    const service = new EvidenceGraphServiceV3(repository, () => NOW);
    const observation = await addObservation(service, "source-a");
    const promoted = await service.promoteObservations({ observationIds: [observation.id], promotedBy: "reviewer" });
    const lifecycle = await service.retractAssertion({
      assertionId: promoted.id,
      promotedBy: "owner",
      reason: "Source correction",
    });
    expect(repository.assertions.get(promoted.id)?.status).toBe("retracted");
    expect(lifecycle.evidenceTier).toBe("retraction");
    expect(lifecycle.objectJson).toMatchObject({ lifecycle: "retraction", targetAssertionId: promoted.id });
    expect(repository.observations.get(observation.id)).toBeTruthy();
  });

  test("locks deterministic immutable snapshots using only current eligible exact-track evidence", async () => {
    const repository = new MemoryEvidenceGraphRepository();
    repository.sources.set("source-a", approvedSource("source-a", "credits.example", "primary_track_credit"));
    const service = new EvidenceGraphServiceV3(repository, () => NOW);
    const observation = await addObservation(service, "source-a");
    const promoted = await service.promoteObservations({ observationIds: [observation.id], promotedBy: "reviewer" });
    repository.catalogIdentities.push({
      id: "00000000-0000-4000-8000-000000000030",
      recordingId: observation.recordingId!,
      provider: "apple",
      storefront: "us",
      catalogId: "apple-song-1",
      isPreferred: true,
      isAvailable: true,
      identityConfidence: 0.99,
    });
    const first = await service.createLockedSnapshot();
    const again = await service.createLockedSnapshot();
    expect(again.id).toBe(first.id);
    expect(first).toMatchObject({ status: "locked", assertionCount: 1, catalogIdentityCount: 1 });
    expect(repository.snapshotAssertions.get(first.id)).toEqual([promoted.id]);
    await expect(repository.addSnapshotAssertions(first.id, [promoted.id])).rejects.toThrow(/immutable/u);
  });

  test("source takedown retracts unsupported assertions but retains independently supported ones", async () => {
    const repository = new MemoryEvidenceGraphRepository();
    repository.sources.set("source-a", approvedSource("source-a", "archive-a.example"));
    repository.sources.set("source-b", approvedSource("source-b", "archive-b.example"));
    repository.sources.set("source-c", approvedSource("source-c", "archive-c.example"));
    const service = new EvidenceGraphServiceV3(repository, () => NOW);
    const a = await addObservation(service, "source-a");
    const b = await addObservation(service, "source-b");
    const c = await addObservation(service, "source-c");
    const retained = await service.promoteObservations({ observationIds: [a.id, b.id, c.id], promotedBy: "reviewer" });

    repository.sources.set("sole", approvedSource("sole", "sole-source.example", "primary_track_credit"));
    const soleObservation = await addObservation(service, "sole", {
      recordingId: "00000000-0000-4000-8000-000000000099",
      objectJson: {
        graph: {
          ...graphObject().graph,
          relationship: "performed percussion on",
          claimAxis: "factual_relationship",
          supportedValues: ["performed percussion"],
        },
      },
      predicate: "performed_on",
    });
    const retracted = await service.promoteObservations({ observationIds: [soleObservation.id], promotedBy: "reviewer" });

    const result = await service.takeDownSource({
      sourceDocumentId: "source-a",
      promotedBy: "owner",
      reason: "Rights holder request",
    });
    expect(result.retainedAssertionIds).toContain(retained.id);
    expect(repository.assertions.get(retained.id)?.status).toBe("active");

    const soleResult = await service.takeDownSource({
      sourceDocumentId: "sole",
      promotedBy: "owner",
      reason: "Rights holder request",
    });
    expect(soleResult.retractedAssertionIds).toContain(retracted.id);
    expect(repository.assertions.get(retracted.id)?.status).toBe("retracted");
    expect(repository.sources.get("sole")?.status).toBe("takedown");
  });
});

test("lifecycle errors retain stable machine-readable codes", () => {
  const error = new EvidenceGraphLifecycleErrorV3("source_policy_not_approved", "Source is pending");
  expect(error).toMatchObject({ name: "EvidenceGraphLifecycleErrorV3", code: "source_policy_not_approved" });
});
