import { describe, expect, test } from "vitest";
import {
  createHostedWebEvidenceSnapshotV3,
  evidenceBindingIsAttestedForSelectionV3,
  hostedWebEvidenceSnapshotIsValidV3,
  publicTrackScopeAttestationV3,
  type EvidenceBindingReferenceV3,
  type HostedWebEvidenceSnapshotV3,
} from "../server/pipeline-v3-retrieval.ts";

const sourceUrl = "https://www.loc.gov/item/disco-history";
const excerpt =
  "Chic — Good Times is a disco recording documented by the archive. [source]";
const citationStartIndex = excerpt.indexOf("[source]");
const nowEpochMs = Date.now();
const acquiredAt = new Date(nowEpochMs - 60 * 60_000).toISOString();
const freshnessExpiresAt = new Date(
  Date.parse(acquiredAt) + 30 * 24 * 60 * 60_000,
).toISOString();
const predicateId = "genre:disco";

function snapshot(
  overrides: Partial<Parameters<
    typeof createHostedWebEvidenceSnapshotV3
  >[0]> = {},
): HostedWebEvidenceSnapshotV3 {
  return createHostedWebEvidenceSnapshotV3({
    sourceUrl,
    excerpt,
    responseId: "resp_123",
    outputItemId: "msg_456",
    contentIndex: 0,
    citationStartIndex,
    citationEndIndex: citationStartIndex + "[source]".length,
    excerptStartIndex: 0,
    excerptEndIndex: excerpt.length,
    acquiredAt,
    storefront: "us",
    freshnessExpiresAt,
    predicateIds: [predicateId],
    ...overrides,
  });
}

function binding(
  evidenceSnapshot = snapshot(),
): EvidenceBindingReferenceV3 {
  return {
    id: "web:binding-1",
    url: evidenceSnapshot.sourceUrl,
    provenanceRoot: "loc.gov",
    strength: 0.9,
    sourceRank: 1,
    kind: "hosted_web_track",
    predicateIds: [...evidenceSnapshot.predicateIds],
    governance: {
      policyVersion: "evidence-source-governance-v3",
      useScope: "run_local",
      approvalState: "approved",
      accessMethod: "hosted_web_search",
      licenseState: "citation_only",
      licenseVersion: "test-citation-v1",
      termsVersion: "test-terms-v1",
      attribution: "Library of Congress",
      cachePolicy: "excerpt_only",
      retentionPolicy: "ninety_days",
      freshnessPolicy: "revalidate_30d",
      freshnessExpiresAt: evidenceSnapshot.freshnessExpiresAt,
      acquiredAt: evidenceSnapshot.acquiredAt,
      revokedAt: evidenceSnapshot.revokedAt,
      sourceHash: evidenceSnapshot.snapshotHash,
      sourceRevision: evidenceSnapshot.snapshotHash,
    },
    hostedEvidenceSnapshot: evidenceSnapshot,
    eligibilityAttestation: publicTrackScopeAttestationV3(
      evidenceSnapshot.sourceUrl,
      evidenceSnapshot,
    ),
  };
}

