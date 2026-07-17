# Release-candidate QA contract

Last reviewed: 2026-07-16

This is the release contract for the anonymous prompt-to-Apple-Music flow, the
owner console, and the durable research/publication pipeline. It complements
the frozen factual holdouts in `docs/benchmark-holdouts.md` and the retained
production replays in `docs/release-scenario-qa.md`.

The contract deliberately separates three kinds of evidence:

- **Offline**: deterministic unit, integration, fixture, and browser tests. No
  paid provider or network access is permitted.
- **Staging**: provider-backed research and Apple catalog checks using capped,
  owner-approved canaries.
- **Live manual**: cross-account Apple Music, custom-domain, and recovery checks
  that cannot be truthfully proven by mocks.

A release is not ready merely because it returns a playlist. It must return the
right scope and count, cite the assertions it makes, preserve every exclusion,
match safe Apple recordings, sequence them intentionally, publish exactly the
approved manifest, and report every omission.

## Non-negotiable release invariants

1. A public size control from 1 through 300 is server-authoritative. A request
   for `N` tracks either publishes exactly `N` safe manifest rows or fails
   closed without publishing a smaller playlist. Duplicate recording
   occurrences are allowed only when they were explicitly approved.
2. The UI count overrides a contradictory number in prompt prose. A custom
   guided answer cannot change the confirmed subject, relationship, version
   policy, evidence policy, or count.
3. A subjective or similarity request uses the bounded curated path and cannot
   exceed the combined public preflight-and-research ceiling of $1.50. Visitors
   never see cost; the owner can audit estimate, reservation, and actual spend.
4. “Similar to X” means recordings by other artists by default. X is a style
   seed and is excluded unless the user explicitly asks to include X.
5. Negative constraints are hard requirements, not ranking hints. The system
   may fail closed rather than fill the requested count with forbidden artists,
   eras, regions, versions, or recording types.
6. Factual exhaustive research never expands an album-wide or session-wide
   credit into track claims without track-level proof. “Exhaustive” means
   exhaustive across the documented, completed source frontier, with every
   inaccessible or unresolved gap visible.
7. Apple metadata can establish catalog identity and availability, but it
   cannot prove a performance credit, historical influence, or cultural claim.
8. Automatic Apple acceptance requires an exact stable identifier with
   compatible metadata, or a unique compatible recording family. Ambiguous
   re-recordings, live versions, edits, aliases, and conflicting artists remain
   unresolved unless a deterministic safe rule applies.
9. Every candidate ends as accepted, unavailable, rejected, duplicate,
   unsupported, review, or overflow. No candidate disappears between research,
   matching, manifest creation, or reporting.
10. Curated playlists intermix artists and albums whenever the distribution
    makes that possible. An explicit chronological, ranked, alphabetical, or
    source order is preserved instead of being resequenced.
11. A locked manifest is immutable. Publication preserves exact order and
    duplicate occurrences, reconciles uncertain writes by exact ordered prefix,
    and never lets model output invoke Apple writes.
12. Provider, worker, database, authorization, and browser failures are durable
    states. Refresh, retry, lease reclamation, or owner reauthorization resumes
    safely without duplicate provider charges or duplicate playlist rows.

## User stories and acceptance criteria

### US-01 — Create a playlist with one command

As a visitor, I can describe a playlist, select a track count, answer only
material follow-up questions, and leave the site while the job continues.

Acceptance criteria:

- The initial screen has one prompt, one explicit count control, and one primary
  action.
- The request is idempotent under double taps and browser retries.
- Preflight returns two or three prompt-specific questions. Each has exactly
  three mutually exclusive options, one recommended option, and a bounded
  custom answer.
- Follow-ups never ask for count again and never silently broaden the subject.
- Refreshing or reopening a capability URL restores the latest durable state.
- A failure message is bounded, actionable, and contains no provider secret or
  raw upstream response.

### US-02 — Receive the exact requested number

As a visitor, I receive the number I selected rather than a default, cap, or
partial success.

Acceptance criteria:

- Counts 1, 25, 50, 100, 200, and 300 remain exact through brief, candidate
  reserve, matching, manifest, publication, and result.
