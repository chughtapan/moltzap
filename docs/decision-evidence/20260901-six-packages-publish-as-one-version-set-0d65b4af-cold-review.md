# Blind decision review record

Blind review of `docs/decisions/20260901-six-packages-publish-as-one-version-set.md`
at candidate commit `0d65b4af`, run per the `cold-read` skill in
repository-scoped (`--questions`) mode. The reviewer received a detached
checkout of the frozen candidate, the candidate path, and the six fixed
questions from `.claude/skills/cold-read/references/questions.md`, with the
quarantine rule and an instruction to exclude review artifacts from every
recursive search; nothing else from the author. Answers below are the
reviewer's, verbatim.

Isolation note. In-process Claude Code subagents inherit the dispatching
session's project instructions and memory index (runs 1 and 2 on this
record), and a `codex exec` process renders the checkout's own `AGENTS.md`
into its context before the first command (run 4). This run therefore
deviates from the `cold-read` skill's `Agent` dispatch: the reviewer is a
separate `codex exec` process (read-only sandbox, `-C /tmp/blind-0d65b4af`,
medium reasoning, 15-minute hard timeout) started with
`project_doc_max_bytes=0`, whose working directory and context lie outside
the parent project, so no project `CLAUDE.md`, `AGENTS.md`, memory index, or
session state reaches it before navigation. The reviewer confirms below that
only generic platform instructions and a plugin catalog arrived, neither
naming the candidate or the project.

## Review identity

| Field | Value |
|---|---|
| Review run ID | `20260901-six-packages-publish-as-one-version-set-0d65b4af-cold-review` |
| Candidate commit | `0d65b4aff14983edbe6cafe15bc5520137e51ad9` |
| Candidate tree | `c287dedc94f820f4a87c9f8b89b2f253e3fb5ba1` |
| Candidate content digest | sha256 `3576716965bc7d7ccd375fb16ef0f05d3e191d7d3c2e95df4f475b8757a4b269` (record); sha256 `aa7acad01ff38e19a8d70af14f6184eb350b4ae65350b60a5dd7d974341069ce` (trajectory) |
| Digest scope and command | `git worktree add --detach /tmp/blind-0d65b4af 0d65b4aff14983edbe6cafe15bc5520137e51ad9 && sha256sum docs/decisions/20260901-six-packages-publish-as-one-version-set.md docs/decision-evidence/20260901-publication-set-trajectory.md` |
| Reviewer | `codex exec` (codex-cli 0.152.0), `--sandbox read-only`, `model_reasoning_effort=medium`, `project_doc_max_bytes=0`; a separate process, not a Claude Code subagent |
| Reviewer session | fresh codex process started 2026-09-02T04:29:38Z with working directory `/tmp/blind-0d65b4af` (outside the parent project); prompt = checkout root, candidate path, the six questions, quarantine and search-exclusion rules, output schema |
| Review started | 2026-09-02T04:30:26Z |
| Review finished | 2026-09-02T04:32:34Z |
| Review duration | 00:02:08 (reviewer-reported; process wall clock 04:29:38Z to 04:35:47Z) |
| Review budget | one uninterrupted run under `timeout 900`; no mid-run interaction permitted |
| Rerun of | `20260901-six-packages-publish-as-one-version-set-979cecaa-invalid-review` |
| Rerun reason | Run 4 was invalidated by the harness rendering the checkout's `AGENTS.md` before navigation; its one observation (a stale final-gate sentence in `docs/architecture/first-implementation.md`) was corrected in `0d65b4af`. The record and trajectory digests are unchanged from `979cecaa`. |

## Fresh-context attestation

The reviewer attests (verbatim):

- [ ] I did not author or reconcile the candidate decision. I received unrelated inherited platform context, but no candidate-specific authorship or reconciliation context.
- [ ] I received no inherited conversation, summary, memory, private state, or earlier blind-review output about the candidate. An unrelated recommended-plugin catalog and generic platform instructions were present; neither contained candidate information and neither was used as evidence.
- [ ] I received only the clean candidate checkout and the fixed questions. Generic platform instructions and an unrelated recommended-plugin catalog were also present and were not used as evidence.
- [x] I received no out-of-band tour, decision or file pointer, search term, expected answer, or answer key.
- [x] I navigated the repository independently. I may have used checked-in entry points, repository-native indexes, ordinary search, and repository history after discovering them myself.
- [x] I did not open, read, or search the contents of an earlier cold-review or invalid-review record.
- [x] I did not ask the author for help or modify the candidate before submitting these answers.
- [x] The author interventions recorded below are complete.

