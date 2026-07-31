import { describe, expect, test } from "vitest";
import {
  assertAttemptOutputDeterministicV1,
  assertPartialPublicationConsentBindingV1,
  buildSelectionQualificationAttestationV1,
  buildSelectionSetAttestationV1,
  canonicalTrackIdentityHashV1,
  canonicalTrackIdentityTuplesEqualV1,
  normalizeCanonicalTrackIdentityTupleV1,
  proofArchitectureMode,
  schema20ManifestPayloadHashV1,
} from "../server/schema20-proof-architecture.ts";

const H1 = "1".repeat(64);
const H2 = "2".repeat(64);
const H3 = "3".repeat(64);
const H4 = "4".repeat(64);
const H5 = "5".repeat(64);
const H6 = "6".repeat(64);

function identity(appleStableId = "1440891293") {
  return normalizeCanonicalTrackIdentityTupleV1({
    storefront: "US",
    recordingFamilyKey: "isrc:GBBKS1400001",
    recordingFamilyPolicyVersion: "recording_family_v2",
    appleStableId,
  });
}

function qualification(candidateId: string, identityHash: string) {
  return buildSelectionQualificationAttestationV1({
    runId: "00000000-0000-4000-8000-000000000001",
    contractRevisionId: "00000000-0000-4000-8000-000000000002",
    queryPlanRevisionId: "00000000-0000-4000-8000-000000000003",
    executionAttemptId: "00000000-0000-4000-8000-000000000004",
    candidateId,
    canonicalTrackIdentityHash: identityHash,
    qualificationObservationHash: H1,
    evidenceSnapshotHashes: [H3, H2],
    contractHash: H4,
    queryPlanHash: H5,
    evidencePolicyHash: H6,
    catalogPolicyHash: H1,
  });
}