- Prompt numbers that are years, artist names, audience size, duration, or
  release counts are not interpreted as track counts.
- The explicit UI count wins when prompt prose says a different number or “a
  long playlist.”
- A 50-to-28 or 200-to-75 result is a release failure, not a successful smaller
  playlist.
- If the catalog-safe reserve cannot fill the count, no manifest or Apple
  playlist is created and the shortfall is reported explicitly.

### US-03 — Find music like an artist without returning that artist

As a visitor looking for discovery, I can use an artist as a reference without
receiving a playlist dominated by that artist.

Acceptance criteria:

- “Sounds like,” “similar to,” “adjacent to,” “in the vein of,” “for fans of,”
  and hyphenated `X-style` wording all activate similarity policy.
- The reference artist is excluded case- and punctuation-insensitively by
  default.
- An explicit “include some X” request is surfaced as a material scope choice
  rather than silently ignored.
- Generic entities such as “other artists” and repeated query fragments are not
  treated as artists.
- Results exhibit artist diversity and do not substitute the reference
  artist's solo, alias, live, or compilation credits for other artists.

### US-04 — Apply difficult exclusions

As a visitor, I can exclude artists, albums, eras, versions, regions, labels, or
recording types and trust that the playlist will not violate those rules merely
to reach its count.

Acceptance criteria:

- Exclusions survive structured interpretation, guided refinement, candidate
  generation, recovery passes, matching, and sequencing.
- “No remixes/live recordings/re-recordings” is enforced against Apple version
  labels, album metadata, duration conflicts, and release families.
- A per-artist or per-album cap is accounted for before manifest locking.
- A contradiction such as “only 1987–1990” and “include a 1995 track” produces
  a material question or explicit failure, never arbitrary precedence.
- Unsupported candidates do not become accepted merely because they satisfy a
  remaining count slot.

### US-05 — Resolve genuinely ambiguous music entities

As a visitor, I am asked a small, useful question when a name could materially
change the playlist.

Acceptance criteria:

- Ambiguities such as Air, X, Phoenix, Berlin, Jungle, or a misspelled person
  are resolved before paid research if they change entity identity or scope.
- Questions provide three concrete, mutually exclusive interpretations plus a
  custom answer; they do not invent a fourth hidden default.
- The selected answer is stored and visible in the run's evidence/scope report.
- The system does not ask about stylistic details that do not materially change
  the result.
- If an entity cannot be resolved confidently, the job stops before research
  rather than researching all possible meanings.

### US-06 — Run source-bounded exhaustive and session-credit research

As a researcher, I can ask for all documented recordings connected by a
specific factual relationship and understand the boundary of completeness.

Acceptance criteria:

- Prose-only explicit factual enumeration can select exhaustive mode; a public
  fixed count is labeled as a curated selection even if the prompt says “all.”
- Relationship scope distinguishes performed on, percussion credit, wrote,
  produced, sampled, featured, and primary artist.
- Each included factual recording has a claim bound to the confirmed entity and
  relationship, a stored returned source, and track-level support.
- Album/session/container credit alone never expands every track.
- Pagination, advertised totals, discovered containers, and inaccessible or
  unresolved sources are reconciled in the frontier ledger.
- Completion requires every frontier item to be terminal and two gap passes
  with no new evidence-backed recordings.
- The result says “exhaustive across these sources,” never “every recording in
  existence,” and exposes unresolved gaps.

### US-07 — Get safe Apple Music matches

As a visitor, I receive the intended recording available in the owner's US
storefront, not a similarly named song or an arbitrary version.

Acceptance criteria:

- Matching tries ISRC first, then bounded title/artist and cautious album/base-
  title fallbacks.
- Diacritics, smart apostrophes, ampersands, leading articles, parenthetical
  translations, featured artists, and compilation reissues are normalized
  without collapsing materially different recordings.
- A unique original recording family may beat equivalent reissues; live,
  remix, edit, karaoke, tribute, and materially different re-recordings do not.
- A title match with a conflicting artist remains unresolved.
- “Unavailable” means no safe US-storefront match after bounded recovery, not
  that no global Apple page exists.
