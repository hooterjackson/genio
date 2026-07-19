function normalizeEvidenceRelationship(value: string): string {
  return value.normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

/**
 * Accept source-specific affirmative wording without requiring it to repeat
 * the brief verbatim. Reject evidence that explicitly says the recording is
 * merely mentioned, irrelevant, out of scope, or incorrectly classified.
 */
export function evidenceRelationshipIsMaterial(value: string): boolean {
  const normalized = normalizeEvidenceRelationship(value);
  if (!normalized) return false;

  const explicitlyNonSupporting = [
    /^(?:is\s+)?(?:merely|only|incidentally)\s+(?:mentioned|listed|referenced)(?:\s+(?:by|in)\s+(?:the\s+)?source)?$/u,
    /^(?:(?:this|the)\s+(?:artist|item|recording|release|song|track)\s+)?(?:is\s+|was\s+)?not\s+(?!only\b)/u,
    /\b(?:does|did)\s+not\s+(?:belong|fit|match|qualify|represent|satisfy|support)\b/u,
    /\b(?:doesn\s+t|didn\s+t|isn\s+t|wasn\s+t|aren\s+t|weren\s+t)\s+(?:belong|fit|match|qualify|represent|satisfy|support|part)\b/u,
    /\bnot\s+(?:a\s+)?part\s+of\b/u,
    /\b(?:excluded\s+from|incompatible\s+with|irrelevant\s+to|outside\s+(?:of\s+)?|unrelated\s+to)\b/u,
    /\b(?:falsely|incorrectly|mistakenly|wrongly)\s+(?:categorized|classified|described|identified|labeled|tagged)\b/u,
    /\b(?:contains?|mentions?|references?)\s+(?:merely\s+|only\s+)?(?:the\s+)?(?:keyword|phrase|term|word)\b/u,
    /\b(?:keyword|phrase|term|title|word)(?:\s+match)?\s+only\b/u,
  ].some((pattern) => pattern.test(normalized));

  return !explicitlyNonSupporting;
}
