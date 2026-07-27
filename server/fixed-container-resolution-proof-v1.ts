import { sha256Hex, stableStringify } from "./security.ts";

export const FIXED_CONTAINER_RESOLUTION_PROOF_SCHEMA_V1 =
  "genio-fixed-container-resolution/v1" as const;

export interface FixedContainerResolutionIdentityV1 {
  readonly kind: "album" | "playlist";
  readonly name: string;
  readonly artistName: string | null;
}

export interface FixedContainerResolutionProofV1 {
  readonly schemaVersion: typeof FIXED_CONTAINER_RESOLUTION_PROOF_SCHEMA_V1;
  readonly contractSemanticHash: string | null;
  readonly directiveHash: string;
  readonly storefront: string;
  readonly requested: FixedContainerResolutionIdentityV1;
  readonly exactMatchCardinality: number;
  readonly resolvedResourceId: string | null;
  readonly resolvedResourceKind: "album" | "playlist" | null;
  /** True only when every bounded Apple search page was consumed. */
  readonly identityResolutionComplete: boolean;
  readonly identitySearchPageCount: number;
  /** Track enumeration is a separate frontier from identity resolution. */
  readonly enumerationComplete: boolean;
  readonly enumeratedTrackCount: number;
  readonly pageCount: number;
  readonly proofHash: string;
}

type FixedContainerResolutionProofBodyV1 =
  Omit<FixedContainerResolutionProofV1, "proofHash">;

function normalizedText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

export function fixedContainerDirectiveHashV1(
  identity: FixedContainerResolutionIdentityV1,
): string {
  return sha256Hex(stableStringify({
    kind: identity.kind,
    name: normalizedText(identity.name),
    artistName: identity.artistName === null
      ? null
      : normalizedText(identity.artistName),
  }));
}

export function createFixedContainerResolutionProofV1(input: {
  contractSemanticHash?: string | null;
  storefront: string;
  requested: FixedContainerResolutionIdentityV1;
  exactMatchCardinality: number;
  resolvedResourceId: string | null;
  resolvedResourceKind: "album" | "playlist" | null;
  identityResolutionComplete: boolean;
  identitySearchPageCount: number;
  enumerationComplete: boolean;
  enumeratedTrackCount: number;
  pageCount: number;
}): FixedContainerResolutionProofV1 {
  const requested = {
    kind: input.requested.kind,
    name: normalizedText(input.requested.name),
    artistName: input.requested.artistName === null
      ? null
      : normalizedText(input.requested.artistName),
  };
  const body: FixedContainerResolutionProofBodyV1 = {
    schemaVersion: FIXED_CONTAINER_RESOLUTION_PROOF_SCHEMA_V1,
    contractSemanticHash: input.contractSemanticHash ?? null,
    directiveHash: fixedContainerDirectiveHashV1(requested),
    storefront: normalizedText(input.storefront).toLocaleLowerCase("en-US"),
    requested,
    exactMatchCardinality: input.exactMatchCardinality,
    resolvedResourceId: input.resolvedResourceId,
    resolvedResourceKind: input.resolvedResourceKind,
    identityResolutionComplete: input.identityResolutionComplete,
    identitySearchPageCount: input.identitySearchPageCount,
    enumerationComplete: input.enumerationComplete,
    enumeratedTrackCount: input.enumeratedTrackCount,
    pageCount: input.pageCount,
  };
  const proof = {
    ...body,
    proofHash: sha256Hex(stableStringify(body)),
  };
  assertFixedContainerResolutionProofV1(proof);
  return Object.freeze(proof);
}

export function assertFixedContainerResolutionProofV1(
  value: FixedContainerResolutionProofV1,
): void {
  const { proofHash, ...body } = value;
  const contractHashValid = body.contractSemanticHash === null
    || /^[a-f0-9]{64}$/u.test(body.contractSemanticHash);
  const resolvedPairValid =
    (body.resolvedResourceId === null) === (body.resolvedResourceKind === null);
  const uniqueResolutionValid = body.identityResolutionComplete
    && body.exactMatchCardinality === 1
    ? body.resolvedResourceId !== null
      && body.resolvedResourceKind === body.requested.kind
    : body.resolvedResourceId === null
      && body.resolvedResourceKind === null
      && body.enumerationComplete === false
      && body.enumeratedTrackCount === 0
      && body.pageCount === 0;
  if (body.schemaVersion !== FIXED_CONTAINER_RESOLUTION_PROOF_SCHEMA_V1
    || !contractHashValid
    || !/^[a-f0-9]{64}$/u.test(body.directiveHash)
    || body.directiveHash !== fixedContainerDirectiveHashV1(body.requested)
    || !/^[a-z]{2}$/u.test(body.storefront)
    || !["album", "playlist"].includes(body.requested.kind)
    || !normalizedText(body.requested.name)
    || (body.requested.artistName !== null
      && !normalizedText(body.requested.artistName))
    || !Number.isSafeInteger(body.exactMatchCardinality)
    || body.exactMatchCardinality < 0
    || !resolvedPairValid
    || !uniqueResolutionValid
    || typeof body.identityResolutionComplete !== "boolean"
    || !Number.isSafeInteger(body.identitySearchPageCount)
    || body.identitySearchPageCount < 1
    || (body.resolvedResourceId !== null && !normalizedText(body.resolvedResourceId))
    || !Number.isSafeInteger(body.enumeratedTrackCount)
    || body.enumeratedTrackCount < 0
    || !Number.isSafeInteger(body.pageCount)
    || body.pageCount < 0
    || (body.enumerationComplete && body.pageCount < 1)
    || proofHash !== sha256Hex(stableStringify(body))) {
    throw new Error("invalid_fixed_container_resolution_proof");
  }
}

export function fixedContainerResolutionProvesClosedSetV1(
  proof: FixedContainerResolutionProofV1 | null | undefined,
  contractSemanticHash: string,
): proof is FixedContainerResolutionProofV1 {
  if (!proof) return false;
  try {
    assertFixedContainerResolutionProofV1(proof);
  } catch {
    return false;
  }
  return proof.contractSemanticHash === contractSemanticHash
    && proof.identityResolutionComplete
    && proof.exactMatchCardinality === 1
    && proof.resolvedResourceId !== null
    && proof.resolvedResourceKind === proof.requested.kind
    && proof.enumerationComplete
    && proof.pageCount >= 1;
}
