# Pipeline V2 manifest-only shadow rollout

Pipeline V2 shadow comparisons stop at immutable manifest generation. They do
not authorize Apple Music, create playlists, append tracks, poll share links,
or enqueue publication. This lets owner canaries compare V1 and V2 without
creating duplicate Apple playlists.

## Security boundary

`server/pipeline-v2-shadow.ts` is a pure synchronous module. Its exact input
schema contains only immutable candidate-pool data. It imports neither the
repository nor Apple, OpenAI, or publisher modules. Unknown top-level, pool,
and candidate fields fail closed, including an accidentally injected publisher
or Apple user token.

The owner-only CLI reads one local JSON artifact and writes one JSON report to
stdout:

```bash
pnpm qa:shadow:v2 -- --input /private/path/to/shadow-candidate-pools.json
```

For independently persisted run exports, the automated paired-artifact mode
first proves both artifacts share the exact prompt hash, selection-plan hash,
storefront, and target, then runs the same manifest-only comparison:

```bash
pnpm qa:shadow:v2 -- \
  --primary-artifact /private/path/to/v1-run.json \
  --shadow-artifact /private/path/to/v2-run.json \
  --comparison-id owner-canary-001
```

Any input mismatch, unknown field, unsafe selected V2 row, duplicate identity,
or injected write capability fails closed before a report is produced.

It has no database or network dependency. The report always says:

- `executionMode: "manifest_only"`;
- `publicationCapability: "absent"`;
- `releaseDisposition: "independent_review_required"`.

The last field is intentional. Track-count and overlap comparisons cannot
replace the independent relevance and hard-constraint review required by the
Pipeline V2 release benchmark.

## Input workflow

For each frozen scenario and pinned model route:

1. Run V1 normally through matching, but stop before publication and export its
   ranked candidate pool.
2. Run V2 from the same immutable prompt, target, storefront, and policy
   snapshot in an isolated owner canary. Disable publication queue creation and
   export its ranked candidate pool after matching and sequencing.
3. Mark only the rows selected for the proposed manifest with
   `includeInManifest: true`.
4. For every V2 selected row, export the persisted evidence, hard-constraint,
   version, and storefront-playability decisions. At least one exact
   `scopeBindingId` is required.
5. Evaluate the two pools with `qa:shadow:v2` and retain the content-hashed
   report with the canary artifacts.
6. Independently adjudicate the V2 manifest and run `pnpm benchmark:v2`. Never
   increase rollout traffic from a shadow report alone.

The comparison rejects an over-target manifest, duplicate Apple identity,
duplicate recording family, or an unsafe selected V2 row. Empty and partial
manifests remain valid diagnostic outcomes rather than system errors.

## Promotion checklist

- The V1 and V2 pools came from the same prompt hash, storefront, and requested
  target.
- Both manifests have stable content hashes.
- V2 has no unsafe selected row and 100% scope-binding coverage.
- No Apple playlist was created by the shadow path.
- The independent benchmark artifact passes the frozen release gate.
- Public rollout remains sticky and independently gated from factual V2.

The unit suite reads the shadow module source and asserts that no Apple,
publisher, repository, or OpenAI dependency is imported. It also spies on
`fetch`, injects hostile write-capability fields, and verifies that zero network
or publication calls occur.
