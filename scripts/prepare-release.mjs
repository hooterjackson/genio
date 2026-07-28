import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packagePath = resolve(root, "package.json");
const manifestPath = resolve(root, "shared/releases.json");
const args = process.argv.slice(2).filter((argument) => argument !== "--");
const bump = args[0];

function option(name, repeatable = false) {
  const values = [];
  for (let index = 1; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    values.push(value.trim());
  }
  return repeatable ? values : values[0];
}

if (!new Set(["patch", "minor", "major"]).has(bump)) {
  throw new Error("Usage: pnpm release:new -- patch|minor|major --title \"…\" --note \"…\" [--note \"…\"] [--date YYYY-MM-DD]");
}

const title = option("--title");
const notes = option("--note", true);
const releasedAt = option("--date") ?? new Date().toISOString().slice(0, 10);
if (!title || title.length < 3 || title.length > 100) throw new Error("--title must contain 3–100 characters");
if (!Array.isArray(notes) || notes.length < 1 || notes.some((note) => note.length < 8 || note.length > 240)) {
  throw new Error("Provide at least one --note containing 8–240 characters");
}
if (!/^\d{4}-\d{2}-\d{2}$/u.test(releasedAt)) throw new Error("--date must use YYYY-MM-DD");

const packageMetadata = JSON.parse(await readFile(packagePath, "utf8"));
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(packageMetadata.version);
if (!match) throw new Error("package.json must contain a stable semantic version before preparing a release");
let [major, minor, patch] = match.slice(1).map(Number);
if (bump === "major") [major, minor, patch] = [major + 1, 0, 0];
if (bump === "minor") [minor, patch] = [minor + 1, 0];
if (bump === "patch") patch += 1;
const version = `${major}.${minor}.${patch}`;

packageMetadata.version = version;
manifest.releases.unshift({ version, releasedAt, title, notes });

const packageTemporary = `${packagePath}.release-tmp`;
const manifestTemporary = `${manifestPath}.release-tmp`;
await Promise.all([
  writeFile(packageTemporary, `${JSON.stringify(packageMetadata, null, 2)}\n`, "utf8"),
  writeFile(manifestTemporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
]);
await rename(packageTemporary, packagePath);
await rename(manifestTemporary, manifestPath);
console.log(
  `Prepared gênio v${version}. Commit it, create an annotated v${version}-rc.N tag, `
  + "build one digest-pinned candidate, and promote only signed evidence for that exact artifact.",
);
