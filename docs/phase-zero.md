# Phase-zero feasibility runbook

These gates require live owner credentials and cannot be replaced by mocks. Stop the hosted migration if public share links or second-account library import fail.

## Apple authorization and publication

After owner authorization is stored and the worker environment has its Apple and database secrets, run the guarded three-track probe from that environment:

```sh
pnpm smoke:apple -- --confirm-live-write --name "[NEEDLE TEST] three-track" \
  --catalog-id <APPLE_SONG_ID> \
  --catalog-id <APPLE_SONG_ID> \
  --catalog-id <APPLE_SONG_ID>
```

The command refuses names outside the `[NEEDLE TEST]` namespace, refuses more than 25 IDs, verifies exact ordered membership (including duplicate occurrences), and prints only safe playlist metadata. Delete the test playlist manually after the second-account import check.

- [ ] Authorize the owner's personal Apple Music account and persist only an AES-256-GCM encrypted user token.
- [ ] Restart API and worker; validate that publication still works.
- [ ] Force an Apple 401/403; verify the manifest remains locked and publication enters `waiting_for_apple_authorization` without repeated retries.
- [ ] Reauthorize; verify the same publication resumes automatically.
- [ ] Publish a three-track `[NEEDLE TEST]` playlist and wait for a stable Apple share link.
- [ ] From a second paid Apple Music account, open the link and add the playlist to the library.
- [ ] Record the publisher identity Apple displays and explicitly accept or reject it.
- [ ] Publish live 100-, 500-, and 1,000-track playlists and compare exact ordered membership to each manifest.
- [ ] Publish five ordered 1,000-track volumes and verify naming, links, duplicates, and boundaries.
- [ ] Delete all `[NEEDLE TEST]` playlists manually from the owner account.

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
- [ ] Export the staging holdout recovery, reviewed Apple matching decisions, and Berlin-techno human rubric scores into one benchmark artifact.
- [ ] Run `pnpm benchmark -- <artifact.json>` and retain the passing report with the release record (100% factual holdout recovery, at least 99.5% auto-match precision, and at least 95% storefront-available resolvability).
