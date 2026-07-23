# Pipeline V2 release benchmark

Pipeline V2 does not graduate from an owner canary because a model returned a
plausible list. The release gate compares the pinned Luna and Terra routes on a
frozen suite and requires independent, track-by-track adjudication.

Before paid owner canaries create any Apple playlist, use the
[manifest-only shadow path](./pipeline-v2-shadow-rollout.md) to compare V1 and
V2 candidate pools. The shadow evaluator has no Apple publication capability;
its output is diagnostic and never substitutes for this independently reviewed
release gate.

## Frozen suite

The checked-in suite is
`tests/fixtures/pipeline-v2-release-benchmark-suite.json`. It covers:

| Scenario | Target | Gate |
| --- | ---: | --- |
| American drill | 25 | exact fill, US-scene and drill evidence |
| House music | 50 | exact fill, genre semantics rather than title keywords |
| Berlin techno | 100 | exact fill, Berlin-scene and techno evidence |
| French jazz | 200 | at least 90%, French/jazz scope and artist breadth |
| Global techno | 300 | at least 90%, individual recordings and influence evidence |

The 25/50/100 cases are catalog-rich exact-fill holdouts. The 200/300 cases
exercise bounded large-playlist behavior; a typed, transparent partial result
may pass only when it still reaches the frozen minimum ratio. No shortfall may
be represented as a system failure.

Do not edit the frozen suite to make a run pass. A substantive change requires
a new fixture version and a fresh evaluation of both model routes.

## Producing the reviewed artifact

Run every scenario once through the pinned Luna route and once through the
pinned Terra route in the US storefront. Export the persisted run, manifest,
cost-ledger hash, timestamps, track identities, recording families, and scope
binding IDs from Postgres. The results artifact must identify its source as
`postgres_export`; hand-authored cost, latency, or manifest data is not an
acceptable release artifact.

An independent reviewer must then inspect every published recording and fill:

- `catalogIdentityCorrect`: the Apple ID is the intended recording/version;
- `relevant`: the exact track satisfies the frozen request;
- `evidenceEligible`: stored track-scope evidence clears the frozen axis;
- `evidenceAxes`: every frozen evidence axis supported by those bindings;
- a non-empty review note;
- one whole-manifest review for every declared hard constraint.

The reviewer must accept this statement verbatim:

> I independently adjudicated every published recording and every declared hard constraint without using model output as ground truth.

Each adjudication is bound to the persisted run snapshot hash. The outer
artifact is also content-hashed. Missing rows, extra rows, duplicate identities,
stale suite hashes, edited run snapshots, missing model routes, or modified
attestation text fail closed. The evaluator has no synthetic or unchecked mode.

## Running the gate

```bash
pnpm benchmark:v2 -- --results /path/to/independently-reviewed-results.json
```

An alternate suite is accepted only when explicitly supplied:

```bash
pnpm benchmark:v2 -- \
  --suite /path/to/frozen-suite.json \
  --results /path/to/independently-reviewed-results.json
```

The command exits non-zero if neither model clears every release gate. When
both pass, it chooses the lower total actual cost. Equal-cost routes are broken
by aggregate p50 latency. The report includes per-run and aggregate:

- exact-fill behavior;
- catalog-identity claim eligibility (at least 600 independently reviewed,
  auto-accepted rows with zero observed identity errors; smaller samples may
  be reported but cannot support the 99.5% claim);
- independently adjudicated relevance precision (minimum 95%);
- evidence coverage and hard-constraint compliance (both 100%);
- persisted cost versus the size-tier ceiling;
- p50/p95 latency versus the frozen size-tier thresholds;
- the selected model tier and reason.

## What remains live and manual

The repository can validate a reviewed artifact, but it cannot truthfully
manufacture one. Before curated V2 traffic increases beyond the owner canary:

1. Run all ten paid production/staging canaries (five scenarios × two pinned
   model routes) against the owner US storefront.
2. Export the runs and cost ledger from Postgres with the release exporter.
3. Have an independent reviewer adjudicate every published track and hard
   constraint. A developer or model may prepare links, but may not supply the
   truth labels.
4. Run `pnpm benchmark:v2` and retain the artifact and report with the release.
5. Separately verify Apple public-link stability and second-account access.

The 200/300 timing percentiles have only two samples per model in this minimum
suite. They are a fail-closed release check, not a statistically strong latency
study. Production p50/p95 promotion decisions still require the rollout
telemetry described in the Pipeline V2 plan.
