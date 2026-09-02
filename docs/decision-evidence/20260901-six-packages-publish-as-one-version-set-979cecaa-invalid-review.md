# Blind decision review record (invalidated run)

Blind review of `docs/decisions/20260901-six-packages-publish-as-one-version-set.md`
at candidate commit `979cecaa`, run per the `cold-read` skill in
repository-scoped (`--questions`) mode by a separate `codex exec` process
from a detached worktree outside the parent project (the isolation
introduced for run `…-379a113e-cold-review`). The reviewer received the
checkout root, the candidate path, and the six fixed questions from
`.claude/skills/cold-read/references/questions.md`, with the quarantine and
search-exclusion rules; nothing else from the author. Answers below are the
reviewer's, verbatim.

This run is retained as **invalid**, not as a verdict on the record. The
codex harness renders the checkout's own `AGENTS.md` into the reviewer's
context as project instructions before the first command, and that file
names the record and states its outcome; the reviewer disclosed this, left
two attestation lines unchecked, and reported FAIL on isolation grounds
while finding no defect in the record. The next run disables that rendering
(`project_doc_max_bytes=0`) so the checkout's entry points are discovered,
not delivered.

## Review identity

| Field | Value |
|---|---|
| Review run ID | `20260901-six-packages-publish-as-one-version-set-979cecaa-invalid-review` |
| Candidate commit | `979cecaa29fb4a0794873c5547480b3fd02d9ea1` |
| Candidate tree | `b2df136445806f2f66fff9f809f366da0f262383` |
| Candidate content digest | sha256 `3576716965bc7d7ccd375fb16ef0f05d3e191d7d3c2e95df4f475b8757a4b269` (record); sha256 `aa7acad01ff38e19a8d70af14f6184eb350b4ae65350b60a5dd7d974341069ce` (trajectory) |
| Digest scope and command | `git worktree add --detach /tmp/blind-979cecaa 979cecaa29fb4a0794873c5547480b3fd02d9ea1 && sha256sum docs/decisions/20260901-six-packages-publish-as-one-version-set.md docs/decision-evidence/20260901-publication-set-trajectory.md` |
| Reviewer | `codex exec` (codex-cli 0.152.0), `--sandbox read-only`, `model_reasoning_effort=medium`; a separate process, not a Claude Code subagent |
| Reviewer session | fresh codex process started 2026-09-02T04:19:31Z with working directory `/tmp/blind-979cecaa` (outside the parent project); prompt = checkout root, candidate path, the six questions, quarantine and search-exclusion rules, output schema |
| Review started | 2026-09-02T04:20:26Z |
| Review finished | 2026-09-02T04:22:39Z |
| Review duration | 2m 13s (reviewer-reported; process wall clock 04:19:31Z to 04:26:13Z) |
| Review budget | one uninterrupted run under `timeout 900`; no mid-run interaction permitted |
| Rerun of | `20260901-six-packages-publish-as-one-version-set-379a113e-cold-review` |
| Rerun reason | Run 3 failed on blockers B1–B3 (unqualified rerun convergence, a review-run locator in the record's changelog, an unattributed retained deferral), corrected in `979cecaa`. |

## Fresh-context attestation

The reviewer attests (verbatim):

- [x] I did not author or reconcile the candidate decision.
- [x] I received no inherited conversation, summary, memory, private state, or earlier blind-review output about the candidate.
- [ ] I received only the clean candidate checkout and the fixed questions. The platform also supplied system/developer orchestration instructions, a skills catalog, a recommended-plugin list, and rendered project `AGENTS.md` content before the review began. I did not treat them as repository evidence.
- [ ] I received no out-of-band tour, decision or file pointer, search term, expected answer, or answer key. The rendered `AGENTS.md` content supplied out of band named the candidate and stated that six packages publish as one calendar version set while evals stays private. I independently rediscovered the record and its contract in the checkout, but the advance disclosure invalidates strict blind isolation.
- [x] I navigated the repository independently. I may have used checked-in entry points, repository-native indexes, ordinary search, and repository history after discovering them myself.
- [x] I did not open, read, or search the contents of an earlier cold-review or invalid-review record.
- [x] I did not ask the author for help or modify the candidate before submitting these answers.
- [x] The author interventions recorded below are complete.

## Fixed questions and verbatim answers

The six questions live in `.claude/skills/cold-read/references/questions.md`.

### 1. Current decision, problem, and binding scope

Answer: The accepted decision makes six packages public on npm as one coordinated calendar-version set: `@moltzap/identity`, `@moltzap/router`, `@moltzap/client`, `@moltzap/openclaw-channel`, `@moltzap/nanoclaw-channel`, and `@moltzap/simulator`; `@moltzap/evals` remains private. Each release uses `YYYY.MDD.N`, calculated one counter past the highest same-day npm version or `v<version>` release tag across the set, and packed sibling dependencies are pinned exactly. Package versions are independent of `MOLTZAP_VERSION`, MCP revisions, and persisted-schema versions.

It resolves the inability to install the simulator's private dependency closure from npm, the disabled release workflow, inconsistent package versions and licenses, stale v1 registry artifacts, and leftover `v2/` authority/version material. It also selects the manual, serialized, main-only release path, three version-tagged simulator images with recorded digests, Apache-2.0 for the repository and current packages, specified v1/pre-cutover npm deprecations, and retirement of `v2/`.

Binding material is the accepted Decision Outcome and its Publication set, One version, Release path, License, Deprecations, Retired directory, and resolution clauses, subject to the higher constitution. `docs/spec/layer-interfaces.md` → Publication and versions is explicitly named as the normative owner. The candidate's Context and Problem Statement, Consequences, provenance links, and record changelog explain history, implementation effects, prerequisites, and corrections; the decision-log guidance says context, considered options, consequences, and examples are historical reasoning rather than the current binding outcome. The trajectory ledger is expressly non-normative.

Independently discovered paths and headings: `README.md` → Install and Package graph; `docs/decisions/README.md` → Canonical reading guidance and Status; `docs/decisions/20260901-six-packages-publish-as-one-version-set.md` → Context and Problem Statement, Decision Outcome, What this record resolves; `docs/spec/layer-interfaces.md` → Publication and versions; `docs/decision-evidence/20260901-publication-set-trajectory.md` → Publication set decision trajectory

### 2. Replacement, retention, and normative ownership

Answer: The decision resolves `G1-DEC-708`, the publication/version portion of `G1-DEC-709`, and the publication portion of `G1-DEC-814` from the four-layer Harness record. It also resolves publication deferrals in the V2-authority and six-deep-packages records.

The earlier six-deep-packages record retains only deep package ownership, the prohibition on production depending on simulation/evaluation products, and independent MCP/simulator persisted-format versioning. Its old six-`v2/*` package graph, `@moltzap/v2-*` names, `v2/VERSION`, Ledger/testbed owners, exports, binaries, dependency DAG, and rule tying package CalVer to wire compatibility were replaced by the four-layer record; this candidate then selects the final six-of-seven publication set and makes package and wire versions independent.

The V2-authority record retains repository-native authority, its authority order, atomic decision/spec/traceability landing, and the rule that chat, issues, private state, or another branch cannot alone bind implementation. Its perpetual branch isolation, `v2/*` authority location, forward-merge arrangement, and publication deferral are replaced or resolved. All other outcomes of those records, including the seven-package graph, public boundaries, layer contracts, and the four-layer fault model, remain untouched.

The current normative contract lives in `docs/spec/layer-interfaces.md` → Publication and versions, read below `AGENTS.md`, `docs/vision.md`, and accepted ADR outcomes in the repository's stated authority order. The four-layer record's traceability table points `G1-DEC-708`, `G1-DEC-709`, and `G1-DEC-814` to the candidate and the normative specification.

Independently discovered paths and headings: `docs/decisions/20260728-six-deep-packages-one-version.md` → Supersession; `docs/decisions/20260729-v2-authority-lives-with-v2.md` → Supersession; `docs/decisions/20260811-four-layer-endpoint-replicated-harness.md` → Gate 1 traceability disposition; `docs/spec/layer-interfaces.md` → Exact package graph and Publication and versions; `docs/vision.md` → Authority

### 3. Implementation obligations and assumptions

Answer: An implementer must keep exactly the named six manifests public and at one release version, keep evals private, calculate the next version across the union of npm histories and release tags, pin every packed workspace sibling exactly, and keep package, wire, MCP, and storage namespaces independent. Releases must be manual, serialized, from the tip of `main`, and use `.github/workflows/publish.yml`. A bump run must build and pack-test the closure, push the controller/OpenClaw/NanoClaw images, record their digests, regenerate docs, stamp the changelog, create and atomically push the release commit and tag, and publish missing npm packages with provenance. A resume must use the existing release commit; `start_new_version` is the specified escape from an incomplete release.

The implementer must not publish evals, introduce an eighth package, restore compatibility facades or removed Simulator contracts, mix sibling versions, treat package versions as protocol compatibility, relicense already-published artifacts, restore `v2/`, or silently decide external-consumer cutover.

Affected consumers are all six published packages and their installed dependency closures, the private eval workspace boundary, downstream simulator users, three simulator image consumers, release automation, package-boundary and pack gates, changelog/docs generation, the GKE image-digest table, and npm users of retired v1/pre-cutover packages. The Identity, Router, Client, adapter, Simulator, and eval package graph is affected operationally, but their layer ownership and protocol contracts are unchanged.

The inherited system fault and trust assumptions remain one correct non-equivocating Registry and Router, with potentially Byzantine endpoints under the conversation-history bounds; this publication decision changes none of them. Release-specific trust assumes GitHub OIDC, Workload Identity Federation restricted to this workflow on `main`, npm trusted publishing, and a release App private key as the release workflow's stored secret. Safety comes from exact sibling pins, boundary checks, pack/install gates, provenance, immutable digest recording, a main-tip check, and serialized releases. Partial-release liveness comes from same-day pre-commit reuse, post-commit resume, publishing only missing npm artifacts, and the explicit abandon-and-mint path. Registry or prerequisite failures abort rather than being treated as absence. Compatibility is intentionally not inferred from the package version; old releases retain their declared license, named old surfaces are deprecated, and external-consumer cutover remains unresolved.

Independently discovered paths and headings: `docs/decisions/20260901-six-packages-publish-as-one-version-set.md` → One version, Release path, Consequences; `docs/spec/layer-interfaces.md` → Cross-layer laws, Publication and versions, Deliberate deferrals; `.github/workflows/publish.yml` → Publish to npm workflow; `scripts/architecture/check-boundaries.js` → final-package publication table; `packages/simulator/gke/README.md` → Release publishing

### 4. Decision-makers, source events, and source gaps

Answer: The only named human decision-maker is Tapan Chugh. The ledger's source records identify actors only as `user` or `assistant`; they do not name another human.

The compacted trajectory cites:

- Event 1, user record `a0a49b29-4399-4920-922f-71fd58abd838`, 2026-09-01T21:12:20Z: requests release-readiness work and npm distribution of Simulator.
- Event 2, assistant record `abbd3ed9-ef2b-49d6-afe9-7f0f5cf135b8`, 2026-09-01T21:24:00Z: offers the six-package one-version closure, bundled simulator/channels, or continued deferral, and offers retiring versus retaining `v2/`.
- Event 3, user record `9af1986a-3109-4deb-8a1d-3935896ad197`, 2026-09-01T21:28:34Z: selects the six-package one-version closure and retirement of `v2/`.
- Event 4, assistant record `aada0556-71a1-4352-87b0-0473d6de5b07`, 2026-09-01T21:51:06Z: offers MIT versus Apache-2.0 and the listed release-housekeeping choices.
- Event 5, user record `21f84fd4-78a1-421a-b0e1-0d67ed15f4e2`, 2026-09-01T21:52:49Z: selects Apache-2.0 and all listed housekeeping items, including old Simulator/OpenClaw deprecation, changelog reset, uncited-input deletion, and GKE residue deletion. Its exact-ledger-reader choice is identified as belonging to another simulator change.
- Event 6, assistant record `bbbdc5ae-712e-404f-b45a-6049ad0876af`, 2026-09-01T23:14:55Z: offers workflow-built Artifact Registry images with recorded digests, a manual table, or GHCR.
- Event 7, user record `5c0254b4-6774-48ae-94d8-1fbc13ab93b9`, 2026-09-01T23:35:25Z: selects workflow-built images and recorded digests.
- Event 8, assistant record `44f5b550-ca6b-40d6-8461-f8fc6ea90ff8`, 2026-09-02T00:10:41Z: offers choices for manifest-version normalization, manual versus gated push triggering, release ordering/recovery, and split versus atomic PR scope.
- Event 9, user record `f8e025e5-2dea-417a-b68c-cf928ddea3e3`, 2026-09-02T00:13:45Z: selects setting all six manifests to `2026.811.0`, manual dispatch followed by a possible later push-trigger change, the fixed image/commit/npm order with convergence, and one atomic PR.

The ledger records no explicit reversal event. It records no source event for reasons behind the publication-set or `v2/` selections, the Apache-2.0 selection, or the D9 atomic-PR selection beyond the question text. It records no selection for deprecating pre-record `@moltzap/client`; the record attributes that to the named decision-maker's admission. It also records no event selecting or discussing the retained external-consumer cutover deferral; the ledger's mechanical observation shows that deferral predated this record. The ledger says omitted session events concern downstream benchmarks, simulator features, and engineering-review questions outside this record.

Independently discovered paths and headings: `docs/decisions/20260901-six-packages-publish-as-one-version-set.md` → frontmatter and Deprecations; `docs/decision-evidence/20260901-publication-set-trajectory.md` → Source scope and gaps, Publication set and version policy, License and housekeeping, Release mechanics, Mechanical repository and registry effects

### 5. Strongest contradiction or stale lineage

Answer: The strongest stale instruction is `docs/architecture/first-implementation.md` → Final gate, which still says to "resolve publication/version policy and update release automation." In the candidate checkout, the accepted publication ADR, the four-layer traceability rows, `docs/spec/layer-interfaces.md` → Publication and versions, the six aligned public manifests, and the enabled manual release workflow all show that this item has been completed.

The repository's authority order resolves the tension: accepted ADR outcomes outrank normative specifications, which outrank architecture orientation and execution plans. The architecture text is therefore a historical/pre-release checklist whose condition is now satisfied, not an unresolved instruction that can override the candidate. It is stale wording worth updating, but it does not block implementation or break lineage. I found no stronger unresolved repository contradiction or broken source locator.

Independently discovered paths and headings: `docs/architecture/first-implementation.md` → Final gate; `docs/vision.md` → Authority; `docs/decisions/README.md` → Canonical reading guidance; `docs/decisions/20260811-four-layer-endpoint-replicated-harness.md` → Gate 1 traceability disposition; `docs/spec/layer-interfaces.md` → Publication and versions

### 6. Implementability and unresolved choices

Answer: Yes, the repository supplies enough implementation detail without chat: the publication membership, version algorithm, release ordering and rerun behavior, package pins, image set, authentication inputs, exact repository variables, App configuration, pack gates, deprecation commands, license files, and normative owner are all discoverable.

The unresolved or missing items are:

- External-consumer cutover: deliberate deferral. The specification explicitly says it remains unresolved and forbids using this record to restore removed contracts or create another package.
- Push-triggered releases: deliberate deferral. The first release is manual; a push-triggered variant is expressly a later, separate change after the manual path proves its prerequisites.
- Reasons for choosing the package set and retiring `v2/`: accidental provenance gaps, explicitly recorded as "No source event located"; they do not leave the selected implementation ambiguous.
- Reason for choosing Apache-2.0: accidental provenance gap, explicitly recorded; the license outcome and implementation are nevertheless exact.
- Reason for the D9 atomic-PR selection beyond the option text: accidental provenance gap, explicitly recorded; it does not leave the release contract ambiguous.
- Source event for pre-record `@moltzap/client` deprecation: accidental provenance gap. The candidate explicitly assigns the decision to Tapan Chugh's admission, and `packages/simulator/gke/README.md` supplies the exact version range and command, so no implementation choice remains.
- Source event for retaining the external-consumer deferral: accidental provenance gap attached to a deliberate deferral. The ledger mechanically establishes that the unresolved clause predates this record.
- First-release credentials and registry configuration: external prerequisites, not unresolved design choices. The repository specifies the trusted-publisher setup, App variable/secret, and three Terraform-derived repository variables.
- Deprecations after first release: scheduled manual work, not an unresolved choice; exact commands and messages are checked in.

Independently discovered paths and headings: `docs/spec/layer-interfaces.md` → Publication and versions and Deliberate deferrals; `docs/decisions/20260901-six-packages-publish-as-one-version-set.md` → Consequences and Deprecations; `packages/simulator/gke/README.md` → Release publishing; `docs/decision-evidence/20260901-publication-set-trajectory.md` → Source scope and gaps, License and housekeeping, Release mechanics

## Discovery trail

| Order | Entry point, search, or navigation step | Path and heading discovered | Result |
|---:|---|---|---|
| 1 | Recorded UTC start, commit, tree, and candidate digest | `docs/decisions/20260901-six-packages-publish-as-one-version-set.md` | Established immutable review identity. |
| 2 | Listed repository root and non-quarantined documentation paths | `README.md`; `docs/decisions/`; `docs/spec/`; `docs/decision-evidence/` | Found project entry points, decision index, candidate, normative specs, and trajectory. Quarantined paths were seen only as names. |
| 3 | Read root README and decision index | `README.md` → Install and Package graph; `docs/decisions/README.md` → Canonical reading guidance | Found package set, decision status semantics, authority guidance, and candidate index entry. |
| 4 | Read candidate | `docs/decisions/20260901-six-packages-publish-as-one-version-set.md` → all headings | Identified binding outcome, prior deferrals, release mechanics, consequences, and normative owner. |
| 5 | Followed candidate provenance | `docs/decision-evidence/20260901-publication-set-trajectory.md` → all headings | Recovered source events, actor limitations, alternatives, selections, mechanical observations, and explicit source gaps. |
| 6 | Followed normative-owner link | `docs/spec/layer-interfaces.md` → Exact package graph, Cross-layer laws, Publication and versions, Deliberate deferrals | Confirmed current contract, unchanged layer assumptions, and external-consumer deferral. |
| 7 | Read constitution and spec index | `docs/vision.md` → Authority, Packages, Deliberate deferrals; `docs/spec/README.md` → Version namespaces | Confirmed authority order and independence of version namespaces. |
| 8 | Followed supersession links | `docs/decisions/20260728-six-deep-packages-one-version.md` → Supersession; `docs/decisions/20260729-v2-authority-lives-with-v2.md` → Supersession | Distinguished retained deep ownership and repository authority from replaced package/branch/version rules. |
| 9 | Located traceability rows | `docs/decisions/20260811-four-layer-endpoint-replicated-harness.md` → Gate 1 traceability disposition | Confirmed resolution and normative ownership of `G1-DEC-708`, `G1-DEC-709`, and `G1-DEC-814`. |
| 10 | Searched repository for publication/version/deprecation terms with quarantine exclusions | `.github/workflows/publish.yml`; `packages/simulator/gke/README.md`; `CHANGELOG.md`; `scripts/architecture/check-boundaries.js` | Confirmed implementation surface. Search also returned non-quarantined `*-blind-review.md` content concerning other ADRs; it supplied no candidate answer and was excluded from reasoning. |
| 11 | Read release workflow and release helpers | `.github/workflows/publish.yml`; `scripts/release/compute-next-version.sh`; `scripts/release/write-published-images.mjs` | Confirmed trigger, serialization, version calculation, image handling, commit order, resume behavior, and digest validation. |
| 12 | Inspected all package manifests | `packages/*/package.json` | Confirmed six aligned public packages at `2026.811.0`, private evals, and Apache-2.0. |
| 13 | Searched architecture material for stale publication language | `docs/architecture/first-implementation.md` → Final gate | Found the strongest stale instruction and resolved it through the authority order. |
| 14 | Read GKE release instructions and changelog | `packages/simulator/gke/README.md` → Release publishing; `CHANGELOG.md` → Added: six packages published as one version set | Confirmed external prerequisites, exact deprecation commands, and release-facing documentation. |
| 15 | Inspected relevant git history and current status | candidate/workflow path history | Found the candidate correction sequence and a clean working tree; no quarantined artifact content was opened. |
| 16 | Recorded UTC finish | review metadata | Completed review timing. |

## Author interventions

| Time | Intervention | Effect on review |
|---|---|---|
| before 2026-09-02T04:20:26Z | Platform context supplied system/developer orchestration instructions, a skill catalog, recommended plugins, and rendered `AGENTS.md` content. The rendered project instructions named this publication record and stated its six-package one-version conclusion. | No repository claim was accepted from that material; all answers were independently checked in the checkout. Nevertheless, the advance answer disclosure violates strict fresh-context isolation and requires a new isolated run. |
| during review | No author communication, hint, file modification, or quarantined cold-review/invalid-review output occurred. | none |

## Blockers

| ID | Finding | Evidence | Required reconciliation |
|---|---|---|---|
| B1 | The run was not strictly blind because out-of-band rendered project instructions disclosed the candidate and its core answer before repository navigation. | Supplied context stated: "six publish to npm as one calendar version set and `@moltzap/evals` stays private, per `docs/decisions/20260901-six-packages-publish-as-one-version-set.md`." | Repeat the review in a context containing only the fixed review prompt and checkout, without injected project-file contents, prior conversation, skills catalogs, or answer-bearing instructions. |

## Overall result

Result (reviewer, verbatim): **FAIL**

Rationale (reviewer, verbatim): The candidate itself is coherent, independently discoverable in the checkout, normatively owned, lineage-complete, explicit about its assumptions and provenance gaps, and implementable except for declared deferrals. However, PASS requires a genuinely blind fresh context. Out-of-band rendered `AGENTS.md` content disclosed the candidate path and its central decision before discovery. That author-context contamination violates the required isolation and necessitates a clean rerun, regardless of the repository findings.

Classification by the author on retention: **INVALID** per the unchecked
attestation lines. The rendered content was the candidate checkout's own
`AGENTS.md`, a repository-native entry point at the candidate revision, but
it reached the reviewer before navigation rather than through it. The run
neither admits nor rejects the record; the maintainer rules on it.

## Maintainer acceptance

The reviewer result is evidence, not self-certifying acceptance. The
maintainer verifies that it applies to the exact candidate identity
above and records the gate decision.

| Field | Value |
|---|---|
| Maintainer | `_fill_` |
| Reviewed result | `20260901-six-packages-publish-as-one-version-set-979cecaa-invalid-review` |
| Candidate identity matches | `_yes or no_` |
| Gate decision | `_ACCEPTED or REJECTED_` |
| Decision time | `_fill ISO 8601 timestamp_` |
| Rationale | `_fill_` |

## Rerun identity

| Field | Value |
|---|---|
| Superseded by review run | `20260901-six-packages-publish-as-one-version-set-0d65b4af-cold-review` |
| Superseded candidate commit | `979cecaa29fb4a0794873c5547480b3fd02d9ea1` |
| Superseded candidate content digest | sha256 `3576716965bc7d7ccd375fb16ef0f05d3e191d7d3c2e95df4f475b8757a4b269` |
| Reason a rerun was required | The reviewer received the checkout's `AGENTS.md` before navigation (invalidating strict isolation); the next run disables the harness's project-document rendering. The stale `Final gate` sentence the reviewer resolved through the authority order is corrected before the next candidate is frozen. |
