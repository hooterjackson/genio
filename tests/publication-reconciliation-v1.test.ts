import { describe, expect, test, vi } from "vitest";
import {
  freezeContractBoundManifestV1,
  planIdempotentPublicationV1,
  reconcilePlaylistCreationV1,
  reconcilePrepublicationV1,
  reconcilePublicationBatchesV1,
  validateContractBoundManifestV1,
  type ContractBoundManifestTrackV1,
  type ContractBoundManifestV1,
  type PrepublicationTrackRevalidationV1,
  type PublicationGateHooksV1,
  type QualifiedPublicationReserveV1,
} from "../server/publication-reconciliation-v1.ts";
import type { ExecutionFenceV1 } from "../server/execution-fence-v1.ts";

const frozenAt = "2026-07-23T12:00:00.000Z";

function track(
  position: number,
  overrides: Partial<ContractBoundManifestTrackV1> = {},
): ContractBoundManifestTrackV1 {
  return {
    position,
    candidateId: `candidate-${position + 1}`,
    appleStableId: `${(position + 1) * 101}`,
    artist: `Artist ${position + 1}`,
    title: `Track ${position + 1}`,
    recordingFamilyId: `family-${position + 1}`,
    ...overrides,
  };
}

function manifest(
  tracks: readonly ContractBoundManifestTrackV1[] = [track(0), track(1)],
): ContractBoundManifestV1 {
  return freezeContractBoundManifestV1({
    manifestId: "manifest-1",
    revisionNumber: 1,
    parentRevisionId: null,
    contractRevisionId: "contract-r2",
    contractSemanticHash: "contract-hash-2",
    storefront: "us",
    desiredCount: tracks.length,
    tracks,
    frozenAt,
  });
}

function fence(overrides: Partial<ExecutionFenceV1> = {}): ExecutionFenceV1 {
  return {
    attemptId: "attempt-2",
    activeAttemptId: "attempt-2",
    leaseGeneration: 3,
    activeLeaseGeneration: 3,
    fencingToken: "fence-3",
    activeFencingToken: "fence-3",
    contractRevisionId: "contract-r2",
    activeContractRevisionId: "contract-r2",
    contractSemanticHash: "contract-hash-2",
    activeContractSemanticHash: "contract-hash-2",
    cancelled: false,
    ...overrides,
  };
}

function validation(
  candidateId: string,
  appleStableId: string,
  overrides: Partial<PrepublicationTrackRevalidationV1> = {},
): PrepublicationTrackRevalidationV1 {
  return {
    candidateId,
    appleStableId,
    storefront: "us",
    identity: "pass",
    version: "pass",
    contentPolicy: "pass",
    storefrontAvailability: "pass",
    validatedAt: "2026-07-23T12:01:00.000Z",
    ...overrides,
  };
}

function reserve(
  overrides: Partial<QualifiedPublicationReserveV1> = {},
): QualifiedPublicationReserveV1 {
  const reserveTrack = {
    candidateId: "reserve-1",
    appleStableId: "909",
    artist: "Reserve Artist",
    title: "Reserve Track",
    recordingFamilyId: "reserve-family-1",
  };
  return {
    track: reserveTrack,
    revalidation: validation(
      reserveTrack.candidateId,
      reserveTrack.appleStableId,
    ),
    evidenceEligible: "pass",
    hardPredicates: "pass",
    qualityEligible: "pass",
    qualificationRank: 0.95,
    ...overrides,
  };
}

function passingGates(
  orderedCandidateIds = ["candidate-1", "candidate-2"],
): PublicationGateHooksV1 {
  return {
    evaluateQuotas: vi.fn(() => ({ passed: true, reasonCodes: [] })),
    evaluateCentralQuality: vi.fn(() => ({ passed: true, reasonCodes: [] })),
    sequence: vi.fn(() => ({
      passed: true,
      reasonCodes: [],
      orderedCandidateIds,
    })),
  };
}

