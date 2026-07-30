import { describe, expect, test } from "vitest";
import { canonicalContractExecutionPolicyV1 } from "../server/canonical-contract-runtime-v1.ts";
import { compilePlaylistContractRevisionV1 } from "../server/playlist-contract-v1.ts";
import {
  canonicalExecutionEvidencePolicyVersionV1,
  executionCoverageReportV1,
  revalidateExecutionCoverageReportV1,
  verificationExpressionV1,
  verificationLeavesV1,
} from "../server/verification-expression-v1.ts";

function contract() {
  return compilePlaylistContractRevisionV1({
    contractId: "boolean-verification",
    rawPrompt: "jazz or soul from 2010",
    requestedTrackCount: 25,
    locale: "en",
    storefront: "us",
    clauses: [
      {
        id: "genre:jazz",
        kind: "membership",
        scope: "track",
        hardness: "hard",
        axis: "genre",
        operator: "require",
        values: ["jazz"],
        source: { provenance: "prompt", text: "jazz" },
      },
      {
        id: "genre:soul",
        kind: "membership",
        scope: "track",
        hardness: "hard",
        axis: "genre",
        operator: "require",
        values: ["soul"],
        source: { provenance: "prompt", text: "soul" },
      },
      {
        id: "era:2010",
        kind: "catalog_version",
        scope: "track",
        hardness: "hard",
        axis: "era",
        operator: "require",
        values: ["2010"],
        source: { provenance: "prompt", text: "from 2010" },
      },
    ],
    trackPredicate: {
      op: "all",
      children: [
        {
          op: "any",
          children: [
            { op: "clause", clauseId: "genre:jazz" },
            { op: "clause", clauseId: "genre:soul" },
          ],
        },
        { op: "clause", clauseId: "era:2010" },
      ],
    },
  });
}

describe("VerificationExpressionV1", () => {
  test("binds coverage to the canonical contract evidence policy, not the legacy query-plan policy", () => {
    const queryPlan = {
      evidencePolicyVersion: "governed_evidence_v2",
      canonicalContractPolicy: {
        evidencePolicyVersion: "selection_plan_evidence_projection_v2",
      },
    };
    expect(canonicalExecutionEvidencePolicyVersionV1(queryPlan))
      .toBe("selection_plan_evidence_projection_v2");
    expect(() => canonicalExecutionEvidencePolicyVersionV1({
      ...queryPlan,
      canonicalContractPolicy: null,
    })).toThrow("execution_coverage_evidence_policy_unavailable");
  });

  test("preserves allOf/anyOf rather than flattening evidence obligations", () => {
    const expression = verificationExpressionV1(
      canonicalContractExecutionPolicyV1(contract()),
    );
    expect(expression).toMatchObject({
      op: "allOf",
      children: [
        { op: "anyOf" },
        { op: "leaf", axis: "era" },
      ],
    });
    expect(verificationLeavesV1(expression).map(({ clauseId }) => clauseId).sort())
      .toEqual(["era:2010", "genre:jazz", "genre:soul"]);
  });

  test("reports missing producer coverage instead of selecting an incapable route", () => {
    const expression = verificationExpressionV1(
      canonicalContractExecutionPolicyV1(contract()),
    );
    const report = executionCoverageReportV1({
      expression,
      stage: "worker_claim",
      routeId: "metadata-only",
      dependencyRootIds: ["musicbrainz"],
      workerCapabilityHash: "a".repeat(64),
      configurationHash: "b".repeat(64),
      ontologyVersion: "playlist_music_ontology_v2",
      evidencePolicyVersion: "governed_playlist_evidence_v1",
      producerFamilies: ["structured_music_metadata"],
    });
    expect(report.complete).toBe(false);
    expect(report.uncoveredObligationIds).toContain("verification:era:2010");
    expect(report.reportHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  test("rejects tampering and rebinds coverage to the executing stage", () => {
    const expression = verificationExpressionV1(
      canonicalContractExecutionPolicyV1(contract()),
    );
    const persisted = executionCoverageReportV1({
      expression,
      stage: "query_plan",
      routeId: "canonical-route",
      dependencyRootIds: ["apple_catalog", "musicbrainz"],
      workerCapabilityHash: "a".repeat(64),
      configurationHash: "b".repeat(64),
      ontologyVersion: "playlist_music_ontology_v2",
      evidencePolicyVersion: "governed_playlist_evidence_v1",
      producerFamilies: [
        "structured_music_metadata",
        "recording_identity",
      ],
    });
    const rebound = revalidateExecutionCoverageReportV1({
      expression,
      persisted,
      stage: "publication_revalidation",
      workerCapabilityHash: "a".repeat(64),
      configurationHash: "b".repeat(64),
      ontologyVersion: "playlist_music_ontology_v2",
      evidencePolicyVersion: "governed_playlist_evidence_v1",
    });
    expect(rebound).toMatchObject({
      stage: "publication_revalidation",
      complete: true,
    });
    expect(() => revalidateExecutionCoverageReportV1({
      expression,
      persisted: {
        ...persisted,
        coveredObligationIds: [],
      },
      stage: "worker_claim",
      workerCapabilityHash: "a".repeat(64),
      configurationHash: "b".repeat(64),
      ontologyVersion: "playlist_music_ontology_v2",
      evidencePolicyVersion: "governed_playlist_evidence_v1",
    })).toThrow("execution_coverage_report_integrity_failed");
  });
});
