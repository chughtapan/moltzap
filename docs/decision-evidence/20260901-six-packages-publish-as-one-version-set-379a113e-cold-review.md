# Blind decision review record

Blind review of `docs/decisions/20260901-six-packages-publish-as-one-version-set.md`
at candidate commit `379a113e`, run per the `cold-read` skill in
repository-scoped (`--questions`) mode. The reviewer received a detached
checkout of the frozen candidate, the candidate path, and the six fixed
questions from `.claude/skills/cold-read/references/questions.md`, with the
quarantine rule and an instruction to exclude review artifacts from every
recursive search; nothing else from the author. Answers below are the
reviewer's, verbatim.

Isolation note. The two earlier runs on this record were made by in-process
Claude Code subagents, which inherit the dispatching session's project
instructions and memory index whatever checkout they are pointed at; both
disclosed that context and the second was invalidated. This run therefore
deviates from the `cold-read` skill's `Agent` dispatch: the reviewer is a
separate `codex exec` process (read-only sandbox, `-C /tmp/blind-379a113e`,
medium reasoning, 15-minute hard timeout) whose working directory and
context lie outside the parent project, so no project `CLAUDE.md`, memory
index, or session state reaches it. The reviewer confirms below that only
generic harness operating instructions arrived.

## Review identity

| Field | Value |
|---|---|
| Review run ID | `20260901-six-packages-publish-as-one-version-set-379a113e-cold-review` |
| Candidate commit | `379a113e00f82ef70a4415511345752a2e8c501a` |
| Candidate tree | `ffc61cf5dd7f9c40d0fec0d2b9e602e5c9229761` |
| Candidate content digest | sha256 `5449a7ccde8c488cdf9cff80efa83011f232a834dd747a8e9bf35801ff4cfd6a` (record); sha256 `31483109b9668a324b7ee37961eb46397f95a4f154787cfdccfe5df052bfebe9` (trajectory) |
| Digest scope and command | `git worktree add --detach /tmp/blind-379a113e 379a113e00f82ef70a4415511345752a2e8c501a && sha256sum docs/decisions/20260901-six-packages-publish-as-one-version-set.md docs/decision-evidence/20260901-publication-set-trajectory.md` |
| Reviewer | `codex exec` (codex-cli 0.152.0), `--sandbox read-only`, `model_reasoning_effort=medium`; a separate process, not a Claude Code subagent |
| Reviewer session | fresh codex process started 2026-09-02T04:10:28Z with working directory `/tmp/blind-379a113e` (outside the parent project); prompt = checkout root, candidate path, the six questions, quarantine and search-exclusion rules, output schema |
| Review started | 2026-09-02T04:11:17Z |
| Review finished | 2026-09-02T04:12:39Z |
| Review duration | 00:01:22 (reviewer-reported; process wall clock 04:10:28Z to 04:12:35Z) |
| Review budget | one uninterrupted run under `timeout 900`; no mid-run interaction permitted |
| Rerun of | `20260901-six-packages-publish-as-one-version-set-81008c9a-invalid-review` |
| Rerun reason | Run 2 was invalidated by harness-injected context and a quarantine breach; its non-blocking wording corrections were applied in `379a113e` before this candidate was frozen. |

## Fresh-context attestation

The reviewer attests (verbatim):

- [x] I did not author or reconcile the candidate decision.
- [x] I received no inherited conversation, summary, memory, private state, or earlier blind-review output about the candidate.
- [x] I received only the clean candidate checkout and the fixed questions.
- [x] I received no out-of-band tour, decision or file pointer, search term, expected answer, or answer key.
- [x] I navigated the repository independently. I may have used checked-in entry points, repository-native indexes, ordinary search, and repository history after discovering them myself.
- [x] I did not open, read, or search the contents of an earlier cold-review or invalid-review record.
- [x] I did not ask the author for help or modify the candidate before submitting these answers.
- [x] The author interventions recorded below are complete.

## Fixed questions and verbatim answers

The six questions live in `.claude/skills/cold-read/references/questions.md`.

### 1. Current decision, resolved problem, and binding boundary