describe("contract-bound immutable publication manifest", () => {
  test("binds exact ordered Apple IDs to the immutable contract revision", () => {
    const locked = manifest();
    expect(validateContractBoundManifestV1(locked)).toEqual({
      valid: true,
      reasonCodes: [],
    });
    expect(Object.isFrozen(locked)).toBe(true);
    expect(Object.isFrozen(locked.tracks)).toBe(true);
    expect(Object.isFrozen(locked.tracks[0])).toBe(true);

    const otherContract = freezeContractBoundManifestV1({
      ...locked,
      contractRevisionId: "contract-r3",
      contractSemanticHash: "contract-hash-3",
    });
    expect(otherContract.contentHash).toBe(locked.contentHash);
    expect(otherContract.bindingHash).not.toBe(locked.bindingHash);
    expect(otherContract.revisionId).not.toBe(locked.revisionId);
  });

  test("detects content tampering and refuses an unapproved short manifest", () => {
    const locked = manifest();
    expect(validateContractBoundManifestV1({
      ...locked,
      contentHash: "tampered",
    })).toMatchObject({
      valid: false,
      reasonCodes: expect.arrayContaining(["manifest_content_hash_conflict"]),
    });

    expect(() => freezeContractBoundManifestV1({
      manifestId: "short",
      revisionNumber: 1,
      parentRevisionId: null,
      contractRevisionId: "contract-r2",
      contractSemanticHash: "contract-hash-2",
      storefront: "us",
      desiredCount: 2,
      tracks: [track(0)],
      frozenAt,
    })).toThrow(/partial_publication_not_approved/u);
  });
});

describe("prepublication reconciliation", () => {
  test("repairs a lost track only from the qualified reserve, then reruns all gates and sequencing", () => {
    const locked = manifest();
    const gates = passingGates(["reserve-1", "candidate-1"]);
    const result = reconcilePrepublicationV1({
      manifest: locked,
      fence: fence(),
      authorization: "valid",
      revalidations: [
        validation("candidate-1", "101"),
        validation("candidate-2", "202", { storefrontAvailability: "fail" }),
      ],
      qualifiedReserve: [reserve()],
      gates,
      now: new Date("2026-07-23T12:02:00.000Z"),
    });

    expect(result).toMatchObject({
      state: "ready",
      replacements: [{
        kind: "qualified_reserve",
        position: 1,
        removedCandidateId: "candidate-2",
        replacementCandidateId: "reserve-1",
        replacementAppleStableId: "909",
      }],
      manifest: {
        revisionNumber: 2,
        parentRevisionId: locked.revisionId,
        contractRevisionId: locked.contractRevisionId,
        contractSemanticHash: locked.contractSemanticHash,
        tracks: [
          { position: 0, candidateId: "reserve-1", appleStableId: "909" },
          { position: 1, candidateId: "candidate-1", appleStableId: "101" },
        ],
      },
      publicationPlan: {
        expectedOrderedAppleStableIds: ["909", "101"],
      },
    });
    expect(gates.evaluateQuotas).toHaveBeenCalledOnce();
    expect(gates.evaluateCentralQuality).toHaveBeenCalledOnce();
    expect(gates.sequence).toHaveBeenCalledOnce();
  });

  test("never fills with unknown evidence or failed hard predicates", () => {
    const locked = manifest();
    const result = reconcilePrepublicationV1({
      manifest: locked,
      fence: fence(),
      authorization: "valid",
      revalidations: [
        validation("candidate-1", "101"),
        validation("candidate-2", "202", { version: "unknown" }),
      ],
      qualifiedReserve: [reserve({ hardPredicates: "unknown" })],
      gates: passingGates(),
    });
    expect(result).toMatchObject({
      state: "needs_decision",
      reasonCodes: expect.arrayContaining([
        "prepublish_exact_count_shortfall",
        "unavailable:candidate-2",
      ]),
      verifiedCount: 1,
      publicationCount: 2,
      desiredCount: 2,
    });
  });

  test("requires a decision when exact count is reached but central quality fails", () => {
    const locked = manifest();
    const gates = passingGates();
    gates.evaluateCentralQuality = () => ({
      passed: false,
      reasonCodes: ["central_suitability_coverage_below_80_percent"],
    });
    const result = reconcilePrepublicationV1({
      manifest: locked,
      fence: fence(),
      authorization: "valid",
      revalidations: [
        validation("candidate-1", "101"),
        validation("candidate-2", "202"),
      ],
      qualifiedReserve: [],
      gates,
    });
    expect(result).toMatchObject({
      state: "needs_decision",
      verifiedCount: 2,
      reasonCodes: [
        "central_quality_gate_failed",
        "central_suitability_coverage_below_80_percent",
      ],
    });
  });

  test("preserves the immutable manifest behind an auth blocker", () => {
    const locked = manifest();
    expect(reconcilePrepublicationV1({
      manifest: locked,
      fence: fence(),
      authorization: "expired",
      revalidations: [],
      qualifiedReserve: [],
      gates: passingGates(),
    })).toEqual({
      state: "blocked_authorization",
      blocker: {
        kind: "apple_authorization",
        nextAction: "authorize_apple",
        preservedManifestRevisionId: locked.revisionId,
      },
    });
  });

  test("discards cancellation and stale fencing, but quarantines integrity conflicts", () => {
    const locked = manifest();
    const common = {
      manifest: locked,
      authorization: "valid" as const,
      revalidations: [],
      qualifiedReserve: [],
      gates: passingGates(),
    };
    expect(reconcilePrepublicationV1({
      ...common,
      fence: fence({ cancelled: true }),
    })).toEqual({ state: "cancelled", reasonCode: "run_cancelled" });
    expect(reconcilePrepublicationV1({
      ...common,
      fence: fence({ activeFencingToken: "fence-4" }),
    })).toEqual({
      state: "stale_attempt",
      reasonCode: "fencing_token_superseded",
    });
    expect(reconcilePrepublicationV1({
      ...common,
      manifest: { ...locked, contentHash: "tampered" },
      fence: fence(),
    })).toMatchObject({
      state: "quarantined",
      reasonCodes: expect.arrayContaining(["manifest_content_hash_conflict"]),
    });
  });

  test("quarantines a sequencer that does not return an exact permutation", () => {
    const locked = manifest();
    const result = reconcilePrepublicationV1({
      manifest: locked,
      fence: fence(),
      authorization: "valid",
      revalidations: [
        validation("candidate-1", "101"),
        validation("candidate-2", "202"),
      ],
      qualifiedReserve: [],
      gates: passingGates(["candidate-1", "invented-candidate"]),
    });
    expect(result).toEqual({
      state: "quarantined",
      reasonCodes: ["sequencing_result_not_exact_permutation"],
    });
  });
});