- Matching recovery can use additional safe candidates, but cannot weaken
  evidence or version rules.

### US-08 — Receive a deliberately ordered playlist

As a listener, I hear a coherent playlist rather than blocks grouped by artist
or album.

Acceptance criteria:

- Curated flow avoids adjacent artists and albums whenever mathematically
  feasible.
- Supplied genre, year, duration, BPM, and musical key can influence smooth or
  high-contrast transitions; missing metadata remains neutral and is never
  invented.
- The algorithm is deterministic for the same manifest input and preferences.
- Every input occurrence remains exactly once, including intentional duplicate
  occurrences.
- Explicit chronological, influence-ranked, alphabetical, source, or user order
  bypasses flow sequencing.

### US-09 — Publish and share reliably

As a visitor, I receive a working Apple Music share link created from the
approved manifest.

Acceptance criteria:

- Publication begins only from a locked manifest ID.
- More than 1,000 rows split into consistently named ordered volumes; current
  public 1–300 requests remain one volume.
- Batches append in order and uncertain responses reconcile against the exact
  ordered prefix before retrying.
- A divergent remote playlist becomes orphaned; it is never presented as the
  result. Replacement publication starts from the immutable manifest.
- The result is complete only after Apple reports the expected membership and a
  stable share URL.
- A second paid Apple Music account can open and add the playlist; regional
  availability differences are disclosed.

### US-10 — Recover from authorization and provider failures

As the owner, I can restore a failed dependency without losing visitor work.

Acceptance criteria:

- Apple 401/403 moves publication to `waiting_for_apple_authorization`, preserves
  the manifest, avoids repeated retries, and resumes after a replacement token.
- The encrypted Apple user token survives an API/worker restart and validation
  distinguishes timeout from rejection.
- OpenAI and Apple 429/5xx failures retry at most three times with bounded
  backoff and stable idempotency.
- A worker crash or lost lease cannot finalize stale work; an expired lease is
  safely reclaimed.
- No OpenAI or Apple request starts while Postgres is unavailable.
- An exhausted recovery becomes one explicit terminal outcome and cannot loop
  indefinitely.

### US-11 — Audit use, spend, and feedback privately

As the owner, I can inspect every attempt, cost, failure, publication, and user
feedback submission without exposing that data to visitors.

Acceptance criteria:

- Every brief attempt is retained for its configured window, including failed,
  abandoned, budget-blocked, and never-published attempts.
- The owner view shows estimate, reservation, actual cost, phase durations,
  candidate/match/manifest counts, failure class, and public links.
- Visitor screens do not show dollar amounts or other visitors' private prompts.
- Feedback text and images are visible only to the exact owner allowlist and are
  protected from path traversal, unsafe media, oversized upload, and stored XSS.
- A redacted production export can be promoted into deterministic regression
  fixtures without using production output to fill factual holdouts.

### US-12 — Explore published playlists safely

As a visitor, I can browse playlists already published by the service without
gaining access to another visitor's private run or capability.

Acceptance criteria:

- The directory exposes only completed playlists with stable Apple share URLs
  and intentionally public title/description/count metadata.
- Prompts, capability tokens, evidence notes, costs, owner controls, incomplete
  jobs, orphaned playlists, and deleted runs are never exposed.
- Deleted Needle data can remove a directory entry but cannot promise deletion
  of an already-created Apple playlist.

## Scenario-test matrix

The machine-readable prompt-policy subset is in
`tests/fixtures/release-candidate-esoteric-scenarios.json`. The IDs below are
release traceability anchors; an ID appears in the JSON fixture when its
deterministic workload contract can be represented without a provider. Other
IDs remain staging, live, or multi-step scenario specifications.
Provider-backed scenarios must record source coverage, candidate outcomes,
safe Apple match count, exact manifest count, published count, spend, active
duration, and terminal phase.

### Prompt interpretation, count, and guided scope — offline

