import type { SelectionConstraint } from "../shared/types.ts";

function constraintYearRanges(values: readonly string[]): Array<{ start: number; end: number }> {
  return values.flatMap((value): Array<{ start: number; end: number }> => {
    const decade = value.match(/\b(?:(early|mid|late)[ -]?)?((?:19|20)\d0)s\b/iu);
    if (decade) {
      const start = Number(decade[2]);
      if (decade[1]?.toLocaleLowerCase("en-US") === "early") return [{ start, end: start + 3 }];
      if (decade[1]?.toLocaleLowerCase("en-US") === "mid") return [{ start: start + 3, end: start + 6 }];
      if (decade[1]?.toLocaleLowerCase("en-US") === "late") return [{ start: start + 7, end: start + 9 }];
      return [{ start, end: start + 9 }];
    }
    const explicitRange = value.match(/\b((?:19|20)\d{2})\s*(?:-|\u2013|\u2014|to|through)\s*((?:19|20)\d{2})\b/iu);
    if (explicitRange) return [{
      start: Math.min(Number(explicitRange[1]), Number(explicitRange[2])),
      end: Math.max(Number(explicitRange[1]), Number(explicitRange[2])),
    }];
    return [...value.matchAll(/\b(?:19|20)\d{2}\b/gu)]
      .map((match) => ({ start: Number(match[0]), end: Number(match[0]) }));
  });
}

function validRecordingFamilyYears(input: {
  candidateReleaseYear: number | null;
  appleReleaseDate?: string | null;
  compatibleReleaseYears?: readonly number[] | null;
}): number[] {
  const appleReleaseYear = typeof input.appleReleaseDate === "string"
    ? Number.parseInt(input.appleReleaseDate.slice(0, 4), 10)
    : Number.NaN;
  return [...new Set([
    input.candidateReleaseYear,
    ...(Array.isArray(input.compatibleReleaseYears) ? input.compatibleReleaseYears : []),
    appleReleaseYear,
  ].filter((year): year is number => (
    typeof year === "number" && Number.isInteger(year) && year >= 1000 && year <= 2999
  )))].sort((left, right) => left - right);
}

/**
 * Return the oldest supported issue date attached to the exact compatible
 * recording family. Apple frequently exposes a modern reissue as the selected
 * song, while the same canonical recording has an older compatible identity.
 */
export function canonicalRecordingFamilyReleaseYear(input: {
  candidateReleaseYear: number | null;
  appleReleaseDate?: string | null;
  compatibleReleaseYears?: readonly number[] | null;
}): number | null {
  return validRecordingFamilyYears(input)[0] ?? null;
}

/** Evaluate a hard era against dates attached to the exact recording family. */
export function recordingFamilySatisfiesEraConstraint(
  input: {
    candidateReleaseYear: number | null;
    appleReleaseDate?: string | null;
    compatibleReleaseYears?: readonly number[] | null;
  },
  constraint: Pick<SelectionConstraint, "operator" | "values">,
): boolean {
  const releaseYears = validRecordingFamilyYears(input);
  if (releaseYears.length === 0) return false;
  const ranges = constraintYearRanges(constraint.values);
  if (ranges.length === 0) return false;
  const start = Math.min(...ranges.map((range) => range.start));
  const end = Math.max(...ranges.map((range) => range.end));
  if (constraint.operator === "before") return releaseYears.some((releaseYear) => releaseYear < start);
  if (constraint.operator === "after") return releaseYears.some((releaseYear) => releaseYear > end);
  // `between` expresses one continuous interval whose endpoints are commonly
  // persisted as two scalar values. `within` values are alternatives: a
  // request for the 1970s and 1990s must not silently admit the 1980s.
  if (constraint.operator === "between") {
    return releaseYears.some((releaseYear) => releaseYear >= start && releaseYear <= end);
  }
  return releaseYears.some((releaseYear) => (
    ranges.some((range) => releaseYear >= range.start && releaseYear <= range.end)
  ));
}
