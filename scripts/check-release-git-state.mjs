import { execFileSync } from "node:child_process";

/**
 * @typedef {(
 *   file: string,
 *   args: string[],
 *   options: { cwd: string, encoding: "utf8" },
 * ) => string} GitStatusExec
 */

/** @type {GitStatusExec} */
const defaultGitStatusExec = (file, args, options) => (
  execFileSync(file, args, options)
);

export function readReleaseGitStatus(
  cwd,
  { execFile = defaultGitStatusExec } = {},
) {
  return execFile(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd, encoding: "utf8" },
  );
}

export function inspectReleaseWorktree(
  { readStatus } = {
    readStatus: () => "",
  },
) {
  const porcelain = String(readStatus());
  const changedPathCount = porcelain
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .length;
  return Object.freeze({
    clean: changedPathCount === 0,
    changedPathCount,
  });
}