Author's note on retention (not part of the reviewer's text): the three
unchecked lines each disclose the same thing, the codex harness's generic
platform instructions and its plugin catalog, which the reviewer states
contained no candidate or project information. The reviewer did not author
or reconcile the candidate; the first line appears unchecked only because
the reviewer attached that disclosure to it. Whether this disclosure leaves
the run valid is the maintainer's ruling below.

## Fixed questions and verbatim answers

The six questions live in `.claude/skills/cold-read/references/questions.md`.

### 1. What decision does this candidate make current, what problem does it resolve, and which statements are binding versus context or non-normative explanation?

Answer: The accepted outcome makes six packages public on npm as one coordinated calendar-version set: `@moltzap/identity`, `@moltzap/router`, `@moltzap/client`, `@moltzap/openclaw-channel`, `@moltzap/nanoclaw-channel`, and `@moltzap/simulator`; `@moltzap/evals` remains private and the record adds no other package. Every release uses `YYYY.MDD.N`, where `N` is one past the highest same-day counter in the union of all six npm histories and existing `v<version>` release tags. Packed workspace dependencies pin siblings to that exact version. Package versions remain independent of `MOLTZAP_VERSION`, MCP revision, and persisted-schema versions.

It resolves the inability to install the simulator's private dependency closure from npm, the disabled release path, inconsistent publication/version policy, stale v1 registry names, inconsistent licenses, and the retired `v2/` authority residue. The outcome also fixes the release path, Apache-2.0 licensing, legacy deprecations, and `v2/` retirement.

Under `docs/decisions/README.md` → Canonical reading guidance, the frontmatter status is authoritative and an accepted record's Decision Outcome remains current. Therefore the candidate's `Decision Outcome`, including its Publication set, One version, Release path, License, Deprecations, Retired directory, and current-resolution statement, is binding. `Context and Problem Statement`, `Consequences`, implementation examples, and `Record changelog` are explanatory or historical rather than independent normative owners. The linked trajectory explicitly declares itself non-normative.

Independently discovered paths and headings: `docs/decisions/20260901-six-packages-publish-as-one-version-set.md` → Context and Problem Statement; Decision Outcome; Publication set; One version; Release path; License; Deprecations; Retired directory; What this record resolves; Consequences; Record changelog; `docs/decisions/README.md` → Canonical reading guidance; `docs/decision-evidence/20260901-publication-set-trajectory.md` → Publication set decision trajectory

### 2. What earlier outcomes does it replace, retain, or leave untouched, and where does the current normative contract live?

Answer: It resolves `G1-DEC-708`, the publication/version-namespace portion of `G1-DEC-709`, and the publication/versioning portion of `G1-DEC-814` in the four-layer record. It also closes the publication deferrals in `20260729-v2-authority-lives-with-v2.md` and `20260728-six-deep-packages-one-version.md`.

It replaces the older shared-six-package rule that coupled product package CalVer and wire compatibility through `v2/VERSION`, along with the old six-package map, `@moltzap/v2-*` naming, old dependency DAG, and publication deferral. It retains deep package ownership, the prohibition on production dependencies upon simulator/evals, independent MCP and persisted-schema versions, the seven-package dependency graph, public boundaries, layer contracts, and every other outcome of the cited records. External-consumer cutover remains untouched and unresolved.

The authority order is `AGENTS.md` and `docs/vision.md`; current ADR outcomes; normative `docs/spec/`; architecture material; then historical evidence. The accepted ADR owns the current decision outcome, while `docs/spec/layer-interfaces.md` → Publication and versions is expressly named as the normative owner of the operative package/publication/version contract. The four-layer traceability rows point to those two locations. The older records' visible Supersession sections explain which portions remain current.

Independently discovered paths and headings: `AGENTS.md` → Docs; `docs/spec/README.md` → Authority and reading order; `docs/spec/layer-interfaces.md` → Publication and versions; Deliberate deferrals; `docs/decisions/20260811-four-layer-endpoint-replicated-harness.md` → Supersession; Gate 1 traceability disposition; `docs/decisions/20260728-six-deep-packages-one-version.md` → Supersession; `docs/decisions/20260729-v2-authority-lives-with-v2.md` → Supersession

### 3. What must an implementer now do or avoid, which layers or consumers are affected, and under what fault, trust, safety, liveness, and compatibility assumptions?