describe("hosted-web evidence snapshot v3", () => {
  test("binds URL, exact excerpt, locator, storefront, time, and obligations", () => {
    const base = snapshot();
    expect(hostedWebEvidenceSnapshotIsValidV3(base, {
      storefront: "US",
      requiredObligationIds: [predicateId],
      nowEpochMs,
    })).toBe(true);

    const variants = [
      snapshot({ sourceUrl: `${sourceUrl}?edition=2` }),
      snapshot({ excerpt: excerpt.replace("disco", "house") }),
      snapshot({ responseId: "resp_789" }),
      snapshot({ contentIndex: 1 }),
      snapshot({
        acquiredAt: new Date(Date.parse(acquiredAt) + 1_000).toISOString(),
      }),
      snapshot({ storefront: "ca" }),
      snapshot({ predicateIds: ["genre:house"] }),
    ];
    expect(new Set([
      base.snapshotHash,
      ...variants.map(({ snapshotHash }) => snapshotHash),
    ])).toHaveLength(variants.length + 1);
    expect(base.excerptHash).not.toBe(
      variants.find(({ excerpt: value }) => value.includes("house"))
        ?.excerptHash,
    );
  });

  test("rejects tampering, expiry, revocation, and a wrong obligation", () => {
    const base = snapshot();
    expect(hostedWebEvidenceSnapshotIsValidV3({
      ...base,
      excerpt: base.excerpt.replace("disco", "house"),
    }, { nowEpochMs })).toBe(false);
    expect(hostedWebEvidenceSnapshotIsValidV3(base, {
      nowEpochMs: Date.parse(freshnessExpiresAt),
    })).toBe(false);
    expect(hostedWebEvidenceSnapshotIsValidV3(
      snapshot({ revokedAt: new Date(nowEpochMs).toISOString() }),
      { nowEpochMs },
    )).toBe(false);
    expect(hostedWebEvidenceSnapshotIsValidV3(base, {
      requiredObligationIds: ["geography:france"],
      nowEpochMs,
    })).toBe(false);
  });

  test("rejects unknown fields, oversized ids, and freshness beyond 30 days", () => {
    const base = snapshot();
    expect(hostedWebEvidenceSnapshotIsValidV3({
      ...base,
      unexpectedProviderPayload: "must not survive",
    } as HostedWebEvidenceSnapshotV3, { nowEpochMs })).toBe(false);
    expect(hostedWebEvidenceSnapshotIsValidV3({
      ...base,
      providerLocator: {
        ...base.providerLocator,
        unsafeCursor: "provider-owned-unbounded-state",
      },
    } as HostedWebEvidenceSnapshotV3, { nowEpochMs })).toBe(false);
    expect(() => snapshot({
      predicateIds: Array.from(
        { length: 33 },
        (_, index) => `genre:test-${index}`,
      ),
    })).toThrow("Hosted evidence snapshot is invalid");
    expect(() => snapshot({
      predicateIds: Array.from(
        { length: 32 },
        (_, index) => `${String(index).padStart(2, "0")}:${
          "é".repeat(237)
        }`,
      ),
      obligationIds: Array.from(
        { length: 32 },
        (_, index) => `${String(index).padStart(2, "0")}:${
          "é".repeat(237)
        }`,
      ),
    })).toThrow("Hosted evidence snapshot is invalid");
    expect(() => snapshot({
      freshnessExpiresAt: new Date(
        Date.parse(acquiredAt) + 30 * 24 * 60 * 60_000 + 1,
      ).toISOString(),
    })).toThrow("Hosted evidence snapshot is invalid");
  });

  test("requires the snapshot for new canonical hosted evidence while retaining legacy readability", () => {
    const complete = binding();
    expect(evidenceBindingIsAttestedForSelectionV3(complete, {
      requireHostedEvidenceSnapshot: true,
      storefront: "us",
      requiredObligationIds: [predicateId],
      nowEpochMs,
    })).toBe(true);

    const legacyUrlOnly: EvidenceBindingReferenceV3 = {
      ...complete,
      governance: {
        ...complete.governance,
        freshnessExpiresAt: "2099-01-01T00:00:00.000Z",
        acquiredAt: undefined,
        revokedAt: undefined,
        sourceHash: "a".repeat(64),
        sourceRevision: "a".repeat(64),
      },
      hostedEvidenceSnapshot: undefined,
      eligibilityAttestation: publicTrackScopeAttestationV3(sourceUrl),
    };
    expect(evidenceBindingIsAttestedForSelectionV3(
      legacyUrlOnly,
      { nowEpochMs },
    )).toBe(true);
    expect(evidenceBindingIsAttestedForSelectionV3(legacyUrlOnly, {
      requireHostedEvidenceSnapshot: true,
      storefront: "us",
      nowEpochMs,
    })).toBe(false);
  });

  test("retains a bounded multi-obligation source predicate set", () => {
    const multi = snapshot({
      predicateIds: [predicateId, "mood:smooth"],
      obligationIds: [predicateId, "mood:smooth"],
    });
    expect(evidenceBindingIsAttestedForSelectionV3(binding(multi), {
      requireHostedEvidenceSnapshot: true,
      storefront: "us",
      requiredObligationIds: [predicateId, "mood:smooth"],
      nowEpochMs,
    })).toBe(true);
  });

  test("fails a binding when its excerpt or source revision no longer matches", () => {
    const complete = binding();
    expect(evidenceBindingIsAttestedForSelectionV3({
      ...complete,
      hostedEvidenceSnapshot: {
        ...complete.hostedEvidenceSnapshot!,
        excerpt: complete.hostedEvidenceSnapshot!.excerpt.replace(
          "disco",
          "house",
        ),
      },
    }, {
      requireHostedEvidenceSnapshot: true,
      storefront: "us",
      nowEpochMs,
    })).toBe(false);
    expect(evidenceBindingIsAttestedForSelectionV3({
      ...complete,
      governance: {
        ...complete.governance,
        sourceRevision: "b".repeat(64),
      },
    }, {
      requireHostedEvidenceSnapshot: true,
      storefront: "us",
      nowEpochMs,
    })).toBe(false);
  });

  test("rejects unknown or unbounded eligibility wrapper data", () => {
    const complete = binding();
    const context = {
      requireHostedEvidenceSnapshot: true,
      storefront: "us",
      nowEpochMs,
    };
    const unboundedPayload = "x".repeat(1_000_000);
    const invalidBindings: EvidenceBindingReferenceV3[] = [
      ({
        ...complete,
        untrustedProviderPayload: unboundedPayload,
      } as unknown as EvidenceBindingReferenceV3),
      ({
        ...complete,
        governance: {
          ...complete.governance,
          untrustedProviderPayload: unboundedPayload,
        },
      } as unknown as EvidenceBindingReferenceV3),
      ({
        ...complete,
        eligibilityAttestation: {
          ...complete.eligibilityAttestation!,
          untrustedProviderPayload: unboundedPayload,
        },
      } as unknown as EvidenceBindingReferenceV3),
    ];

    for (const invalidBinding of invalidBindings) {
      expect(evidenceBindingIsAttestedForSelectionV3(
        invalidBinding,
        context,
      )).toBe(false);
    }
  });
});
