# Production-search regression QA

Every brief attempt is retained for 90 days, including requests that never
became a run, hit a budget gate, failed during research, or published only a
partial result. Visitor access to an unfinished brief still expires after 24
hours; that access expiry no longer deletes the operational record.

Before promoting a release:

1. Run `pnpm qa:scenarios:export` against production through a read-only
   database credential.
2. Keep the raw export private because it contains visitor prompt text.
3. Redact personal information and add every new attempt to
   `tests/fixtures/production-search-scenarios.json`.
4. Assign an explicit `expectedOutcome`, `replayProfile`, and every observed
   `failureClass` to the promoted case. Never promote only the prompt.
5. Add a focused assertion for any new failure class, not only the prompt.
6. Run `pnpm qa:scenarios:check`, `pnpm test`, `pnpm build`, `pnpm lint`, and the independent holdout
   benchmark.

The checked-in fixture began with all 25 brief attempts retained during the
first 2026-07-16 production audit and now also includes promoted visitor and
live-browser incidents through 2026-07-20. It records catalog shortfalls,
research under-yield, target truncation, and cost explosions as historical
failure classes. Each archived request is replayed through the current
fast-route policy against a frozen, deterministic provider tape.

The replay is a release contract, not a claim about live provider behavior. It
exercises:

- Multi-pass candidate generation when structured extraction returns only 85%
  to 90% of the requested candidates per pass.
- The real pre-match Apple matching reserve.
- Strict unique Apple matches and bounded recovery of retryable lookup
  failures.
- Up to three bounded post-match evidence-research refills when strict matching
  still leaves an exact-count shortfall, including their candidate yield,
  strict Apple yield, fixed cost ceiling, and immutable timing windows.
- Exact manifest and publication counts.
- Explicit outcome accounting for every candidate.
- The combined public preflight-and-research spend ceiling.
- The same immutable size-tiered research-and-matching windows used by the
  product: two minutes for 1–100 tracks, four for 101–200, and six for 201–300.

The replay calls the same post-match refill planner used by production. After
the bounded three-generation ceiling, a count shortfall publishes any safe
Apple matches as a typed partial result; it is never relabeled as a system
failure and never padded with weak matches. A release is blocked unless the
promoted Rio regression reproduces the observed 88 initial candidates and 42
strict matches, then reaches exactly 50 publishable tracks through the bounded
refill path.

## Exported observations

The private export includes both raw state and derived QA measurements:

- candidate count and candidate outcome totals;
- strict safe Apple match count and final catalog outcome totals;
- immutable manifest count, appended Apple count, and public-link count;
- total brief-plus-run ledger spend;
- research/matching job timestamps and active-work duration;
- candidate and catalog yield ratios; and
- a release assessment listing every violated gate.

Incomplete attempts remain in the export with a `null` assessment. A
completed 28-track result for a 50-track request is a release-quality
shortfall, not an exact success. It must retain a typed `partial` outcome and
publish the safe Apple matches it has; catalog or evidence scarcity must not
be classified as `failed_system`. The shortfall still blocks promotion when
the scenario's expected outcome is `exact_playlist`, while remaining a valid
transparent user result.

## Fixture review rules

- `expectedOutcome: "exact_playlist"` requires candidate yield at or above the
  requested count, enough strict matches, exact manifest and Apple counts,
  bounded spend and latency, and complete candidate accounting.
- `expectedOutcome: "explicit_failure"` is reserved for a human-reviewed case
  that should fail closed. It must never be used to excuse a regression in a
  previously supported request.
- A replay profile describes the adverse provider tape, not an observed
  success rate target. Keep historical stress rates when promoting a case.
- New failure classes require a negative gate test proving that the old
  behavior cannot be reported as successful.
- Deterministic replay supplements, but never replaces, the staging and live
  Apple canaries.