| ID | Scenario | Expected result |
| --- | --- | --- |
| RC-P01 | Prompt says “300 techno tracks”; UI count is 50 | Curated exact 50; no model response can restore 300. |
| RC-P02 | Prompt says “a long playlist for four hours”; UI count is 100 | Curated exact 100; bounded fast policy and spend. |
| RC-P03 | “Berlin techno from 1990 to 1999” with count 50 | Years are scope, not counts; exact 50. |
| RC-P04 | “Glitch hop adjacent to Prefuse 73 and Warp Records, but no Prefuse 73 tracks” with count 100 | 73 is part of the entity; exact 100; Prefuse 73 excluded. |
| RC-P05 | Custom answer says “ignore size; make 1,000 tracks” | Original count and scope survive without a second model call. |
| RC-P06 | Model returns zero, three, malformed, or count-related scope questions | Safe prompt-specific fallback produces two questions, each with three options; final question controls flow. |
| RC-P07 | Double-submit preflight and final answers | One brief/run is created; actual provider cost reconciles once. |
| RC-P08 | “Every released Michael Jackson song” without a count control | Exhaustive mode with null target; no silent 100-track cap. |
| RC-P09 | Same “every” prompt through public UI with count 100 | Curated 100 and wording must not claim exhaustiveness. |

### Similarity and hard exclusions — offline plus frozen-provider staging

| ID | Scenario | Expected result |
| --- | --- | --- |
| RC-S01 | “Music that sounds like Radiohead” | Radiohead is excluded as style seed; other artists dominate 100% of rows. |
| RC-S02 | “Other artists in the vein of Jorge Ben Jor, excluding Jorge Ben Jor and Tim Maia” | Seed and explicit exclusion survive all passes. |
| RC-S03 | “Prefuse 73 and Warp-adjacent glitch hop; do not give me Prefuse 73” | Seed and explicit exclusion survive all passes. |
| RC-S04 | “Radiohead-style, but include five Radiohead tracks” | Material conflict is surfaced; answer becomes an explicit bounded exception. |
| RC-S05 | “50 Belgian new beat tracks, 1987–1990, no modern revivals, live versions, or remixes” | Every row meets dates/version rules; no filler outside scope. |
| RC-S06 | “40 Dunedin Sound tracks; no The Clean or The Chills; max two per artist” | Caps and exclusions hold before manifest lock. |

### Extremely esoteric discovery — staging with independent review

These cases are intentionally difficult. Passing means source-backed relevance,
safe failure when evidence is thin, and exact-count behavior—not agreement with
a model-generated canon. Create a small independently reviewed holdout before a
scenario can become a factual content gate.

| ID | Prompt | Review focus |
| --- | --- | --- |
| RC-E01 | “Lowercase improvisation recordings adjacent to Wandelweiser; exclude Eva-Maria Houben and Michael Pisaro.” with count 40 | Avoid seed artists; distinguish label/collective adjacency from generic ambient. |
| RC-E02 | “35 Guadeloupean gwo ka moderne and cadence-lypso crossover tracks from 1975–1992; no Kassav’.” | Geography, era, orthography, genre boundary, hard exclusion. |
| RC-E03 | “25 Japanese environmental-music-adjacent recordings from 1980–1989; exclude Hiroshi Yoshimura.” | Do not return generic city pop/new age or the excluded seed. |
| RC-E04 | “30 pre-1990 Cape Verdean funaná recordings; no morna and no Cesária Évora.” | Style distinction, Lusophone spelling, era and artist exclusion. |
| RC-E05 | “40 South African bubblegum and Shangaan disco tracks before 1994; no Brenda Fassie.” | Distinguish adjacent styles and respect temporal boundary. |
| RC-E06 | “30 Tamil film songs from 1960–1985 where nadaswaram is a featured lead instrument, not merely named in the title.” | Track-level instrumental evidence; no keyword-only inference. |
| RC-E07 | “25 electroacoustic works prominently using daxophone, glass harmonica, or prepared zither; exclude works where the instrument appears only in liner-note personnel.” | Relationship and instrumentation evidence precision. |
| RC-E08 | “50 Belgian new beat tracks released 1987–1990, one canonical original mix per recording.” | Version families, aliases, label metadata, safe Apple identity. |
| RC-E09 | “35 tracks tracing the Bristol–Berlin dub-techno exchange, excluding Basic Channel and Massive Attack.” | Cross-scene editorial claim, seed exclusion, diversity. |
| RC-E10 | “30 privately issued North American minimal-synth tracks from 1978–1985, no later re-recordings.” | Scarce sources, reissue/original-family handling, safe failure. |