Answer: An implementer must keep exactly the six named packages public and at one release version, keep evals private, exact-pin packed workspace siblings, and prevent any unselected package from joining the set. Releases must be manual, serialized, main-tip runs through `.github/workflows/publish.yml`. A bump must compute the collision-free UTC CalVer, stamp all six manifests, build, run the four packed-closure gates, push or safely reuse the three source-revision-specific images, record their digests, regenerate docs, stamp the changelog, create and atomically push the release commit/tag, then publish each missing npm package with provenance. Resumption must use the release commit's tree and skip already-published packages. `start_new_version` may abandon an incomplete release and mint from current main. Implementers must not couple package version changes to wire, MCP, or schema versions; publish evals; restore `v2/`; relicense old releases; add compatibility facades; or silently mix releases.

Affected consumers are all six public packages, the private evals workspace product, downstream simulator installers, the simulator controller/OpenClaw/NanoClaw image consumers, npm users encountering retired v1 names, generated documentation, changelog readers, and release operators. The underlying Identity, Communication/Router, Client/task/trust, adapter, Simulator, and eval layer contracts remain unchanged.

Fault/liveness handling is explicit for the release system: npm 404 means absence, other registry failures abort; partial npm publication is resumed; existing same-version/same-source images are reused; a later UTC day before a release commit mints a new version; a committed partial release remains the resumption point unless explicitly abandoned. Only one release may run at a time and main moving past the dispatch aborts the run.

Trust and safety assumptions are: GitHub OIDC/WIF admits only `publish.yml` on `main`; the GCP release service account may write the image repository; npm uses trusted publishing and provenance; only the release App private key is stored; the App performs the one contents push; packed-install gates prove exact sibling pins and declared executables; architecture checks pin publication membership, privacy, and version equality. Compatibility assumes package version conveys no wire, MCP, or persisted-schema compatibility fact. Old manifests retain their original license, old API/cutover releases are deprecated rather than changed, and external-consumer cutover remains unresolved.

Independently discovered paths and headings: `docs/decisions/20260901-six-packages-publish-as-one-version-set.md` → Publication set; One version; Release path; License; Deprecations; Consequences; `.github/workflows/publish.yml` → Publish to npm workflow; `scripts/release/compute-next-version.sh` → file header and implementation; `scripts/architecture/check-boundaries.js` → FINAL_PACKAGES and release checks; `packages/simulator/gke/terraform/main.tf` → GitHub Actions Workload Identity resources; `docs/spec/layer-interfaces.md` → Exact package graph; Cross-layer laws; Publication and versions

### 4. Which humans are named as decision-makers, which source events does the compacted trajectory cite for their calls, alternatives, reversals, and deferrals, and what source gaps does it explicitly record?

Answer: The candidate names Tapan Chugh as the sole decision-maker. The trajectory's source records retain only actor roles (`user` or `assistant`) and call the respondent "the maintainer"; they do not independently attach the human name to a transcript identity.

The event ledger states:

- Event 1: a `user` requested simulator npm distribution.
- Event 2: an `assistant` offered three publication alternatives—six-package simulator closure with one version, simulator/channels only with bundling, or continued deferral—and two `v2/` alternatives—retire it or retain it.
- Event 3: the `user` selected the six-package one-version closure and retirement of `v2/`.
- Event 4: an `assistant` offered MIT versus Apache-2.0, exact versus subset ledger compatibility, and four housekeeping selections.
- Event 5: the `user` selected Apache-2.0, exact ledger equality, changelog reset, uncited-input deletion, GKE namespace deletion, and deprecation of old simulator/OpenClaw releases. The ledger marks ledger compatibility as outside this record.
- Event 6: an `assistant` offered release-built Artifact Registry images with recorded digests, a manual digest table, or GHCR.
- Event 7: the `user` selected workflow-built/pushed images with recorded digests.
- Event 8: an `assistant` offered alternatives for initial manifest alignment, manual versus gated push triggering, convergent release ordering, and split versus atomic delivery.
- Event 9: the `user` selected manifest alignment at `2026.811.0`, manual workflow dispatch, fixed convergent ordering, and one atomic PR. The last selection chose option B rather than the offered recommended option A; the ledger records no separate reversal event.

Explicit gaps are: no source event gives a reason for the publication-set or `v2/` selections; no source event gives a reason for the license selection; no source event selects the pre-record `@moltzap/client` deprecation, whose only attribution is admission by the named decision-maker; no source event selects or discusses the retained external-consumer cutover deferral; and no source event gives a reason for the D9 atomic-PR selection beyond the question text. Hidden reasoning, tool payloads, credentials, account identifiers, and unrelated session topics were intentionally not retained.