Answer: The accepted outcome makes six packages public on npm as one coordinated calendar-version set—`@moltzap/identity`, `@moltzap/router`, `@moltzap/client`, `@moltzap/openclaw-channel`, `@moltzap/nanoclaw-channel`, and `@moltzap/simulator`—while `@moltzap/evals` remains private. It resolves the previously deferred publication membership and version coordination that left the simulator's dependency closure unpublishable, the release workflow disabled, registry `latest` entries pointing at retired v1 surfaces, inconsistent licenses, and duplicate or uncited material under `v2/`. The accepted Decision Outcome and its Publication set, One version, Release path, License, Deprecations, Retired directory, and What this record resolves subsections are current ADR outcomes. Binding choices include exact sibling version pins, independence from wire/MCP/schema versions, the main-only manual release path, Apache-2.0 licensing, named npm deprecations, and retirement of `v2/`. The decision log says Context, Considered Options, Consequences, and implementation examples are historical reasoning; the candidate's Context and Problem Statement, Consequences, and Record changelog are therefore context or non-normative explanation. The linked trajectory expressly calls itself non-normative. The candidate further delegates the current normative rules to `docs/spec/layer-interfaces.md` → Publication and versions.

Independently discovered paths and headings: `docs/decisions/20260901-six-packages-publish-as-one-version-set.md` → Context and Problem Statement; Decision Outcome; Consequences; `docs/decisions/README.md` → Canonical reading guidance; `docs/spec/layer-interfaces.md` → Publication and versions; `docs/decision-evidence/20260901-publication-set-trajectory.md` → Publication set decision trajectory

### 2. Replacements, retained outcomes, untouched outcomes, and normative owner

Answer: The record resolves `G1-DEC-708` and the publication portions of `G1-DEC-709` and `G1-DEC-814` from the four-layer Harness ADR. It also resolves the publication deferrals in the V2-authority and six-deep-packages ADRs. It replaces the old shared package/wire CalVer rule by making the package version independent of `MOLTZAP_VERSION`, MCP revision, and persisted-schema versions; selects publication from current `main`; and retires `v2/` as an authority/implementation directory. It retains deep package ownership, the seven-package dependency graph, public boundaries, production-dependency restrictions, repository-native authority, atomic decision/spec traceability, and the rule that chat or private state alone cannot make a binding decision. It explicitly changes no other outcome of the three predecessor records. Current normative publication/version ownership lives in `docs/spec/layer-interfaces.md` → Publication and versions, with the accepted ADR as the current decision record; package-map and layer-contract ownership also remains in that specification.

Independently discovered paths and headings: `docs/decisions/20260811-four-layer-endpoint-replicated-harness.md` → Supersession; Daemon, package graph, and cutover; Gate 1 traceability disposition; `docs/decisions/20260729-v2-authority-lives-with-v2.md` → Supersession; `docs/decisions/20260728-six-deep-packages-one-version.md` → Supersession; `docs/spec/layer-interfaces.md` → Exact package graph; Public boundaries retained through cutover; Publication and versions

### 3. Implementer obligations, affected consumers, and assumptions

Answer: An implementer must keep exactly the six named manifests public, evals private, and all six release versions identical; compute `YYYY.MDD.N` from the UTC date and one past the highest same-day counter across all six npm histories and claimed `v<version>` release tags; pin packed workspace siblings to the exact release version; and keep package, wire, MCP, and persisted-schema versions independent. Releases must be manually dispatched from the tip of `main`, serialized, authenticated through npm trusted publishing and main/workflow-restricted Google Workload Identity Federation, use the release App key only for the release push, build and install-test the packed closure, publish three version-tagged images, record their digests, regenerate docs and changelog, commit/tag, and publish missing npm packages with provenance. Reruns must resume a committed incomplete release, while `start_new_version` intentionally abandons it and mints from the tip. Maintainers must configure the named npm, App, and Terraform-output prerequisites and run the specified deprecations after the first release. Implementers must not publish evals, add another package, couple package versions to protocol/schema namespaces, relicense old releases, restore `v2/`, restore removed compatibility facades, or decide external-consumer cutover incidentally.

Affected consumers include npm installers of any member of the six-package closure, downstream simulator benchmarks, consumers pinning controller/OpenClaw/NanoClaw image digests, the six package manifests and packed tarballs, evals, the publish workflow, architecture and pack gates, Artifact Registry, changelog/docs, and the retired npm names/releases. The seven-package runtime dependency graph and layer contracts are explicitly unaffected.

