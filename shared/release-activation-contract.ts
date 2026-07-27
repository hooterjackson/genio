export const REQUIRED_ACTIVATION_DATABASE_SCHEMA_VERSION = "18";

/**
 * Every behavior-affecting activation fence is carried by signed promotion
 * evidence and then applied literally by Railway. The aggregate capability is
 * additional evidence; it never replaces either authoritative database
 * marker.
 */
export const REQUIRED_ACTIVATION_EXECUTION_CONTROLS = Object.freeze({
  RELEASE_EXPECTED_DATABASE_CAPABILITY_VERSION: "2",
  RELEASE_EXPECTED_MANIFEST_CANARY_GUARDS_VERSION: "1",
  RELEASE_EXPECTED_CANONICAL_EXECUTION_HARDENING_VERSION: "1",
  PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION: "5",
} as const);

export type RequiredActivationExecutionControls =
  typeof REQUIRED_ACTIVATION_EXECUTION_CONTROLS;
