import { parseAppleSmokeArgs, publicAppleSmokeError, runApplePublicationSmoke } from "../server/apple-smoke.ts";
import { Repository } from "../server/repository.ts";

const usage = [
  "Usage:",
  "  pnpm smoke:apple -- --confirm-live-write --name \"[GÊNIO TEST] three-track\" \\",
  "    --catalog-id <APPLE_SONG_ID> --catalog-id <APPLE_SONG_ID> --catalog-id <APPLE_SONG_ID>",
  "",
  "This performs a real write to the owner's Apple Music library. It accepts 1-25 ordered song IDs.",
].join("\n");

let repository: Repository | null = null;
try {
  const input = parseAppleSmokeArgs(process.argv.slice(2));
  repository = new Repository();
  await repository.ensureSchemaVersion();
  const result = await runApplePublicationSmoke(repository, input);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    name: result.name,
    storefront: result.storefront,
    playlistId: result.playlistId,
    shareUrl: result.shareUrl,
    orderedCatalogIds: result.orderedCatalogIds,
    cleanup: `Delete playlists beginning with ${"[GÊNIO TEST]"} after validation.`,
  }, null, 2)}\n`);
} catch (error) {
  const safe = publicAppleSmokeError(error);
  process.stderr.write(`${usage}\n\n${JSON.stringify({ ok: false, ...safe }, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  await repository?.close();
}
