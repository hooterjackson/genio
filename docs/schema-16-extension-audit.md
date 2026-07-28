# Schema 16 extension audit

Status: historical design input for release 2.3.0. Do not use this document as
the current deployment contract. The implementation has advanced through the
expand-only schema-18 recovery foundation, worker protocol 10, brief contract
3, and query-plan schema 4 in migrations `0016_playlist_contract_foundation.sql`
and `0017_playlist_recovery_foundation.sql`. The remainder below preserves the
schema-16 review rationale for audit history.

## Existing systems to extend

### Guidance and immutable execution contracts

- `brief_requests` already owns the mutable pre-run prompt, questions, answers, scout hints and telemetry, derived preferences, answer idempotency key/hash, legacy brief JSON, and preliminary selection plan.
- `research_runs` already carries the accepted brief, guidance context, selected pipeline/policy, execution policy snapshot, and outcome.
- `run_specs` is the immutable request boundary for raw prompt, exact requested count, storefront, accepted guidance answers and source hints, pipeline/policy, and spec hash. The Drizzle declaration previously omitted the physical `guidance_source_hints_json` column created by migration 0013; release 2.2.2 corrects that declaration without changing storage.
- `selection_plans` and `query_plan_revisions` already provide append-only, content-addressed revisions. `run_active_query_plans` is the only active pointer.
- `job_queue` already persists pipeline and minimum-protocol fences. The schema-15 trigger knows pipeline minimums, while the repository adds the schema-2/protocol-8 fence at lease time.

Schema 16 should therefore normalize question-set and answer-set revisions around these records. It must not introduce a second brief, run-spec, selection-plan, or query-plan system.

### Pipeline diagnostics and source attempts

- `candidate_stage_events`, `pipeline_deficit_ledger`, and `pipeline_outcomes` already record candidate movement, deficits, stop state, and final outcome.
- `source_records`, `source_frontier`, `research_containers`, `track_scope_bindings`, `citation_attestations`, and `evidence_claims` already represent run-local discovery and evidence.
- `apple_catalog_cache_events`, catalog matches, recording families, manifest revisions, and publication records already represent the Apple and publication funnel.
- Cost ledger and reservations already own provider cost accounting; new public diagnostics must never expose them.

Schema 16 should add deduplicated summaries and attempt observations linked to these records. It must not copy evidence claims, source pages, Apple identities, or manifest state into metric tables.

### Feedback, automatic failures, and retention

- Manual feedback and automatic terminal-failure reports currently share the `settings` namespace under separate keyed records. Automatic reports already bypass visitor quotas, omit screenshots, redact credential/email patterns, use an idempotent event fingerprint, attach a quarantined QA scenario, and are removed with the originating run access, run, brief, or 90-day detailed-data cutoff.
- `audit_events` captures automatic-report creation/suppression and owner actions.
- `runRetentionSweep`, `deleteRunAccess`, `deleteBriefRequest`, and `purgeRunToTombstone` are the established deletion barriers. `retention_tombstones` intentionally retains only publication and aggregate outcome facts.

Schema 16 should normalize automatic quality incidents while leaving manual feedback in its existing store. The normalized incident occurrence becomes the authoritative automatic record; the owner inbox may project both stores during transition. Do not permanently dual-write two independent automatic-report records.

### Governed corpus and evidence graph

- `corpus_source_documents` already captures immutable source revisions plus provenance, authority, licensing, cache/retention/freshness policy, approval, and takedown state.
- Quarantined observations, promoted assertions, assertion evidence, catalog identities, locked graph snapshots, and run-to-corpus links already exist.
- Run-local sources, recording families, catalog identities, citations, claims, containers, and scope bindings already exist separately from the durable corpus.

Source-policy revisions, frozen container revisions/members, member attestations, snapshot-to-container membership, and evidence-recovery audits belong to schema 17. They must extend these corpus and run-local structures rather than appear in schema 16.

## Proposed schema-16 expansion

All additions are expand-only. Existing rows remain contract 1 and are never interpreted as contract 2.

### Contract version columns and active guidance pointer

Add `brief_contract_version integer NOT NULL DEFAULT 1` to `brief_requests`, `research_runs`, and `run_specs`, constrained to supported positive versions. Add nullable `active_guidance_question_set_id` to `brief_requests` only after the question-set table exists.

Contract-2 creation must persist version 2 before its brief job is queued. Copy the version unchanged into the run and immutable run spec. No update may reinterpret a contract-1 row.

### `guidance_question_sets`

Append-only revisions keyed by `brief_request_id`, revision, and immutable `question_set_hash`. Store request classification, generation mode, guidance-policy version, locale, storefront, target count, explicit-constraint hash, bounded rejected-question reasons, and the validated typed question JSON. Allow one active revision per brief through a partial unique index and an active pointer on `brief_requests`.

The immutable JSON contains stable question/option IDs, single/multi-select behavior, criticality, exactly three choices, custom-answer permission, explanation, grounding or inference label, feasibility, and the server-owned typed `PlanDelta` for each option. It never stores raw evidence pages.

