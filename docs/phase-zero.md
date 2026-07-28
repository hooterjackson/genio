# Phase-zero feasibility runbook

These gates require live owner credentials and cannot be replaced by mocks. Stop the hosted migration if public share links or second-account library import fail.

## Apple authorization and publication

After owner authorization is stored and the worker environment has its Apple and database secrets, run the guarded three-track probe from that environment:

```sh
pnpm smoke:apple -- --confirm-live-write --name "[GÊNIO TEST] three-track" \
  --catalog-id <APPLE_SONG_ID> \
  --catalog-id <APPLE_SONG_ID> \
  --catalog-id <APPLE_SONG_ID>
```

The command refuses names outside the `[GÊNIO TEST]` namespace, refuses more than 25 IDs, verifies exact ordered membership (including duplicate occurrences), and prints only safe playlist metadata. Delete the test playlist manually after the second-account import check.

After the three-track probe succeeds, use the comprehensive capacity harness. Create `.artifacts/phase-zero/` (already ignored by Git), then start with a local JSON file there containing 3–25 explicit US Apple song IDs:

```json
{
  "schemaVersion": 1,
  "suiteId": "live-YYYY-MM-DD",
  "storefront": "us",
  "catalogIds": ["<APPLE_SONG_ID>", "<APPLE_SONG_ID>", "<APPLE_SONG_ID>"]
}
```

Resolve and inspect the immutable 5,000-occurrence fixture before authorizing writes:

```sh
pnpm phase-zero:apple -- resolve \
  --input .artifacts/phase-zero/seeds.json \
  --output .artifacts/phase-zero/resolved.json \
  --expected-storefront us \
  --confirm-seed-count 3
```

The publish command creates nine `[GÊNIO TEST]` playlists containing 6,603 total occurrences: 3, 100, 500, 1,000, and five ordered 1,000-track volumes. Run it only after the owner explicitly approves those live writes and supplies the exact fixture hash printed by `resolve`:

```sh
pnpm phase-zero:apple -- publish \
  --fixture .artifacts/phase-zero/resolved.json \
  --output .artifacts/phase-zero/report.json \
  --expected-storefront us \
  --accept-fixture-sha256 <PRINTED_FIXTURE_HASH> \
  --confirm-track-count 6603 \
  --confirm-live-write

pnpm phase-zero:apple -- verify \
  --fixture .artifacts/phase-zero/resolved.json \
  --report .artifacts/phase-zero/report.json \
  --output .artifacts/phase-zero/verification.json \
  --expected-storefront us \
  --accept-fixture-sha256 <PRINTED_FIXTURE_HASH> \
  --accept-report-sha256 <PRINTED_REPORT_HASH>
```

Inventory is deliberately read-only because Apple does not document a library-playlist deletion endpoint. Use the resulting list for manual cleanup in Apple Music:

```sh
pnpm phase-zero:apple -- inventory \
  --output .artifacts/phase-zero/inventory.json \
  --expected-storefront us
```

- [ ] Authorize the owner's personal Apple Music account and persist only an AES-256-GCM encrypted user token.
- [ ] Restart API and worker; validate that publication still works.
- [ ] Force an Apple 401/403; verify the manifest remains locked and publication enters `waiting_for_apple_authorization` without repeated retries.
- [ ] Reauthorize; verify the same publication resumes automatically.
- [ ] Publish a three-track `[GÊNIO TEST]` playlist and wait for a stable Apple share link.
- [ ] From a second paid Apple Music account, open the link and add the playlist to the library.
- [ ] Record the publisher identity Apple displays and explicitly accept or reject it.
- [ ] Publish live 100-, 500-, and 1,000-track playlists and compare exact ordered membership to each manifest.
- [ ] Publish five ordered 1,000-track volumes and verify naming, links, duplicates, and boundaries.
- [ ] Delete all `[GÊNIO TEST]` playlists manually from the owner account. The inventory also reports legacy `[NEEDLE TEST]` playlists so they can be removed.

## Simulated 6,000-track publication

- [ ] Exercise six deterministic 1,000-track volumes with 25-track append batches.
- [ ] Inject a timeout after the server accepted a batch; verify exact ordered-prefix reread prevents duplication.
- [ ] Inject duplicate catalog IDs and verify occurrence-aware sequence reconciliation.
- [ ] Inject a divergent Apple sequence; verify the volume is orphaned and replaced, never patched in place.
- [ ] Inject rate limits and transient failures; verify bounded backoff and resumability.

## Hosting boundary

- [ ] Prove Sites owner identity on the final custom domain and exact server-side `OWNER_EMAIL` authorization.
- [ ] Prove a browser-supplied `oai-authenticated-user-email` header is stripped or rejected and only Sites-authenticated Sign in with ChatGPT identity reaches the gateway owner allowlist.
- [ ] Prove invalid HMAC, wrong body hash, stale timestamp, and repeated nonce are rejected.
- [ ] Rotate the gateway key while in-flight reads and jobs remain safe.
- [ ] Prove only API is public; worker and Postgres resolve only through Railway private networking.
- [ ] Confirm `robots.txt`, `noindex`, CSP, CSRF, payload limits, log redaction, and fixed route/adapter allowlists.

## Operations and terms

- [ ] Run a Postgres PITR restore and cut over a staging API/worker to it.
- [ ] Restore the Apple-token encryption key and validate an encrypted token in staging.
- [ ] Verify month-boundary cost reservation behavior in `America/Sao_Paulo`.
- [ ] Review current Apple, OpenAI, MusicBrainz, Discogs, Resend, and public-playlist terms for the friends-only service.
- [ ] Record the review date and owner sign-off in the release record.

## Independent quality acceptance

- [ ] Expand the checked-in Paulinho da Costa and Michael Jackson seed fixtures through independent review; do not use runtime research output to author the expected catalogue.
- [ ] Prepare and finalize the Postgres-derived, hash-bound staging benchmark artifact with independently reviewed Apple judgments and Berlin-techno scores plus rationales.
- [ ] Run `pnpm benchmark -- <artifact.json>` and retain the passing report with the release record (100% factual holdout recovery, at least 600 independently reviewed error-free auto-matches before making the 99.5% catalog-identity claim, and at least 95% storefront-available resolvability).
