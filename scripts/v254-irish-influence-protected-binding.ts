const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export const V254_IRISH_INFLUENCE_PROTECTED_BINDING_ENV =
  "V254_IRISH_INFLUENCE_INCIDENT_BINDING_BASE64";

export interface V254IrishInfluenceProtectedBindingV1 {
  schemaVersion: "genio-v254-irish-influence-protected-binding/v1";
  accessId: string;
  runId: string;
  briefRequestId: string;
  contractRevisionId: string;
  queryPlanRevisionId: string;
  executionAttemptId: string;
  blockerId: string;
  sourceJobId: string;
}

const BINDING_KEYS = Object.freeze([
  "accessId",
  "blockerId",
  "briefRequestId",
  "contractRevisionId",
  "executionAttemptId",
  "queryPlanRevisionId",
  "runId",
  "schemaVersion",
  "sourceJobId",
] as const);

export const V254_IRISH_INFLUENCE_SYNTHETIC_BINDING =
  Object.freeze<V254IrishInfluenceProtectedBindingV1>({
    schemaVersion: "genio-v254-irish-influence-protected-binding/v1",
    accessId: "11111111-1111-4111-8111-111111111111",
    runId: "22222222-2222-4222-8222-222222222222",
    briefRequestId: "33333333-3333-4333-8333-333333333333",
    contractRevisionId: "44444444-4444-4444-8444-444444444444",
    queryPlanRevisionId: "55555555-5555-4555-8555-555555555555",
    executionAttemptId: "66666666-6666-4666-8666-666666666666",
    blockerId: "77777777-7777-4777-8777-777777777777",
    sourceJobId: "88888888-8888-4888-8888-888888888888",
  });

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("v254_irish_influence_protected_binding_invalid");
  }
  return value as Record<string, unknown>;
}

export function parseV254IrishInfluenceProtectedBindingV1(
  value: unknown,
): V254IrishInfluenceProtectedBindingV1 {
  const binding = record(value);
  if (
    JSON.stringify(Object.keys(binding).sort()) !== JSON.stringify(BINDING_KEYS)
    || binding.schemaVersion
      !== "genio-v254-irish-influence-protected-binding/v1"
  ) {
    throw new Error("v254_irish_influence_protected_binding_invalid");
  }
  for (const key of BINDING_KEYS) {
    if (key === "schemaVersion") continue;
    if (typeof binding[key] !== "string" || !UUID.test(binding[key])) {
      throw new Error("v254_irish_influence_protected_binding_invalid");
    }
  }
  return Object.freeze({
    schemaVersion: binding.schemaVersion,
    accessId: binding.accessId as string,
    runId: binding.runId as string,
    briefRequestId: binding.briefRequestId as string,
    contractRevisionId: binding.contractRevisionId as string,
    queryPlanRevisionId: binding.queryPlanRevisionId as string,
    executionAttemptId: binding.executionAttemptId as string,
    blockerId: binding.blockerId as string,
    sourceJobId: binding.sourceJobId as string,
  });
}

export function decodeV254IrishInfluenceProtectedBindingV1(
  encoded: string,
): V254IrishInfluenceProtectedBindingV1 {
  const normalized = encoded.trim();
  if (
    normalized.length < 16
    || normalized.length > 8_192
    || !/^[0-9A-Za-z+/]+={0,2}$/u.test(normalized)
    || normalized.length % 4 !== 0
  ) {
    throw new Error("v254_irish_influence_protected_binding_invalid");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(normalized, "base64").toString("utf8"));
  } catch {
    throw new Error("v254_irish_influence_protected_binding_invalid");
  }
  return parseV254IrishInfluenceProtectedBindingV1(decoded);
}

const protectedBindingValue =
  process.env[V254_IRISH_INFLUENCE_PROTECTED_BINDING_ENV]?.trim() ?? "";

export const V254_IRISH_INFLUENCE_INCIDENT_BINDING =
  protectedBindingValue
    ? decodeV254IrishInfluenceProtectedBindingV1(protectedBindingValue)
    : V254_IRISH_INFLUENCE_SYNTHETIC_BINDING;

export function requireV254IrishInfluenceProtectedBinding(): void {
  if (!protectedBindingValue) {
    throw new Error("v254_irish_influence_protected_binding_missing");
  }
}