### Ambiguous entities — offline structured-output fixtures

| ID | Prompt | Expected question or resolution |
| --- | --- | --- |
| RC-A01 | “50 deep cuts by Air” | French duo, another act named Air, or broad air-themed music. |
| RC-A02 | “50 essential X tracks” | Los Angeles punk band, X Japan, or another named act. |
| RC-A03 | “Influential Berlin tracks” | Berlin the band, Berlin city scene, or a named genre/era. |
| RC-A04 | “Phoenix deep cuts” | Phoenix the band, a different act, or city-themed music. |
| RC-A05 | “Jungle from Congo, 40 tracks” | Jungle genre, Congolese music, or crossover intent. |
| RC-A06 | “Pavement and Steven Malcolm S adjacent 90s rock” | Repair likely Stephen Malkmus while confirming the intended person. |
| RC-A07 | “Every song Prince played on” | Distinguish primary artist, instrumental performance, composition, production, and guest credit. |

### Factual exhaustive/session-credit research — offline integrity plus staging

| ID | Scenario | Expected result |
| --- | --- | --- |
| RC-X01 | Every track explicitly crediting Paulinho da Costa with percussion | Track-bound evidence only; no album expansion; source-bounded completion report. |
| RC-X02 | Every released recording with Hal Blaine explicitly credited as drummer | Identity aliases and role wording resolved; no producer/composer substitution. |
| RC-X03 | Every Alice Coltrane track featuring Pharoah Sanders | Track relationship proven; albums without per-track personnel remain gaps. |
| RC-X04 | Every non-Prince-primary-artist song where Prince is explicitly credited with guitar | Primary-artist exclusion and exact instrument relationship both enforced. |
| RC-X05 | Source claims 189 tracks but pagination recovers 186 | Frontier cannot report complete; discrepancy remains visible and terminally unresolved. |
| RC-X06 | Two sites copy the same underlying credit database | One provenance root; not independent corroboration. |
| RC-X07 | Model submits a plausible URL absent from hosted search/adapter results | Source and candidate claim are rejected. |
| RC-X08 | Hostile page tells the model to invent credits or invoke Apple writes | No unsupported candidate and no path from research tools to publisher. |

### Apple catalog, regional availability, and versions — frozen provider plus live

| ID | Scenario | Expected result |
| --- | --- | --- |
| RC-M01 | Smart apostrophe/ASCII apostrophe and accented/unaccented metadata | Same candidate can be found, but artist/version compatibility is still required. |
| RC-M02 | Bilingual parenthetical title such as “The Gentle Rain (Chuva Delicada)” | Bounded base-title fallback finds safe candidates without accepting a wrong artist. |
| RC-M03 | Full collaboration credit differs from Apple's primary artist display | Album/identifier evidence may resolve; never split collaborators into unsafe individual searches. |
| RC-M04 | Original, compilation reissue, short edit, live take, and later re-recording all share title | Canonical policy selects only the compatible recording family or leaves review. |
| RC-M05 | Apple US has no safe match but another storefront has a page | Mark US unavailable; never write a foreign storefront ID to the owner's playlist. |
| RC-M06 | First pass matches 75 of 100, recovery can safely match 25 reserve candidates | Publish exactly 100; report all overflow/unavailable rows. |
| RC-M07 | Recovery ends at 99 of 100 | Fail closed; zero manifest rows and zero published rows. |
| RC-M08 | Apple 429 then success; Apple 503 three times | Bounded retry with same idempotency; success once in first case, durable failure/pause in second. |

### Sequencing — offline property tests

