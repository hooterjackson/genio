export interface CanonicalContractFallbackAuthorityV1 {
  readonly owner: boolean;
  readonly signedOwnerCanary: boolean;
  readonly signedReleaseCanary: boolean;
}

/**
 * Selects the only non-assignment authority that may request Contract 3.
 *
 * Owner identity is deliberately insufficient. An owner canary must carry a
 * verified release-canary receipt so an ordinary owner request cannot silently
 * take a different execution route from public traffic. Broad historical
 * guidance flags are not execution authority: ordinary public work requires a
 * persisted signed public-rollout assignment.
 */
export function canonicalContractFallbackRequestedV1(
  authority: CanonicalContractFallbackAuthorityV1,
): boolean {
  return (authority.owner && authority.signedOwnerCanary)
    || authority.signedReleaseCanary;
}
