export const RESPONSIVE_QA_PROJECTS = Object.freeze([
  "mobile-320",
  "mobile-390",
  "mobile-430",
  "desktop",
]);

export const LOCAL_QA_OWNER_ALLOWLIST_VERSION = "browser-qa-owner-v1";

export function qaWebServerEnvironment(environment = process.env) {
  return {
    OWNER_EMAIL: environment.OWNER_EMAIL?.trim() || "owner@example.com",
    OWNER_ALLOWLIST_VERSION:
      environment.OWNER_ALLOWLIST_VERSION?.trim()
      || LOCAL_QA_OWNER_ALLOWLIST_VERSION,
  };
}

export function normalizePlaywrightArguments(arguments_) {
  return arguments_[0] === "--" ? arguments_.slice(1) : [...arguments_];
}

export function hasExplicitPlaywrightProject(arguments_) {
  return arguments_.some((argument) => (
    argument === "--project" || argument.startsWith("--project=")
  ));
}

export function playwrightProjectRuns(arguments_) {
  const normalized = normalizePlaywrightArguments(arguments_);
  if (hasExplicitPlaywrightProject(normalized)) {
    return [{ arguments_: normalized, projectName: undefined }];
  }
  return RESPONSIVE_QA_PROJECTS.map((projectName) => ({
    arguments_: [...normalized, `--project=${projectName}`, `--output=test-results/${projectName}`],
    projectName,
  }));
}