### `guidance_answer_sets`

Append-only accepted submissions linked to the exact question-set revision/hash. Store normalized typed answers, separately bounded raw custom text, answer hash, execution-delta JSON/hash, resulting selection/query revision IDs when compiled, idempotency key, and acceptance time. Enforce one payload per brief/idempotency key and require a nonempty delta for every accepted answer.

Deletion of a brief cascades its question/answer revisions. Deletion of a run removes the immutable copied answer material through `run_specs`; anonymous aggregates remain separate.

### `run_stage_metric_summaries`

One row per run, query-plan revision, stage key, and metric revision. Use explicit nonnegative columns for provider rows, unique valid leads, requalification attempts, citation-bearing leads, exact-pair attestations, containers discovered/enumerated, scope-bound candidates, evidence-qualified candidates, Apple-resolution attempts, actual Apple provider requests, Apple matches, recording families, selected, reserve, manifested, and published counts.

Store stop reason, root cause, and downstream state as separate bounded enums/strings. A terminal summary is immutable; in-progress changes append or use a single controlled monotonic update path. Never derive “Apple degraded” when actual Apple provider requests are zero.

### `run_source_observations`

Append-only bounded records for actual source/provider attempts. Link to `research_runs` and optionally the existing `source_frontier`, `source_records`, `research_containers`, query-plan revision, and provider metric event. Store an idempotency key, allowed host/resource type, extraction method, attempt outcome, timestamps, and bounded counters. Store a locator hash rather than provider bodies or full pages; use the existing source record when an approved URL must be retained.

### `provider_metric_events` and `provider_metric_daily_aggregates`

`provider_metric_events` holds deduplicated run-local metric increments with an idempotency key, provider, operation, stage, metric name, nonnegative value, cache/request outcome, and timestamp. It contains no request/response body, token, IP bucket, network identifier, or cost visible to public projections.

Daily aggregates group provider/operation/metric counts without run or visitor identifiers. Detailed events follow the 90-day run-detail boundary; aggregates expire after 13 months.

### `quality_incident_groups` and `quality_incident_occurrences`

`quality_incident_groups` is the anonymous 13-month aggregate keyed by a server-derived incident signature. It stores bounded classification fields, first/last seen time, total and overflow counts, and owner QA-promotion state. It stores no prompt, source/run/access ID, provider body, or personal identifier.

`quality_incident_occurrences` is the 90-day detailed record linked to a group and exactly one retained run/access or brief source. Store plan revision, terminal outcome hash, stop reason, root cause, downstream state, redacted bounded diagnostics, and an occurrence idempotency key. Enforce one occurrence per source, plan revision, and terminal outcome hash. No screenshot column exists.

A daily counter/partial unique key enforces the detailed-record ceiling. Overflow increments the anonymous group/daily aggregate without inserting detailed content. Source deletion cascades or explicitly removes occurrences before deleting the source; group counts remain anonymous. Only the owner promotion flow can create a permanent checked-in QA fixture.

## Protocol fencing changes for migration 0015

Update the existing job stamp trigger rather than adding a competing trigger. Its effective minimum is the greatest of:

- the historical pipeline minimum (4, 5, or 6);
- protocol 8 for query-plan schema 2;
- protocol 9 for brief contract 2; and
- protocol 9 for query-plan schema 3 or any later unsupported schema.

Mirror the same rules in repository enqueue and lease checks. Protocol-9 workers continue leasing historical protocol-4/5/6/8 work. Protocol-8 workers remain healthy during the 2.2.2 bridge but can never lease a contract-2 or schema-3 job.

## Required migration and deletion tests

- Upgrade populated schema 15 to 16 twice; verify idempotency and no V1/V2/V3 row changes.
- Verify legacy brief/run/spec rows read as contract 1 and schema 16 remains readable by the 2.2.2 bridge.
- Verify question/answer sets are append-only, stale hashes return the active set, repeated submissions are idempotent, and answer ordering does not change the execution-delta hash.
- Verify protocol 8 drains old schema-2 work but cannot lease contract-2/schema-3 jobs; protocol 9 drains both old and new work.
- Verify source observations and provider events deduplicate retries and never persist provider bodies or sensitive identifiers.
- Verify incident occurrence deduplication, daily overflow aggregation, 90-day detail deletion, 13-month aggregate deletion, source-access deletion, run deletion, brief deletion, and owner-only QA promotion.
- Verify existing automatic failure and manual feedback retention behavior remains intact during the transition.

## Activation order

1. Deploy protocol-9 binaries that support schemas 13–16 while schema 15 remains preferred.
2. Apply migration 0015 with contract-2 emission and all new capture paths disabled.
3. Confirm API, interactive worker, and deep worker heartbeats report protocol 9 and schema-16 compatibility.
4. Enable owner-only contract-2/query-plan-schema-3 canaries; keep factual and exhaustive assignment disabled.
5. Roll out sticky cohorts only after deterministic, database, responsive, no-write, incident-retention, and rollback tests pass.