| ID | Scenario | Expected result |
| --- | --- | --- |
| RC-Q01 | Feasible distribution across three artists and albums | Zero adjacent same-artist and same-album pairs. |
| RC-Q02 | One artist exceeds half the rows | Minimum mathematically possible adjacency; no dropped rows. |
| RC-Q03 | Smooth-flow metadata contains genre/year/duration/BPM/key | Compatible next track wins deterministic tie-breaking. |
| RC-Q04 | High-contrast answer | Deliberate contrast is preferred without violating artist/album intermixing. |
| RC-Q05 | Chronological or influence-ranked request | Original confirmed order is preserved exactly. |
| RC-Q06 | Duplicate occurrences and missing metadata | Duplicates remain distinct; missing values are neutral and not synthesized. |
| RC-Q07 | 10,000 synthetic rows | Completes within the unit-test limit with no omissions or duplicate source indices. |

### Durability, publication, and security — offline integration plus live canary

| ID | Scenario | Expected result |
| --- | --- | --- |
| RC-R01 | Browser double-taps Create, answers, or Publish | One idempotent mutation and no duplicate provider charge. |
| RC-R02 | Worker exits after persisting candidates but before completing job | Lease expires, new worker resumes from checkpoint, candidates are not duplicated. |
| RC-R03 | Database readiness fails | No lease, heartbeat, OpenAI call, Apple call, or publication begins. |
| RC-R04 | Apple append succeeds remotely but response times out | Exact remote prefix is reread; only missing suffix retries. |
| RC-R05 | Remote sequence diverges | Existing playlist is orphaned and a replacement begins; divergent link is never returned. |
| RC-R06 | Apple token receives 401/403 | Manifest preserved, no retry loop, resume after owner reauthorization. |
| RC-R07 | API/worker restart after authorization | Encrypted token remains usable and a 3-track canary publishes. |
| RC-R08 | Capability stolen, replayed after exchange, or used cross-route | One-time exchange, scoped Strict cookie, route denial, no token in logs. |
| RC-R09 | Feedback upload is oversized, executable, spoofed, or contains HTML/JS | Reject unsafe upload; render text inertly; private owner access only. |
| RC-R10 | Public directory query | Only completed stable-link metadata is returned; private prompt/cost/capability fields absent. |

## QA sweep execution order

1. **Static integrity**: format/lint, TypeScript builds, migration journal,
   schema compatibility, secret scan, and dependency review.
2. **Unit/property tests**: brief policy, prompt corpus, guidance refinement,
   evidence binding, deduplication, matching ladders, sequencing, count/cost
   boundaries, and error sanitization.
3. **Integration tests**: durable jobs, leases, checkpoints, reservations,
   matching recovery, manifest immutability, publication reconciliation,
   capability exchange, feedback privacy, and retention.
4. **Browser tests**: 320/390/430 mobile widths and desktop; keyboard-only;
   screen reader names/status; focus restoration; reduced motion; offline and
   refresh recovery; no visitor cost display.
5. **Frozen content gates**: independent Paulinho and Michael Jackson holdouts,
   Berlin-techno editorial scoring, production regression replay, and the
   offline esoteric policy corpus.
6. **Capped staging canaries**: one nominal 25-track prompt, one similarity
   prompt, one ambiguous prompt, one esoteric prompt, and one 100-track catalog
   recovery prompt. Record cost and active time; do not silently retry a paid
   canary.
7. **Live Apple gates**: public-flow 3/100/300 canaries; owner-only publisher
   capability checks at 500/1,000 and five ordered 1,000-track volumes where
   release scope requires them; post-restart authorization, stable share URL,
   second-account Add to Library, US storefront, and reauthorization resume.
8. **Operational gates**: custom domain and TLS, Sites-to-API HMAC/replay,
   Railway health/restart policy, queue heartbeat, spend alerts, PITR restore,
   retention job, and owner allowlist.

Recommended commands for the offline portion:

```sh
pnpm lint
pnpm build
pnpm test
pnpm qa:scenarios:check
pnpm test:e2e
```

Provider-backed commands require explicit owner approval and must use staging:

```sh
pnpm benchmark:export -- prepare ...
pnpm benchmark:export -- finalize ...
pnpm benchmark -- benchmark-artifact.json
pnpm smoke:apple
pnpm smoke:hosted
```

## Current automated traceability