The record introduces release trust and safety assumptions: only the named workflow on `main` is trusted by WIF, npm uses trusted publishing, only the App private key is stored, releases serialize, and tip-of-main checks prevent unreviewed or interleaved publication. Partial publication is treated as a recoverable release failure, with already-published versions skipped on resume. It adds no runtime Byzantine-fault rule: the existing normative contract still assumes one correct non-equivocating Registry and Router, permits Byzantine endpoints only under the conversation-history bounds, allows outages or unavailable quorum to halt progress without invalidating certified history, and never lowers thresholds or guesses ancestry. Compatibility relies on exact sibling pins and independent version namespaces; old releases remain under their originally declared licenses and are deprecated rather than made compatible. External-consumer cutover remains unresolved.

Independently discovered paths and headings: `docs/decisions/20260901-six-packages-publish-as-one-version-set.md` → Publication set; One version; Release path; Consequences; `.github/workflows/publish.yml` → workflow definition and publish job; `scripts/release/compute-next-version.sh` → file header and computation; `docs/spec/layer-interfaces.md` → Trust, safety, and progress; Recovery; Publication and versions; Deliberate deferrals; `packages/simulator/gke/README.md` → release prerequisites and deprecation commands

### 4. Decision-makers, source events, alternatives, reversals, deferrals, and gaps

Answer: The candidate names one human decision-maker: Tapan Chugh. The ledger itself identifies the answering actor only as stored role `user` and calls that actor "the maintainer"; it does not independently map the transcript's `user` role to the named human.

For publication membership, Event 1 records the user request to distribute Simulator over npm; Event 2 records the assistant's three alternatives—six-package closure/one version, channels-only with bundling, or continued deferral—and two `v2/` retirement alternatives; Event 3 records the user selections "Simulator closure, one version" and "Retire v2/, move constitution to docs/." For license and housekeeping, Event 4 records MIT versus Apache-2.0, exact-equality versus subset ledger compatibility, and housekeeping alternatives; Event 5 records Apache-2.0, exact equality, changelog reset, uncited-input deletion, residue deletion, and old simulator/OpenClaw deprecation. The ledger marks ledger compatibility outside this record. For release mechanics, Events 6–7 record selection of workflow-built Artifact Registry images with committed digests over a manual table or GHCR. Events 8–9 record selection of equalizing all manifests, manual dispatch with later push enablement, fixed release ordering and resume behavior, and keeping one atomic PR. The last choice selects non-recommended option B; the ledger records no separate event explicitly characterized as a reversal. The selected manual trigger explicitly defers push-triggered release to a follow-up. No cited ledger event selects the candidate/spec's external-consumer-cutover deferral.

Explicit source gaps are: no source event for reasons behind the publication-set or `v2/` retirement selections; no source event for a reason behind the Apache-2.0 selection; no source event for a reason behind the D9 atomic-PR selection beyond the question text; and no source event selecting deprecation of pre-record `@moltzap/client` releases. The ledger attributes that client deprecation only to the named decision-maker's admission of the record. It also states that hidden reasoning, tool payloads, credentials, and account identifiers are not retained, and that unrelated benchmark, simulator, and engineering-review events are omitted.

Independently discovered paths and headings: `docs/decisions/20260901-six-packages-publish-as-one-version-set.md` → frontmatter; Deprecations; `docs/decision-evidence/20260901-publication-set-trajectory.md` → Source scope and gaps; Publication set and version policy; License and housekeeping; Release mechanics

### 5. Strongest contradiction and authority resolution

Answer: The strongest contradiction is the candidate's binding, unqualified statement that "A rerun after a partial failure converges on the same version, digests, and commit" versus the checked-in release implementation and operator documentation. Before a release commit exists, `.github/workflows/publish.yml` recomputes the version and says it remains unchanged only while "the UTC day has not turned." `scripts/release/compute-next-version.sh` derives the prefix from the current UTC date. `packages/simulator/gke/README.md` states that a same-day rerun reuses the attempt image but a later-day rerun mints that day's version and rebuilds. Thus a failure after images are pushed but before the release commit, followed by a rerun after UTC midnight, does not converge on the same version or digests.

The repository authority order resolves which statement governs but does not repair the implementation: `AGENTS.md` places current accepted ADR outcomes above normative specifications, architecture, workflow implementation, and operational documentation. Therefore the accepted ADR's same-version convergence requirement governs, and the workflow/README behavior is noncompliant. This is a blocker requiring the ADR to qualify the guarantee or the workflow to persist and resume the pre-commit release identity across a UTC-day boundary. A lower-authority implementation cannot silently narrow the accepted outcome.

