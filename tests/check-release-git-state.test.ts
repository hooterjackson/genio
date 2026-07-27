import { describe, expect, test, vi } from "vitest";
import {
  inspectReleaseWorktree,
  readReleaseGitStatus,
} from "../scripts/check-release-git-state.mjs";

describe("release worktree identity", () => {
  test("uses an injectable porcelain-status reader and reports clean state", () => {
    const readStatus = vi.fn(() => "");

    expect(inspectReleaseWorktree({ readStatus })).toEqual({
      clean: true,
      changedPathCount: 0,
    });
    expect(readStatus).toHaveBeenCalledOnce();
  });

  test("counts tracked and untracked changes without exposing their paths", () => {
    expect(inspectReleaseWorktree({
      readStatus: () => " M server/index.ts\n?? private-release-input.json\n",
    })).toEqual({
      clean: false,
      changedPathCount: 2,
    });
  });

  test("runs the deterministic Git porcelain command through an injectable exec seam", () => {
    const execFile = vi.fn(() => "?? new-file.ts\n");

    expect(readReleaseGitStatus("/workspace", { execFile })).toBe("?? new-file.ts\n");
    expect(execFile).toHaveBeenCalledWith(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { cwd: "/workspace", encoding: "utf8" },
    );
  });
});
