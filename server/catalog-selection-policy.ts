export interface CatalogSelectionMinimumInput {
  automatic: boolean;
  initialRequestSatisfied: boolean;
  requestedMinimum: number | null;
  selectedUniqueCount: number;
}

/**
 * Manual review must resolve a catalog pool that never reached the confirmed
 * minimum before it can lock a manifest. Automatic One Command publication is
 * different: it runs only after bounded recovery/refill has ended and may lock
 * every strict unique match as an explicitly partial publication.
 */
export function selectionFallsBelowRequiredMinimum(
  input: CatalogSelectionMinimumInput,
): boolean {
  return !input.automatic
    && !input.initialRequestSatisfied
    && input.requestedMinimum !== null
    && input.selectedUniqueCount < input.requestedMinimum;
}