Independently discovered paths and headings: `AGENTS.md` → Docs; `docs/decisions/20260901-six-packages-publish-as-one-version-set.md` → Release path; `.github/workflows/publish.yml` → preamble and Decide whether this run bumps or resumes a release; `scripts/release/compute-next-version.sh` → file header and `PREFIX`; `packages/simulator/gke/README.md` → release rerun behavior

### 6. Implementability, missing links, and unresolved choices

Answer: No. Most mechanics are independently actionable, but a teammate cannot implement the complete decision without reconciling the following items:

- Accidental gap: pre-commit retry semantics across UTC midnight conflict between the accepted ADR and the workflow/operator documentation. The teammate must guess whether same-version convergence or date-based reminting is intended.
- Deliberate deferral: external-consumer cutover is expressly unresolved; no eighth package, facade, or restored Simulator contract is authorized meanwhile.
- Deliberate deferral: automatic push-triggered release is a later separate change after a manual release proves prerequisites.
- Accidental provenance gap: the ledger cites no source event selecting the external-consumer-cutover deferral named by the candidate/spec.
- Accidental provenance gap, admitted rather than implementation-blocking: no source event selects deprecation of old `@moltzap/client` releases; the record explicitly attributes it only to Tapan Chugh's admission.
- Accidental explanatory provenance gaps, not binding implementation choices: the ledger has no recorded reasons for the publication-set, `v2/` retirement, Apache-2.0, or atomic-PR selections.

The first-release external prerequisites are not unresolved design choices: the repository names all six trusted-publisher registrations, `RELEASE_APP_ID`, `RELEASE_APP_PRIVATE_KEY`, and the three Terraform-output variables, and provides exact post-release deprecation commands. Runtime fault/trust choices and package boundaries remain owned by existing normative specifications rather than this release record.

Independently discovered paths and headings: `docs/spec/layer-interfaces.md` → Deliberate deferrals; `docs/decisions/20260901-six-packages-publish-as-one-version-set.md` → Consequences; Deprecations; `.github/workflows/publish.yml` → workflow_dispatch; `packages/simulator/gke/README.md` → release prerequisites and deprecations; `docs/decision-evidence/20260901-publication-set-trajectory.md` → Source scope and gaps; License and housekeeping

## Discovery trail

| Order | Entry point, search, or navigation step | Path and heading discovered | Result |
|---:|---|---|---|
| 1 | Recorded UTC start, checkout identity, tree, and candidate digest; opened the candidate directly | `docs/decisions/20260901-six-packages-publish-as-one-version-set.md` → complete record | Found accepted outcome, normative-owner locator, predecessor locators, explicit deferrals, and a self-referential prior-review hint in the changelog. |
| 2 | Followed only the candidate's provenance link | `docs/decision-evidence/20260901-publication-set-trajectory.md` → all headings | Found Events 1–9, mechanical observations, actor-role limitation, omissions, and explicit source gaps. |
| 3 | Searched headings and decision IDs in the three linked predecessor ADRs and normative spec | predecessor ADRs → Supersession; `docs/spec/layer-interfaces.md` → Publication and versions; Deliberate deferrals | Established replacement/retention lineage and normative ownership. |
| 4 | Read predecessor outcome/supersession and spec package, trust, recovery, acceptance, publication, and deferral sections | `docs/decisions/20260728-six-deep-packages-one-version.md`; `docs/decisions/20260729-v2-authority-lives-with-v2.md`; `docs/decisions/20260811-four-layer-endpoint-replicated-harness.md`; `docs/spec/layer-interfaces.md` | Confirmed retained graph and authority rules, unchanged runtime assumptions, and resolved trace rows. |
| 5 | Repository-wide text search with cold-review and invalid-review exclusions | `docs/`, `packages/`, `scripts/`, `.github/workflows/` | Found current implementation and documentation; search also returned unrelated historical `*-blind-review.md` content, which supplied no candidate answer and was ignored. No quarantined cold-review or invalid-review content was returned. |
| 6 | Inspected workflow, architecture checker, seven manifests, vision, and spec index | `.github/workflows/publish.yml`; `scripts/architecture/check-boundaries.js`; `packages/*/package.json`; `docs/vision.md`; `docs/spec/README.md` | Confirmed six public equal-version Apache-2.0 manifests, private evals, release gates, and package-version independence. |
| 7 | Inspected workflow tail and searched licensing, deprecation, and cutover statements | `.github/workflows/publish.yml` → npm publication; `packages/simulator/gke/README.md`; `CHANGELOG.md` | Confirmed skip-existing publication, exact deprecation commands, and external-consumer deferral. |
| 8 | Inspected version computation, operator rerun instructions, changelog, and decision index | `scripts/release/compute-next-version.sh`; `packages/simulator/gke/README.md`; `docs/decisions/README.md` | Discovered the UTC-midnight retry contradiction and confirmed accepted-status semantics. |
| 9 | Independently opened checked-in repository law | `AGENTS.md` → Project; Decisions; Docs | Confirmed the authority order used to classify the contradiction as a blocker. |

