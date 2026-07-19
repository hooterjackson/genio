export const RESPONSIVE_QA_PROJECTS = Object.freeze([
  "mobile-320",
  "mobile-390",
  "mobile-430",
  "desktop",
]);

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
