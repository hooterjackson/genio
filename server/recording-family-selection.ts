/**
 * Preserve the first deterministic row for each canonical recording family.
 * Alternate Apple catalog IDs are publication substitutes, not extra tracks.
 */
export function partitionUniqueRecordingFamilies<T>(
  rows: readonly T[],
  familyKey: (row: T) => string,
): { unique: T[]; duplicates: T[] } {
  const seen = new Set<string>();
  const unique: T[] = [];
  const duplicates: T[] = [];
  for (const row of rows) {
    const key = familyKey(row);
    if (seen.has(key)) duplicates.push(row);
    else {
      seen.add(key);
      unique.push(row);
    }
  }
  return { unique, duplicates };
}
