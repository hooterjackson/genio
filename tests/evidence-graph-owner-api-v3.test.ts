import { describe, expect, test } from "vitest";
import {
  evidenceGraphHttpErrorV3,
  parseAppendObservationV3,
  parseBulkHideV3,
  parseOwnerCorpusListQueryV3,
  parsePromotionV3,
  parseSnapshotV3,
  parseSourcePolicyApprovalV3,
} from "../server/evidence-graph-owner-api-v3.ts";
import { EvidenceGraphLifecycleErrorV3 } from "../server/evidence-graph-service-v3.ts";
import { HttpError } from "../server/security.ts";

const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;

describe("Pipeline V3 owner corpus API validation", () => {
  test("bounds review pagination and fixes the review queue to quarantined observations", () => {
    expect(parseOwnerCorpusListQueryV3({}, "review")).toEqual({ limit: 50, offset: 0, status: "quarantined" });
    expect(parseOwnerCorpusListQueryV3({ limit: "100", offset: "4", status: "quarantined" }, "review"))
      .toEqual({ limit: 100, offset: 4, status: "quarantined" });
    expect(() => parseOwnerCorpusListQueryV3({ limit: "101" }, "review")).toThrow(HttpError);
    expect(() => parseOwnerCorpusListQueryV3({ status: "promoted" }, "review")).toThrow(/quarantined/);
    expect(() => parseOwnerCorpusListQueryV3({ search: "secret" }, "source")).toThrow(/unsupported fields/);
  });

  test("accepts only an explicit governed source policy", () => {
    expect(parseSourcePolicyApprovalV3({
      authority: "official_track_credit",
      accessMethod: "manual_entry",
      licenseState: "permission_recorded",
      licenseVersion: "permission-2026-07",
      termsVersion: "terms-2026-07",
      attribution: "Official recording credits",
      cachePolicy: "excerpt_only",
      retentionPolicy: "durable_public_corpus",
      freshnessPolicy: "immutable_revision",
      sourceRevision: "a".repeat(64),
    })).toEqual({
      authority: "official_track_credit",
      accessMethod: "manual_entry",
      licenseState: "permission_recorded",
      licenseVersion: "permission-2026-07",
      termsVersion: "terms-2026-07",
      attribution: "Official recording credits",
      cachePolicy: "excerpt_only",
      retentionPolicy: "durable_public_corpus",
      freshnessPolicy: "immutable_revision",
      sourceRevision: "a".repeat(64),
    });
    expect(() => parseSourcePolicyApprovalV3({
      authority: "official_track_credit",
      licenseState: "unknown",
      licenseVersion: "v1",
      accessMethod: "manual_entry",
      termsVersion: "terms-v1",
      attribution: "Credits",
      cachePolicy: "excerpt_only",
      retentionPolicy: "durable_public_corpus",
      freshnessPolicy: "immutable_revision",
      sourceRevision: "r1",
    })).toThrow(/License state/);
    expect(() => parseSourcePolicyApprovalV3({
      authority: "official_track_credit",
      accessMethod: "manual_entry",
      licenseState: "permission_recorded",
      licenseVersion: "v1",
      termsVersion: "terms-v1",
      attribution: "Credits",
      cachePolicy: "metadata_only",
      retentionPolicy: "durable_public_corpus",
      freshnessPolicy: "immutable_revision",
      sourceRevision: "a".repeat(64),
    })).toThrow(/Cache policy/);
  });

  test("accepts a bounded exact-recording observation and rejects hidden lifecycle fields", () => {
    const parsed = parseAppendObservationV3({
      sourceDocumentId: id("1"),
      subjectEntityId: id("2"),
      recordingId: id("3"),
      predicate: "performed_on",
      objectJson: { graph: { scope: "exact_recording", polarity: "supports" } },
      creditScope: "exact_recording",
      supportExcerpt: "The official credits name the performer on this recording.",
      confidence: 0.99,
    });
    expect(parsed.recordingId).toBe(id("3"));
    expect(parsed.confidence).toBe(0.99);
    expect(() => parseAppendObservationV3({
      ...parsed,
      pipelineVersion: "historical_v2",
    })).toThrow(/unsupported fields/);
    expect(() => parseAppendObservationV3({ ...parsed, confidence: 2 })).toThrow(/between 0 and 1/);
  });

  test("deduplicates bounded promotion IDs and validates snapshot parents", () => {
    expect(parsePromotionV3({ observationIds: [id("1"), id("1"), id("2")] }).observationIds)
      .toEqual([id("1"), id("2")]);
    expect(parseSnapshotV3({ parentSnapshotId: id("5") })).toEqual({ parentSnapshotId: id("5") });
    expect(parseSnapshotV3({})).toEqual({ parentSnapshotId: null });
  });

  test("requires an explicit bulk-hide scope", () => {
    expect(parseBulkHideV3({ scope: "all_listed" })).toEqual({ scope: "all_listed", playlistIds: [] });
    expect(parseBulkHideV3({ scope: "ids", playlistIds: [id("1"), id("1")] }))
      .toEqual({ scope: "ids", playlistIds: [id("1")] });
    expect(() => parseBulkHideV3({ scope: "all_listed", playlistIds: [id("1")] }))
      .toThrow(/not allowed/);
  });

  test("maps controlled graph lifecycle failures without exposing database errors", () => {
    try {
      evidenceGraphHttpErrorV3(new EvidenceGraphLifecycleErrorV3("source_not_found", "Source document was not found"));
      throw new Error("expected mapper to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect(error).toMatchObject({ statusCode: 404, code: "corpus_source_not_found" });
    }
    const privateFailure = new Error("database password");
    expect(() => evidenceGraphHttpErrorV3(privateFailure)).toThrow(privateFailure);
  });
});
