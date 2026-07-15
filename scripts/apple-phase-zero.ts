import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  AppleMusicClient,
  authorizedAppleClient,
  lookupAppleCatalogByIds,
} from "../server/apple.ts";
import {
  APPLE_PHASE_ZERO_TOTAL_WRITTEN_TRACKS,
  APPLE_PHASE_ZERO_WRITE_CONFIRMATION,
  acceptApplePhaseZeroFixture,
  inventoryNeedleTestPlaylists,
  playlistIdsFromPhaseZeroReport,
  publishApplePhaseZeroSuite,
  resolveApplePhaseZeroFixture,
  validateApplePhaseZeroCatalogIdInput,
  verifyApplePhaseZeroReport,
  type ApplePhaseZeroReport,
} from "../server/apple-phase-zero.ts";
import { createApplePhaseZeroManifest } from "../server/apple-phase-zero-manifest.ts";
import { publishManifest } from "../server/publisher.ts";
import { Repository } from "../server/repository.ts";

const MAX_JSON_BYTES = 16 * 1024 * 1024;

const usage = `Usage:
  pnpm phase-zero:apple -- resolve --input <seed-ids.json> --output <resolved.json> \\
    --expected-storefront us --confirm-seed-count <3-25>

  pnpm phase-zero:apple -- publish --fixture <resolved.json> --output <report.json> \\
    --expected-storefront us --accept-fixture-sha256 <hash> \\
    --confirm-track-count 6603 --confirm-live-write

  pnpm phase-zero:apple -- verify --fixture <resolved.json> --report <report.json> \\
    --output <verification.json> --expected-storefront us \\
    --accept-fixture-sha256 <hash> --accept-report-sha256 <hash>

  pnpm phase-zero:apple -- inventory --output <inventory.json> --expected-storefront us

The publish command creates nine [GÊNIO TEST] playlists: 3, 100, 500, 1000,
and five 1000-track volumes. Inventory is read-only. Apple does not document a
library-playlist delete endpoint, so cleanup remains manual in Apple Music.`;

type Command = "resolve" | "publish" | "verify" | "inventory";

interface ParsedArgs {
  command: Command;
  values: Map<string, string>;
  flags: Set<string>;
}

const allowed: Record<Command, { values: string[]; flags: string[] }> = {
  resolve: {
    values: ["--input", "--output", "--expected-storefront", "--confirm-seed-count"],
    flags: [],
  },
  publish: {
    values: ["--fixture", "--output", "--expected-storefront", "--accept-fixture-sha256", "--confirm-track-count"],
    flags: [APPLE_PHASE_ZERO_WRITE_CONFIRMATION],
  },
  verify: {
    values: ["--fixture", "--report", "--output", "--expected-storefront", "--accept-fixture-sha256", "--accept-report-sha256"],
    flags: [],
  },
  inventory: {
    values: ["--output", "--expected-storefront"],
    flags: [],
  },
};