Independently discovered paths and headings: `docs/decisions/20260901-six-packages-publish-as-one-version-set.md` → frontmatter; `docs/decision-evidence/20260901-publication-set-trajectory.md` → Source scope and gaps; Publication set and version policy, Events 1–3; License and housekeeping, Events 4–5; Release mechanics, Events 6–9; Mechanical repository and registry effects

### 5. Find the strongest apparent contradiction, stale instruction, or broken lineage elsewhere in the repository. Resolve it using the authority order or report it as a blocker.

Answer: The strongest apparent contradiction is the historical outcome in `docs/decisions/20260728-six-deep-packages-one-version.md`: it requires one CalVer in `v2/VERSION` to match six old package manifests and MoltZap wire compatibility. The current decision instead publishes six packages from a seven-package workspace, deletes `v2/VERSION`, and makes npm package versions independent of `MOLTZAP_VERSION`.

This is resolved, not a blocker. The older record is `partially-superseded`; its visible Supersession section says the old package names, `v2/VERSION`, shared six-package CalVer rule, wire coupling, and dependency DAG were replaced. It explicitly points publication/version policy to the accepted candidate and the package map to the four-layer replacement and `docs/spec/layer-interfaces.md`. Under the repository's authority order and status rules, the visible retained scope and accepted replacement govern over the historical Decision Outcome. The current implementation agrees: all six public manifests are `2026.811.0`, `MOLTZAP_VERSION` is independently `2026.827.1`, and `v2/` is absent.

Independently discovered paths and headings: `docs/decisions/20260728-six-deep-packages-one-version.md` → Supersession; Decision Outcome; `docs/decisions/README.md` → Canonical reading guidance; `docs/spec/README.md` → Authority and reading order; Version namespaces; `packages/identity/src/version.ts` → MOLTZAP_VERSION; `packages/*/package.json` → version/private/license fields

### 6. Could a teammate implement the decision without chat or guessing? List every missing link or unresolved choice and classify each as a deliberate deferral or an accidental gap.

Answer: Yes for repository implementation: the candidate, normative publication section, workflow, version script, architecture guard, pack gates, Terraform outputs, and operator documentation provide the package set, version algorithm, execution order, retry behavior, trust boundary, external-variable mapping, image handling, and exact legacy deprecation commands.

The remaining items are:

- External-consumer cutover — deliberate deferral. No eighth package, compatibility facade, or removed Simulator contract is authorized meanwhile.
- Push-triggered publishing — deliberate deferral until the manual path proves the prerequisites.
- npm trusted-publisher configuration, release App ID/private key, release-environment review configuration, and the three Terraform-derived repository variables — external operational prerequisites, explicitly identified rather than unresolved design choices. Their live values are not discoverable from the repository.
- Reasons for the publication-set, `v2/` retirement, license, and atomic-PR selections — accidental provenance gaps explicitly recorded by the ledger; they do not leave the selected implementation ambiguous.
- Source-event selection for deprecating pre-record `@moltzap/client` releases — accidental provenance gap explicitly recorded. The accepted record and operator commands still make the required action discoverable.
- Source-event selection or discussion for retaining the external-consumer deferral — accidental provenance gap attached to a deliberate deferral; the current contract still clearly says it remains unresolved.
- The primary Claude Code session is identified by session ID and event UUIDs but is not checked into the repository — verification-access gap. The compacted ledger contains the retained literal excerpts and native locators, so no implementation choice depends on accessing that session.

No unresolved repository design choice requires chat or an author hint.

Independently discovered paths and headings: `docs/decisions/20260901-six-packages-publish-as-one-version-set.md` → Release path; Consequences; `docs/spec/layer-interfaces.md` → Publication and versions; Deliberate deferrals; `.github/workflows/publish.yml` → workflow inputs and steps; `packages/simulator/gke/README.md` → release prerequisites and deprecation commands; `packages/simulator/gke/terraform/outputs.tf` → release outputs; `docs/decision-evidence/20260901-publication-set-trajectory.md` → Source scope and gaps; Release mechanics

## Discovery trail