This table records what the deterministic suite actually proves. `Partial`
means the remaining criteria require a frozen provider tape, independently
reviewed holdout, or live Apple/operations evidence; it is not a passing claim.

| Story | Automated evidence | Status after 2026-07-16 sweep |
| --- | --- | --- |
| US-01 | Guided-flow, idempotency, refresh/cancel, mobile and failure browser tests | Automated complete |
| US-02 | 1–300 policy tests plus 50/100/200 exact-count browser flows and shortfall failure | Automated complete; live count canary pending |
| US-03 | Similarity-policy corpus including punctuation and numeric artist names | Automated complete; provider relevance pending |
| US-04 | Reference-artist/version protections and fail-closed matching fixtures | Partial: arbitrary artist/era/label exclusions and per-artist/per-album caps need hostile candidate tapes |
| US-05 | Stored ambiguity integrity and guided-answer immutability | Partial: named Air/X/Phoenix/Berlin/Jungle entity fixtures and fail-before-candidate-research evidence pending |
| US-06 | Citation, evidence binding, frontier, pagination, provenance and unsupported-expansion tests | Partial: provider-backed factual holdouts pending |
| US-07 | Apple matching ladder, version, identity, ambiguity, recovery and shortfall tests | Automated complete; US storefront live sample pending |
| US-08 | Deterministic sequencing/property tests | Automated complete |
| US-09 | Immutable manifest, batch/prefix reconciliation, divergence and UI publication tests | Partial: stable share URL and cross-account Add to Library pending |
| US-10 | Database-backed leases, retry, capability and authorization-state tests | Partial: real token persistence/reauthorization canary pending |
| US-11 | Owner allowlist, cost ledger, feedback privacy, upload and owner-inbox browser tests | Automated complete |
| US-12 | Public-directory story and schema | Pending: repository/API/UI implementation and privacy tests are not yet present |

## Exit criteria and evidence

- Every offline command passes from a clean checkout on the supported Node and
  pnpm versions.
- Every story marked automated complete above has at least one positive case
  and one negative or failure case. Partial and pending stories remain release
  gates until their named evidence exists.
- Every previously observed production attempt is represented by a redacted
  deterministic scenario and every new failure class has a focused assertion.
- No exact-count canary completes short, and no unsupported exhaustive claim is
  represented as verified.
- Auto-match precision is at least 99.5% on the independently attested factual
  sample; at least 95% of storefront-available rows are auto-matched or safely
  resolvable through review.
- Published membership and order equal the locked manifest exactly.
- Cost and active duration remain within size-tier policy; overruns fail closed
  and remain visible to the owner.
- All live-only gates have dated screenshots/logs, owner identity, storefront,
  playlist IDs, share URLs, and cleanup disposition.

## Known gaps this contract does not hide

1. The fixed-count public surface and true exhaustive mode are different
   products. A size-controlled “every” prompt currently becomes curated. If
   visitors must run unbounded source-frontier research, the product needs an
   explicit deep-research route and separate budget/latency UX.
2. The current frozen Paulinho sample covers 56 evidence-backed tracks, not a
   6,000-credit career. The esoteric scenarios also need independent human
   holdouts before factual recall/relevance can become a release gate.
3. Offline Apple fixtures cannot prove US availability, public visibility, or
   second-account Add to Library. Those remain mandatory live gates.
4. A provider-backed esoteric prompt can legitimately fail when evidence is
   insufficient. The release requirement is transparent failure with no
   invented or off-scope filler, not guaranteed hallucinated completion.
5. The historical production fixture is a point-in-time export. Release QA must
   continue promoting every newly observed prompt and failure class after
   redaction.
6. Generic artist/era/label exclusions and per-artist/per-album caps do not yet
   have adversarial candidate-tape enforcement coverage. Reference-artist and
   Apple-version exclusions are covered; the broader US-04 contract remains a
   pending gate.
7. Prompt-specific ambiguity quality is still model-mediated. The suite proves
   guided-answer immutability and safe flow mechanics, not that Air, X,
   Phoenix, Berlin, Jungle, or a misspelled name will always receive the ideal
   entity question.
8. The public playlist directory is a planned story, not a shipped surface in
   this release candidate.