function parseArgs(argv: readonly string[]): ParsedArgs {
  const command = argv[0];
  if (!command || !(command in allowed)) throw new Error("Choose resolve, publish, verify, or inventory");
  const typed = command as Command;
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const commandAllowed = allowed[typed];
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (commandAllowed.flags.includes(argument)) {
      if (flags.has(argument)) throw new Error(`Duplicate flag: ${argument}`);
      flags.add(argument);
      continue;
    }
    if (!commandAllowed.values.includes(argument)) throw new Error(`Unknown ${typed} argument: ${argument}`);
    if (values.has(argument)) throw new Error(`Duplicate argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    values.set(argument, value);
    index += 1;
  }
  for (const key of commandAllowed.values) {
    if (!values.has(key)) throw new Error(`${key} is required`);
  }
  for (const flag of commandAllowed.flags) {
    if (!flags.has(flag)) throw new Error(`${typed} requires ${flag}`);
  }
  return { command: typed, values, flags };
}

function required(args: ParsedArgs, key: string): string {
  const value = args.values.get(key);
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function expectedStorefront(args: ParsedArgs): string {
  const value = required(args, "--expected-storefront").toLowerCase();
  if (!/^[a-z]{2}$/u.test(value)) throw new Error("--expected-storefront must be a two-letter Apple storefront");
  const configured = process.env.APPLE_STOREFRONT?.trim().toLowerCase();
  if (configured && configured !== value) throw new Error("--expected-storefront does not match APPLE_STOREFRONT");
  return value;
}

async function json(path: string): Promise<unknown> {
  const buffer = await readFile(resolve(path));
  if (buffer.length > MAX_JSON_BYTES) throw new Error("phase-zero JSON input exceeds 16 MiB");
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new Error("phase-zero JSON input is malformed");
  }
}

async function writeNewJson(path: string, value: unknown): Promise<void> {
  await writeFile(resolve(path), `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

function checkpointWriter(path: string): (report: ApplePhaseZeroReport) => Promise<void> {
  const output = resolve(path);
  let initialized = false;
  return async (report) => {
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (!initialized) {
      await writeFile(output, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
      initialized = true;
      return;
    }
    const temporary = resolve(dirname(output), `.${process.pid}.${Date.now()}.needle-phase-zero.tmp`);
    await writeFile(temporary, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, output);
  };
}

async function repositoryAndClient(): Promise<{ repository: Repository; client: AppleMusicClient }> {
  const repository = new Repository();
  await repository.ensureSchemaVersion();
  try {
    const { client } = await authorizedAppleClient(repository);
    return { repository, client };
  } catch (error) {
    await repository.close();
    throw error;
  }
}

async function runResolve(args: ParsedArgs): Promise<void> {
  const input = validateApplePhaseZeroCatalogIdInput(await json(required(args, "--input")));
  const expected = expectedStorefront(args);
  if (input.storefront !== expected) throw new Error("catalog ID fixture storefront does not match --expected-storefront");
  const confirmed = Number(required(args, "--confirm-seed-count"));
  if (!Number.isInteger(confirmed) || confirmed !== input.catalogIds.length) {
    throw new Error("--confirm-seed-count must exactly match the number of explicit seed IDs");
  }
  const fixture = await resolveApplePhaseZeroFixture(input, {
    resolveCatalogSongs: lookupAppleCatalogByIds,
  });
  await writeNewJson(required(args, "--output"), fixture);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    command: "resolve",
    suiteId: fixture.suiteId,
    storefront: fixture.storefront,
    seedCount: fixture.seedCount,
    expandedTrackCount: fixture.tracks.length,
    fixtureHash: fixture.fixtureHash,
    output: resolve(required(args, "--output")),
  })}\n`);
}

async function runPublish(args: ParsedArgs): Promise<void> {
  const expected = expectedStorefront(args);
  if (Number(required(args, "--confirm-track-count")) !== APPLE_PHASE_ZERO_TOTAL_WRITTEN_TRACKS) {
    throw new Error(`--confirm-track-count must equal ${APPLE_PHASE_ZERO_TOTAL_WRITTEN_TRACKS}`);
  }
  const fixture = acceptApplePhaseZeroFixture(
    await json(required(args, "--fixture")),
    required(args, "--accept-fixture-sha256"),
    expected,
  );
  const { repository, client } = await repositoryAndClient();
  try {
    const report = await publishApplePhaseZeroSuite(
      { createApplePhaseZeroManifest: (input) => createApplePhaseZeroManifest(repository, input) },
      repository,
      client,
      fixture,
      publishManifest,
      checkpointWriter(required(args, "--output")),
    );
    process.stdout.write(`${JSON.stringify({
      ok: true,
      command: "publish",
      suiteId: report.suiteId,
      reportHash: report.reportHash,
      playlistIds: playlistIdsFromPhaseZeroReport(report),
      output: resolve(required(args, "--output")),
      cleanup: "Delete only playlists beginning with [GÊNIO TEST] manually in Apple Music after acceptance.",
    })}\n`);
  } finally {
    await repository.close();
  }
}

async function runVerify(args: ParsedArgs): Promise<void> {
  const expected = expectedStorefront(args);
  const fixture = await json(required(args, "--fixture"));
  const sourceReport = await json(required(args, "--report"));
  const { repository, client } = await repositoryAndClient();
  try {
    const report = await verifyApplePhaseZeroReport(
      client,
      expected,
      fixture,
      required(args, "--accept-fixture-sha256"),
      sourceReport,
      required(args, "--accept-report-sha256"),
    );
    await writeNewJson(required(args, "--output"), report);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      command: "verify",
      suiteId: report.suiteId,
      reportHash: report.reportHash,
      playlistIds: playlistIdsFromPhaseZeroReport(report),
      output: resolve(required(args, "--output")),
    })}\n`);
  } finally {
    await repository.close();
  }
}

async function runInventory(args: ParsedArgs): Promise<void> {
  const expected = expectedStorefront(args);
  const { repository, client } = await repositoryAndClient();
  try {
    const report = await inventoryNeedleTestPlaylists(client, expected);
    await writeNewJson(required(args, "--output"), report);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      command: "inventory",
      storefront: report.storefront,
      testPlaylistCount: report.items.length,
      reportHash: report.reportHash,
      output: resolve(required(args, "--output")),
      cleanup: "Delete the listed [GÊNIO TEST] playlists manually in Apple Music. Legacy [NEEDLE TEST] playlists are also inventoried for cleanup.",
    })}\n`);
  } finally {
    await repository.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "resolve") return runResolve(args);
  if (args.command === "publish") return runPublish(args);
  if (args.command === "verify") return runVerify(args);
  return runInventory(args);
}

main().catch((error) => {
  const inputError = error instanceof Error && (
    error.message.startsWith("--")
    || error.message.startsWith("Choose ")
    || error.message.startsWith("Unknown ")
    || error.message.startsWith("Duplicate ")
    || error.message.includes(" fixture")
    || error.message.includes(" storefront")
    || error.message.includes("JSON input")
  );
  process.stderr.write(`${usage}\n\n${JSON.stringify({
    ok: false,
    code: inputError ? "invalid_phase_zero_input" : "phase_zero_failed",
    message: inputError ? (error as Error).message : "The Apple phase-zero command did not complete.",
  })}\n`);
  process.exitCode = 1;
});