describe("schema-20 proof architecture", () => {
  test("normalizes and hashes the complete catalog identity tuple", () => {
    const value = identity();
    expect(value.storefront).toBe("us");
    expect(canonicalTrackIdentityHashV1(value)).toMatch(/^[0-9a-f]{64}$/u);
    expect(canonicalTrackIdentityTuplesEqualV1(value, {
      ...value,
    })).toBe(true);
    expect(canonicalTrackIdentityTuplesEqualV1(value, identity("other"))).toBe(
      false,
    );
  });

  test("binds qualification proof to exact identity, policies, and evidence", () => {
    const identityHash = canonicalTrackIdentityHashV1(identity());
    const first = qualification(
      "00000000-0000-4000-8000-000000000010",
      identityHash,
    );
    const reordered = buildSelectionQualificationAttestationV1({
      ...first,
      evidenceSnapshotHashes: [H2, H3],
    });
    expect(reordered.qualificationHash).toBe(first.qualificationHash);
    expect(first.evidenceSnapshotHashes).toEqual([H2, H3]);
    expect(qualification(
      "00000000-0000-4000-8000-000000000011",
      identityHash,
    ).qualificationHash).not.toBe(first.qualificationHash);
  });

  test("builds exact selected and reserve attestations with count integrity", () => {
    const firstIdentity = canonicalTrackIdentityHashV1(identity("1"));
    const secondIdentity = canonicalTrackIdentityHashV1(identity("2"));
    const reserveIdentity = canonicalTrackIdentityHashV1(identity("3"));
    const first = qualification(
      "00000000-0000-4000-8000-000000000010",
      firstIdentity,
    );
    const second = qualification(
      "00000000-0000-4000-8000-000000000011",
      secondIdentity,
    );
    const reserve = qualification(
      "00000000-0000-4000-8000-000000000012",
      reserveIdentity,
    );
    const set = buildSelectionSetAttestationV1({
      runId: first.runId,
      contractRevisionId: first.contractRevisionId,
      queryPlanRevisionId: first.queryPlanRevisionId,
      executionAttemptId: first.executionAttemptId,
      requestedCount: 2,
      items: [
        {
          role: "reserve",
          position: 0,
          selectionQualificationHash: reserve.qualificationHash,
          canonicalTrackIdentityHash: reserveIdentity,
          appleStableId: "3",
        },
        {
          role: "selected",
          position: 1,
          selectionQualificationHash: second.qualificationHash,
          canonicalTrackIdentityHash: secondIdentity,
          appleStableId: "2",
        },
        {
          role: "selected",
          position: 0,
          selectionQualificationHash: first.qualificationHash,
          canonicalTrackIdentityHash: firstIdentity,
          appleStableId: "1",
        },
      ],
    });
    expect(set.selectedCount).toBe(2);
    expect(set.reserveCount).toBe(1);
    expect(set.items.map(({ role, position }) => `${role}:${position}`)).toEqual(
      ["selected:0", "selected:1", "reserve:0"],
    );
    expect(set.attestationSetHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(set.outputHash).toMatch(/^[0-9a-f]{64}$/u);

    expect(() => buildSelectionSetAttestationV1({
      runId: first.runId,
      contractRevisionId: first.contractRevisionId,
      queryPlanRevisionId: first.queryPlanRevisionId,
      executionAttemptId: first.executionAttemptId,
      requestedCount: 3,
      items: set.items,
    })).toThrow("schema20_partial_consent_required");
    const pendingPartial = buildSelectionSetAttestationV1({
      runId: first.runId,
      contractRevisionId: first.contractRevisionId,
      queryPlanRevisionId: first.queryPlanRevisionId,
      executionAttemptId: first.executionAttemptId,
      requestedCount: 3,
      items: set.items,
      allowPendingPartial: true,
    });
    expect(pendingPartial.selectedCount).toBe(2);
    expect(() => buildSelectionSetAttestationV1({
      runId: first.runId,
      contractRevisionId: first.contractRevisionId,
      queryPlanRevisionId: first.queryPlanRevisionId,
      executionAttemptId: first.executionAttemptId,
      requestedCount: 2,
      items: [...set.items, {
        ...set.items[2]!,
        position: 1,
      }],
    })).toThrow("schema20_selection_identity_duplicate");
  });

  test("fails closed on nondeterministic output from one fenced attempt", () => {
    expect(() => assertAttemptOutputDeterministicV1({
      existingOutputHash: H1,
      existingAttestationSetHash: H2,
      proposedOutputHash: H1,
      proposedAttestationSetHash: H2,
    })).not.toThrow();
    expect(() => assertAttemptOutputDeterministicV1({
      existingOutputHash: H1,
      existingAttestationSetHash: H2,
      proposedOutputHash: H3,
      proposedAttestationSetHash: H2,
    })).toThrow("schema20_nondeterministic_attempt_output");
  });

  test("requires exact, unexpired partial-publication consent bindings", () => {
    const consent = {
      schemaVersion: "partial-publication-consent-binding/v1" as const,
      runId: "run",
      contractRevisionId: "contract",
      selectionSetHash: H1,
      manifestRevisionId: "manifest-revision",
      manifestPayloadHash: H2,
      attestationSetHash: H3,
      outcomeHash: H4,
      targetCount: 50,
      selectedCount: 42,
      expiresAt: "2030-01-01T00:00:00.000Z",
    };
    expect(() => assertPartialPublicationConsentBindingV1(consent, {
      runId: "run",
      contractRevisionId: "contract",
      selectionSetHash: H1,
      attestationSetHash: H3,
      targetCount: 50,
      selectedCount: 42,
      manifestRevisionId: "manifest-revision",
      manifestPayloadHash: H2,
      outcomeHash: H4,
      now: new Date("2029-01-01T00:00:00.000Z"),
    })).not.toThrow();
    expect(() => assertPartialPublicationConsentBindingV1({
      ...consent,
      selectedCount: 41,
    }, {
      runId: "run",
      contractRevisionId: "contract",
      selectionSetHash: H1,
      attestationSetHash: H3,
      targetCount: 50,
      selectedCount: 42,
      now: new Date("2029-01-01T00:00:00.000Z"),
    })).toThrow("schema20_partial_consent_binding_invalid");
  });

  test("binds the manifest payload to content, proof, and exact counts", () => {
    const first = schema20ManifestPayloadHashV1({
      runId: "run",
      contractRevisionId: "contract",
      manifestRevisionId: "manifest-revision",
      manifestContentHash: H1,
      selectionSetHash: H2,
      attestationSetHash: H2,
      targetCount: 50,
      selectedCount: 42,
    });
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(schema20ManifestPayloadHashV1({
      runId: "run",
      contractRevisionId: "contract",
      manifestRevisionId: "manifest-revision",
      manifestContentHash: H1,
      selectionSetHash: H2,
      attestationSetHash: H2,
      targetCount: 50,
      selectedCount: 41,
    })).not.toBe(first);
  });

  test("only enables native proof writes through an explicit mode", () => {
    expect(proofArchitectureMode({})).toBe("off");
    expect(proofArchitectureMode({
      PIPELINE_V3_PROOF_ARCHITECTURE_MODE: "shadow",
    })).toBe("shadow");
    expect(proofArchitectureMode({
      PIPELINE_V3_PROOF_ARCHITECTURE_MODE: "native",
    })).toBe("native");
    expect(proofArchitectureMode({
      PIPELINE_V3_PROOF_ARCHITECTURE_MODE: "unexpected",
    })).toBe("off");
  });
});