| Order | Entry point, search, or navigation step | Path and heading discovered | Result |
|---:|---|---|---|
| 1 | Recorded UTC start, commit/tree, candidate digest, and enumerated repository files with quarantine exclusions | Repository root | Established identity and candidate location without opening quarantined files. |
| 2 | Read the checked-in repository entry instructions | `AGENTS.md` → Project; Decisions; Docs | Found package summary, authority order, and decision/evidence navigation rules. |
| 3 | Enumerated `docs/` while excluding `*-cold-review.md` and `*-invalid-review.md` | `docs/decisions/`, `docs/decision-evidence/`, `docs/spec/` | Found decision index, candidate, trajectory, predecessors, and normative spec. |
| 4 | Read the candidate from top to bottom | `docs/decisions/20260901-six-packages-publish-as-one-version-set.md` → all headings | Extracted status, outcome, mechanics, lineage, consequences, and explicit deferrals. |
| 5 | Followed only the candidate's provenance link | `docs/decision-evidence/20260901-publication-set-trajectory.md` → all headings | Recovered source events, alternatives, selections, mechanical observations, and explicit gaps. |
| 6 | Followed the named normative owner | `docs/spec/layer-interfaces.md` → Publication and versions; Deliberate deferrals | Confirmed package set, version namespace, enforcement, and remaining deferral. |
| 7 | Followed the three cited predecessor records | `20260728-six-deep-packages-one-version.md`; `20260729-v2-authority-lives-with-v2.md`; `20260811-four-layer-endpoint-replicated-harness.md` → Supersession/traceability | Confirmed replacement, retention, untouched scope, and trace-row dispositions. |
| 8 | Inspected implementation surfaces named by the candidate | `.github/workflows/publish.yml`; `scripts/release/compute-next-version.sh`; `scripts/architecture/check-boundaries.js` | Confirmed manual main-only serialized publishing, counter computation, exact set/version guards, and retry behavior. |
| 9 | Inspected manifests and release trust/configuration | `packages/*/package.json`; `packages/simulator/gke/terraform/main.tf`; `packages/simulator/gke/README.md` | Confirmed six public equal-version packages, private evals, Apache-2.0, WIF restriction, prerequisites, and deprecation commands. |
| 10 | Broad repository search for publication/version references | Repository-wide ordinary search with quarantine exclusions | Found consistent current documentation; one invocation included ineffective git-style exclusion arguments and produced noisy allowed results, so those noisy results were not used as evidence. |
| 11 | Checked repository history and cited commit objects | Candidate/spec/trajectory history; ledger-cited commit IDs | Confirmed cited commit objects exist and candidate corrections are present. |
| 12 | Checked the strongest historical contradiction against current files | Old six-package ADR; current manifests; Identity version owner; absence of `v2/` | Resolved the apparent wire/package-version conflict through explicit supersession and current authority. |
| 13 | Recorded UTC finish and repeated identity/digest checks | Repository root and candidate | Finished with unchanged commit, tree, and digest. |

## Author interventions

| Time | Intervention | Effect on review |
|---|---|---|
| before review | Generic platform instructions and an unrelated recommended-plugin catalog were present in inherited context | Disclosed as non-candidate context; contained no project decision facts and was not used as evidence. |
| none | No author hint, file tour, expected answer, candidate-specific summary, or quarantined review output was supplied | No effect on navigation or findings. |

## Blockers

| ID | Finding | Evidence | Required reconciliation |
|---|---|---|---|
| none | No unresolved authority contradiction or implementation-blocking choice found | Accepted candidate; explicit predecessor Supersession sections; `docs/spec/layer-interfaces.md` → Publication and versions; matching workflow/manifests/guards | none |

## Overall result

Result: **PASS**

Rationale (reviewer, verbatim): All six answers are independently discoverable and consistent across accepted status, supersession lineage, authority order, normative ownership, implementation, trust/fault handling, compatibility namespaces, and source-event attribution. The repository explicitly records its provenance gaps and deliberate deferrals without requiring an invented binding choice or author hint. The strongest stale historical instruction is fully resolved by visible supersession and current normative sources.

## Maintainer acceptance

The reviewer result is evidence, not self-certifying acceptance. The
maintainer verifies that it applies to the exact candidate identity
above and records the gate decision, including whether the reviewer's
disclosure of generic platform instructions leaves the run valid.

| Field | Value |
|---|---|
| Maintainer | `_fill_` |
| Reviewed result | `20260901-six-packages-publish-as-one-version-set-0d65b4af-cold-review` |
| Candidate identity matches | `_yes or no_` |
| Gate decision | `_ACCEPTED or REJECTED_` |
| Decision time | `_fill ISO 8601 timestamp_` |
| Rationale | `_fill_` |

## Rerun identity

| Field | Value |
|---|---|
| Superseded by review run | `_none_` |
| Superseded candidate commit | `_none_` |
| Superseded candidate content digest | `_none_` |
| Reason a rerun was required | `_none_` |
