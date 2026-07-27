import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  inspectReleaseWorktree,
  readReleaseGitStatus,
} from "./check-release-git-state.mjs";

const root = resolve(import.meta.dirname, "..");
const packageMetadata = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const manifest = JSON.parse(await readFile(resolve(root, "shared/releases.json"), "utf8"));
const args = process.argv.slice(2).filter((argument) => argument !== "--");
const requireTag = args.includes("--require-tag");
const exactTagIndex = args.indexOf("--require-exact-tag");
const exactTag = exactTagIndex >= 0 ? args[exactTagIndex + 1]?.trim() : null;
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const isoDate = /^\d{4}-\d{2}-\d{2}$/u;
const errors = [];

if (exactTagIndex >= 0 && (!exactTag || exactTag.startsWith("--"))) {
  errors.push("--require-exact-tag requires vX.Y.Z-rc.N");
}
if (requireTag && exactTagIndex >= 0) {
  errors.push("--require-tag and --require-exact-tag are mutually exclusive");
}

function semverParts(value) {
  const match = semver.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? ""] : null;
}

function compareSemver(left, right) {
  const a = semverParts(left);
  const b = semverParts(right);
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  if (a[3] === b[3]) return 0;
  if (!a[3]) return 1;
  if (!b[3]) return -1;
  return String(a[3]).localeCompare(String(b[3]));
}

if (manifest.schemaVersion !== 1) errors.push("shared/releases.json must use schemaVersion 1");
if (!Array.isArray(manifest.releases) || manifest.releases.length === 0) {
  errors.push("shared/releases.json must contain at least one release");
}

const releases = Array.isArray(manifest.releases) ? manifest.releases : [];
const versions = new Set();
for (const [index, release] of releases.entries()) {
  const label = `releases[${index}]`;
  if (!release || typeof release !== "object") {
    errors.push(`${label} must be an object`);
    continue;
  }
  if (typeof release.version !== "string" || !semver.test(release.version)) {
    errors.push(`${label}.version must be valid semantic versioning`);
  } else if (versions.has(release.version)) {
    errors.push(`${label}.version duplicates ${release.version}`);
  } else {
    versions.add(release.version);
  }
  if (typeof release.releasedAt !== "string" || !isoDate.test(release.releasedAt)
    || Number.isNaN(Date.parse(`${release.releasedAt}T00:00:00.000Z`))) {
    errors.push(`${label}.releasedAt must be a valid YYYY-MM-DD date`);
  }
  if (typeof release.title !== "string" || release.title.trim().length < 3 || release.title.length > 100) {
    errors.push(`${label}.title must contain 3–100 characters`);
  }
  if (!Array.isArray(release.notes) || release.notes.length < 1 || release.notes.length > 12) {
    errors.push(`${label}.notes must contain 1–12 patch notes`);
  } else {
    const notes = new Set();
    for (const [noteIndex, note] of release.notes.entries()) {
      if (typeof note !== "string" || note.trim().length < 8 || note.length > 240) {
        errors.push(`${label}.notes[${noteIndex}] must contain 8–240 characters`);
      } else if (notes.has(note.trim())) {
        errors.push(`${label}.notes[${noteIndex}] is duplicated`);
      } else {
        notes.add(note.trim());
      }
    }
  }
  if (index > 0) {
    const previous = releases[index - 1];
    if (typeof previous?.version === "string" && typeof release.version === "string"
      && compareSemver(previous.version, release.version) <= 0) {
      errors.push("Release versions must be newest-first and strictly descending");
    }
    if (typeof previous?.releasedAt === "string" && typeof release.releasedAt === "string"
      && previous.releasedAt < release.releasedAt) {
      errors.push("Release dates must be newest-first");
    }
  }
}

const currentVersion = releases[0]?.version;
if (currentVersion !== packageMetadata.version) {
  errors.push(`package.json version ${packageMetadata.version} must match the current release ${currentVersion ?? "(missing)"}`);
}

const requiredTag = requireTag
  ? `v${packageMetadata.version}`
  : exactTag;
if (exactTag && !new RegExp(
  `^v${String(packageMetadata.version).replaceAll(".", "\\.")}-rc\\.[1-9]\\d*$`,
  "u",
).test(exactTag)) {
  errors.push(`Release-candidate tag must match v${packageMetadata.version}-rc.N`);
}

if (requiredTag && typeof packageMetadata.version === "string") {
  try {
    const worktree = inspectReleaseWorktree({
      readStatus: () => readReleaseGitStatus(root),
    });
    if (!worktree.clean) {
      errors.push(
        `Release-tag validation requires a clean worktree; found ${worktree.changedPathCount} changed path(s)`,
      );
    }
  } catch {
    errors.push("Could not verify that the release worktree is clean");
  }
  try {
    const tags = execFileSync("git", ["tag", "--points-at", "HEAD"], { cwd: root, encoding: "utf8" })
      .split("\n").map((tag) => tag.trim()).filter(Boolean);
    if (!tags.includes(requiredTag)) {
      errors.push(`Release HEAD must be tagged ${requiredTag}`);
    } else {
      const objectType = execFileSync(
        "git",
        ["cat-file", "-t", `refs/tags/${requiredTag}`],
        { cwd: root, encoding: "utf8" },
      ).trim();
      if (objectType !== "tag") {
        errors.push(`Release tag ${requiredTag} must be annotated`);
      }
    }
  } catch {
    errors.push("Could not verify the release Git tag");
  }
}

if (errors.length > 0) {
  console.error("Release metadata is invalid:\n" + errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}

console.log(`Release v${packageMetadata.version} is valid${requiredTag ? ` and tagged ${requiredTag}` : ""}.`);