## Author interventions

| Time | Intervention | Effect on review |
|---|---|---|
| 2026-09-02T04:11:17Z | The candidate's Record changelog itself names "Blind-review corrections" and the prior run locator `…-39284b48-cold-review`. | This was an unsolicited author hint embedded in the candidate. I did not open or search for that quarantined artifact, but the review rule makes any author hint independently sufficient for FAIL. |
| pre-review | The harness supplied generic model/tool/skill/plugin operating instructions outside the checkout. | They contained no candidate answer or decision rationale and were not used as repository evidence. The candidate path, fixed questions, quarantine rules, and output schema were the review assignment itself. |

## Blockers

| ID | Finding | Evidence | Required reconciliation |
|---|---|---|---|
| B1 | Accepted same-version rerun convergence conflicts with cross-day pre-commit workflow behavior. | `docs/decisions/20260901-six-packages-publish-as-one-version-set.md` → Release path says every partial-failure rerun converges on the same version/digests/commit; `.github/workflows/publish.yml` says this is unchanged only while UTC day has not turned; `scripts/release/compute-next-version.sh` uses today's UTC prefix; `packages/simulator/gke/README.md` says later-day reruns mint and rebuild. | Qualify the accepted outcome or persist/resume the attempted version and source revision across UTC midnight before a release commit exists; then align workflow, operator docs, and normative text. |
| B2 | Candidate contains an explicit pointer to an earlier cold-review run. | `docs/decisions/20260901-six-packages-publish-as-one-version-set.md` → Record changelog: "Blind-review corrections (run `…-39284b48-cold-review`)". | Remove prior-review answer-key hints from the artifact presented to a fresh blind reviewer, or establish a gate protocol that excludes candidate changelog hints without exposing prior output. |
| B3 | External-consumer deferral lacks cited source-event attribution. | Candidate Consequences and `docs/spec/layer-interfaces.md` → Deliberate deferrals call it unresolved; `docs/decision-evidence/20260901-publication-set-trajectory.md` cites no event selecting it and does not explicitly record that absence. | Add a source event locator or explicitly record "No source event located" and attribute admission without inventing rationale. |

## Overall result

Result: **FAIL**

Rationale (reviewer, verbatim): The accepted outcome conflicts with the checked-in cross-day retry implementation, one deliberate deferral lacks independently discoverable source-event lineage, and the candidate itself exposes a prior cold-review hint. Under the stated rule, any unresolved contradiction, missing attribution, or author hint is FAIL.

## Maintainer acceptance

The reviewer result is evidence, not self-certifying acceptance. The
maintainer verifies that it applies to the exact candidate identity
above and records the gate decision.

| Field | Value |
|---|---|
| Maintainer | `_fill_` |
| Reviewed result | `20260901-six-packages-publish-as-one-version-set-379a113e-cold-review` |
| Candidate identity matches | `_yes or no_` |
| Gate decision | `_ACCEPTED or REJECTED_` |
| Decision time | `_fill ISO 8601 timestamp_` |
| Rationale | `_fill_` |

## Rerun identity

| Field | Value |
|---|---|
| Superseded by review run | `_fill new review run ID_` |
| Superseded candidate commit | `379a113e00f82ef70a4415511345752a2e8c501a` |
| Superseded candidate content digest | sha256 `5449a7ccde8c488cdf9cff80efa83011f232a834dd747a8e9bf35801ff4cfd6a` |
| Reason a rerun was required | Blockers B1–B3: the record's convergence sentence is qualified to match the workflow, the changelog row no longer names a review run, and the ledger records the external-consumer deferral's missing source event; these change the candidate. |
