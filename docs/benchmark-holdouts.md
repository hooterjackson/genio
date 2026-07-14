# Frozen acceptance holdouts

Frozen: 2026-07-14

These fixtures are expected results for staging evaluation, not research inputs. They were transcribed from the sources below without consulting Needle runtime output or the prior ChatGPT-generated song list. A future fixture change requires a new dated version, a human source review, and an explanation in the commit; staging output must never be used to fill a missing expected row.

## Paulinho da Costa

Status: a 56-track, evidence-backed sample. It is **not** an exhaustive lifetime catalogue.

Inclusion requires one of the following:

- Paulinho da Costa's official biography identifies the specific recording as one of his projects or percussion-driven successes.
- The individual Discografia Brasileira release page has a `Músicos` section for the exact track, and that section explicitly says `Paulinho da Costa : Percussão`.

The review excludes album-only credits, automatic whole-album expansion, inferred assignments, and records whose source warns that musicians were not identified by track. For example, *Ella Abraça Jobim* was deliberately excluded because its page says the original technical sheet did not specify musicians by track. Discogs and the prior conversation were not used.

| Source | Frozen rows | Why it qualifies |
| --- | ---: | --- |
| [Paulinho da Costa official biography](https://paulinho.com/about/) | 3 | The artist's own site names “We Are the World,” “All Night Long,” and “La Isla Bonita” as specific projects/successes. |
| [Sarah Vaughan — Brazilian Romance](https://discografia.discosdobrasil.com.br/discos/brazilian-romance) | 7 | Seven individual track musician sections name Da Costa on percussion; three other album tracks do not and are excluded. |
| [João Bosco — Na Onda Que Balança](https://discografia.discosdobrasil.com.br/discos/na-onda-que-balanca) | 12 | Twelve individual track musician sections name him; “Liberdade” does not and is excluded. |
| [Djavan — Lilás](https://discografia.discosdobrasil.com.br/discos/lilas-807) | 5 | Five individual track musician sections name him; the other four do not. |
| [Djavan — Não É Azul Mas É Mar](https://discografia.discosdobrasil.com.br/discos/nao-e-azul-mas-e-mar) | 7 | Seven individual track musician sections name him; the other three do not. |
| [Rita Lee and Roberto de Carvalho — Bombom](https://discografia.discosdobrasil.com.br/discos/bombom-1081) | 6 | Six individual track sections name him. The source explains that percussion is one of the roles it can distinguish by track despite other unspecified CD credits. |
| [Jorge Ben — Benjor](https://discografia.discosdobrasil.com.br/discos/benjor) | 5 | Five individual track musician sections name him; the other three do not. |
| [Rita Lee and Roberto de Carvalho — Rita e Roberto (1985)](https://discografia.discosdobrasil.com.br/discos/rita-e-roberto-1985) | 5 | Five individual track musician sections name him; the other four do not. |
| [RPM — RPM](https://discografia.discosdobrasil.com.br/discos/rpm) | 6 | Six individual track musician sections name him; the other four do not. |

Discografia Brasileira's [Paulinho da Costa musician index](https://discografia.discosdobrasil.com.br/musico/2) currently reports 189 songs across 34 releases. That figure is useful as a frontier lead, not as permission to freeze all 189 rows: every included row above was checked on its individual release page. Completing an independent career holdout remains blocked by the scale of the reported 6,000-plus song credits and by public liner notes that are absent, inaccessible, or only album-specific.

## Michael Jackson

Status: complete within an explicit 80-track adult Epic/MJJ album scope. It is not an all-career or all-version catalogue.

The scope is every unique original studio track in:

- *Off the Wall* (10)
- *Thriller* (9)
- *Bad* (11)
- *Dangerous* (14)
- the new-recordings disc of *HIStory: Past, Present and Future, Book I* (15)
- the five non-remix opening tracks on *Blood on the Dance Floor: HIStory in the Mix* (5)
- *Invincible* (16)

Sony/Epic Legacy's official [Indispensable Collection announcement](https://www.legacyrecordings.com/2013/07/02/new-michael-jackson-anthologies-the-indispensable-collection-and-the-ultimate-fan-extras-collection-available-now-exclusively-on-itunes-2/) enumerates this same core catalogue. The fixture also uses the label's dedicated pages for [Thriller](https://www.legacyrecordings.com/releases/thriller-picture-disc-nr/), [Bad](https://www.legacyrecordings.com/releases/bad-25th-anniversary-edition-2-cd-brilliant-box-wo-card/), [HIStory](https://www.legacyrecordings.com/releases/history-past-present-and-future-book-1-2-cd/), and [Invincible](https://www.legacyrecordings.com/releases/invincible/), plus the Michael Jackson Estate's official pages for [Dangerous](https://www.michaeljackson.com/albums/dangerous/) and [Blood on the Dance Floor](https://www.michaeljackson.com/albums/blood-on-the-dancefloor-history-in-the-mix/).

Excluded by design: Motown-era solo albums, Jackson 5/Jacksons releases, guest appearances, standalone singles, demos, language variants, remixes, live recordings, compilations, and posthumous albums. Those categories require separately confirmed scope and version rules before “every Michael Jackson song” can be evaluated as a broader claim.

## Maintenance and acceptance

- Preserve `artist` and `title`; the benchmark evaluator uses their normalized pair as the recovery key.
- Preserve a public HTTPS `source`, an `album`, an `evidenceType`, and a short `evidenceNote` on every row.
- Do not silently replace a source with an aggregator or model-generated URL.
- Passing the Paulinho holdout proves recovery of this independently frozen sample only. It does not prove an exhaustive career catalogue.
- Passing the Michael Jackson holdout proves complete recovery only inside the frozen 80-track scope.

## Attested staging export

The evaluator no longer accepts a hand-authored results object. Produce its input from the three locked staging runs in two steps:

```sh
pnpm benchmark:export -- prepare \
  --paulinho-run <uuid> \
  --michael-run <uuid> \
  --berlin-run <uuid> \
  --output benchmark-review.json
```

`prepare` opens one read-only, repeatable-read database snapshot. It verifies the US catalog-matching checkpoint, recomputes each manifest hash from its ordered tracks, and exports persisted candidate and initial/final match context. The review file contains a separate `attestation` section. The independent reviewer fills only:

- their name and review timestamp;
- availability, acceptable Apple catalog IDs, and a note for every factual candidate;
- the seven Berlin-techno scores and a written rationale for each score.

The exact factual and curated attestation statements must remain unchanged. Candidate, run, manifest, and snapshot identifiers must not be edited.

```sh
pnpm benchmark:export -- finalize \
  --review benchmark-review.json \
  --output benchmark-artifact.json

pnpm benchmark -- benchmark-artifact.json
```

`finalize` re-reads Postgres and fails on changed manifests or matches, missing or extra judgments, legacy matches without an immutable first decision, non-US storefronts, or unknown attestation fields. Tracks, citations, automatic-match status, correctness, and resolvability are derived by the exporter; reviewers cannot supply those result fields. The evaluator verifies the export schema, database provenance, attestation digest, and artifact digest before scoring. Matching acceptance also requires at least 100 factual candidates, so a tiny perfect sample cannot pass.

The detailed staging rows are removed by retention. Prepare, review, and finalize the artifact before the 90-day detail window closes.
