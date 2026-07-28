export const DEFAULT_BRIEF_INTERPRETATION_MODEL = "gpt-5.4-mini";

/**
 * One resolver is shared by execution and public release identity. An explicit
 * malformed override must fail closed; silently reporting the fallback while
 * sending a different value to the provider would invalidate release evidence.
 */
export function resolveBriefInterpretationModel(
  environment: Record<string, string | undefined> = process.env,
): string {
  const configured = environment.OPENAI_BRIEF_MODEL?.trim() ?? "";
  if (!configured) return DEFAULT_BRIEF_INTERPRETATION_MODEL;
  if (
    !/^[0-9A-Za-z][0-9A-Za-z._:+/-]{0,159}$/u.test(configured)
    || /(?:sk-|secret|token|password)/iu.test(configured)
  ) {
    throw new Error("invalid_openai_brief_model");
  }
  return configured;
}
