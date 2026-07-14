# Release readiness — 2026-07-14

This record separates automated evidence from live provider evidence. A checked
automated gate does not substitute for a live Apple, DNS, database-recovery, or
second-account test.

## Current decision

**Internal engineering and guarded Apple smoke testing may continue. Anonymous
publication is not ready for wider sharing.**

Release remains blocked on:

1. written Apple clarification that an owner-funded Apple Music account may
   publish playlists requested by anonymous visitors;
2. a live stable Apple share link and successful second-account Add to Library;
3. the custom-domain DNS records and owner authentication on that domain;
4. a real staging/PITR restore and cutover drill;
5. live 3, 100, 500, 1,000, and five-volume Apple publication checks;
6. independently expanded holdouts and a passing staging benchmark artifact.

## Evidence completed locally

- [x] Fail-closed cost configuration; exactly $5 auto-starts and $8 requires
  owner approval.
- [x] Durable/public failures use bounded context-safe messages.
- [x] An interrupted matching phase cannot lock a manifest.
- [x] Every candidate receives an explicit accepted, unavailable, rejected,
  duplicate, or unsupported outcome before the manifest locks.
- [x] Apple 401/403 preserves the immutable manifest and waits for replacement
  authorization.
- [x] Replacement Apple authorization resumes the preserved publication.
- [x] Accepted-but-uncertain Apple batches reconcile by exact ordered prefix.
- [x] A deterministic 6,000-track publisher exercise creates six exact
  1,000-track volumes, uses 25-track batches, preserves duplicate occurrences,
  handles a rate limit, and returns six stable links.
- [x] Gateway current/previous-key rotation and retired-key rejection.
- [x] Mobile layouts at 320, 390, and 430 pixels; 44-pixel controls, visible
  desktop keyboard focus, reduced motion, and primary-text WCAG AA contrast.
- [x] Discogs is disabled by default and hard-disabled in production.
- [x] A public privacy notice documents AI processing, providers, cookies,
  derived network buckets, retention, deletion limits, age, and contact.

The exact commands and counts belong in the associated GitHub CI run after the
changes are committed. PostgreSQL-specific cases must pass there; the local
environment does not currently expose a test database.

## Live state observed

- [x] Owner reported Apple Music authorization complete.
- [x] Railway API reports database ready, worker healthy, no queued/leased/
  failed jobs, and no publication failures after authorization.
- [x] Railway exposes only the API publicly; worker and PostgreSQL have no
  service domains.
- [x] The Sites boundary rejects unsigned direct Railway requests, cross-site
  mutations, unknown routes, and spoofed owner identity.
- [ ] Post-restart Apple publication succeeds with the persisted encrypted user
  token.
- [ ] An API-created playlist produces a stable share link.
- [ ] A second paid Apple Music account can open and add that playlist.
- [ ] Publisher identity displayed to the second account is accepted.

## Production dependencies

- [ ] Explicit approval to register the owner's existing GitHub public SSH key
  with Railway for guarded worker-shell smoke tests. Remove it after the live
  validation if persistent access is not wanted.
- [ ] Explicit approval to apply the reviewed five-change Railway plan:
  managed database references for API/worker, `Always` restart for API/worker,
  and the current Sites origin for `APP_ORIGIN`.
- [ ] Add the pending `needle.engineered.lighting` CNAME and two Sites TXT
  validation records, then wait for SSL activation.
- [ ] Change the canonical Apple developer-token origin to the custom domain
  after DNS activation and revalidate authorization there.
- [ ] Create a staging Railway environment and complete a seven-day PITR
  restore/cutover exercise.
- [ ] Configure external uptime checks and Railway spend thresholds.

## Terms review

Review date: **2026-07-14**. This is an engineering risk review, not legal
advice.

- Apple describes MusicKit as access to an authorized end user's Apple Music
  subscription. The owner-token/anonymous-visitor model needs written Apple
  confirmation before wider launch:
  <https://developer.apple.com/support/terms/apple-developer-program-license-agreement/>
- Apple's documented create-playlist request does not document a public/profile
  visibility mutation, so a live cross-account proof remains mandatory:
  <https://developer.apple.com/documentation/applemusicapi/create-a-new-library-playlist>
- Discogs remains disabled because the launch retention/report design does not
  satisfy its short freshness and attribution requirements:
  <https://support.discogs.com/hc/en-us/articles/360009334593-API-Terms-of-Use>
- The OpenAI API service structure is compatible with an owner-funded
  application, subject to the owner's end-user, consent, policy, and abuse
  responsibilities:
  <https://openai.com/policies/services-agreement/>
- MusicBrainz noncommercial use requires a meaningful User-Agent and no more
  than one request per second; data-license class must remain attributable:
  <https://musicbrainz.org/doc/MusicBrainz_API>
- Sites privacy and owner responsibilities are reflected in the public privacy
  notice:
  <https://openai.com/policies/chatgpt-sites-terms/>

## Sign-off

- Engineering: pending all automated tests and CI.
- Owner live Apple/publication acceptance: pending.
- Terms risk acceptance: pending Apple clarification.
- Wider friends-only launch: blocked.