describe("idempotent Apple publication reconciliation", () => {
  const locked = manifest([track(0), track(1), track(2)]);
  const plan = planIdempotentPublicationV1(locked, 2);

  test("uses stable marker and idempotency keys for create and append operations", () => {
    expect(plan.playlistMarker).toContain(locked.bindingHash);
    expect(plan.batches).toHaveLength(2);
    expect(plan.batches.map((batch) => batch.appleStableIds)).toEqual([
      ["101", "202"],
      ["303"],
    ]);
    expect(planIdempotentPublicationV1(locked, 2)).toEqual(plan);

    expect(reconcilePlaylistCreationV1(plan, [])).toEqual({
      state: "create_required",
      marker: plan.playlistMarker,
      idempotencyKey: plan.createPlaylistIdempotencyKey,
    });
    expect(reconcilePlaylistCreationV1(plan, ["playlist-1"])).toEqual({
      state: "reconciled",
      applePlaylistId: "playlist-1",
    });
    expect(reconcilePlaylistCreationV1(plan, ["playlist-1", "playlist-2"]))
      .toEqual({
        state: "quarantined",
        reasonCode: "multiple_playlists_for_manifest_marker",
      });
  });

  test("does not replay an uncertain pending batch before it becomes visible", () => {
    expect(reconcilePublicationBatchesV1({
      plan,
      observedOrderedAppleStableIds: [],
      acknowledgedCount: 0,
      pendingOperation: plan.batches[0],
    })).toEqual({
      state: "await_visibility",
      acknowledgedCount: 0,
      reasonCode: "pending_append_not_visible",
    });
  });

  test("reconciles a fully visible pending batch and advances to the next batch", () => {
    expect(reconcilePublicationBatchesV1({
      plan,
      observedOrderedAppleStableIds: ["101", "202"],
      acknowledgedCount: 0,
      pendingOperation: plan.batches[0],
    })).toEqual({
      state: "append_required",
      acknowledgedCount: 2,
      operation: plan.batches[1],
    });
  });

  test("repairs a partial Apple batch by appending only the exact missing suffix", () => {
    const result = reconcilePublicationBatchesV1({
      plan,
      observedOrderedAppleStableIds: ["101"],
      acknowledgedCount: 0,
      pendingOperation: plan.batches[0],
    });
    expect(result).toMatchObject({
      state: "append_required",
      acknowledgedCount: 1,
      operation: {
        batchIndex: 0,
        startIndex: 1,
        endExclusive: 2,
        appleStableIds: ["202"],
      },
    });
    expect(result.state === "append_required"
      && result.operation.idempotencyKey).not.toBe(plan.batches[0]!.idempotencyKey);
  });

  test("recognizes completion by exact ordered stable IDs", () => {
    expect(reconcilePublicationBatchesV1({
      plan,
      observedOrderedAppleStableIds: ["101", "202", "303"],
      acknowledgedCount: 2,
      pendingOperation: plan.batches[1],
    })).toEqual({
      state: "complete",
      acknowledgedCount: 3,
    });
  });

  test("quarantines order divergence instead of hiding it with a restart", () => {
    expect(reconcilePublicationBatchesV1({
      plan,
      observedOrderedAppleStableIds: ["202", "101"],
      acknowledgedCount: 0,
    })).toEqual({
      state: "quarantined",
      reasonCode: "apple_playlist_order_diverged",
    });
  });
});
