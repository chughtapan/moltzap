# Blind decision review record (invalidated run)

Blind review of `docs/decisions/20260901-six-packages-publish-as-one-version-set.md`
at candidate commit `81008c9a`, run per the `cold-read` skill in
repository-scoped (`--questions`) mode with a different fresh reviewer than
run `…-39284b48-cold-review`. The reviewer received the checkout root, the
candidate path, and the six fixed questions from
`.claude/skills/cold-read/references/questions.md`; nothing else from the
author. Answers below are the reviewer's, verbatim.

This run is retained as **invalid**, not as a verdict on the record: the
reviewer's own trail records a recursive `grep` that returned answer lines
from the quarantined run-1 review, which
`docs/decision-evidence/README.md` → Artifact types names as invalidating a
fresh run, and the reviewer disclosed the same harness-injected project
instructions and memory index that run 1 disclosed. The reviewer's
substantive findings are kept because they are evidence about the record;
they do not admit it.

## Review identity

| Field | Value |
|---|---|
| Review run ID | `20260901-six-packages-publish-as-one-version-set-81008c9a-invalid-review` |
| Candidate commit | `81008c9adb9366cda4d158963c4fb67b6c4d7839` |
| Candidate tree | `84c1426dbeabe6cb998a9966dc1d0b433c16b522` |
| Candidate content digest | sha256 `5449a7ccde8c488cdf9cff80efa83011f232a834dd747a8e9bf35801ff4cfd6a` (record); sha256 `31483109b9668a324b7ee37961eb46397f95a4f154787cfdccfe5df052bfebe9` (trajectory) |
| Digest scope and command | `git checkout 81008c9adb9366cda4d158963c4fb67b6c4d7839 && sha256sum docs/decisions/20260901-six-packages-publish-as-one-version-set.md docs/decision-evidence/20260901-publication-set-trajectory.md` |
| Reviewer | Claude Code `general-purpose` subagent (Opus model) dispatched by the `cold-read` skill (repository-scoped mode); a different reviewer instance and model than run 1 |
| Reviewer session | fresh subagent context, no parent conversation, summary, or memory handed over by the author; dispatched 2026-09-02T03:53Z with the checkout root, the candidate path, the fixed questions, and an instruction to disclose and not use any harness-injected context |
| Review started | 2026-09-02T03:53:27Z |
| Review finished | 2026-09-02T04:01:36Z |
| Review duration | 8m 09s |
| Review budget | one uninterrupted run; no mid-run interaction permitted |
| Rerun of | `20260901-six-packages-publish-as-one-version-set-39284b48-cold-review` |
| Rerun reason | Run 1 failed on blockers B1 and B2 (pre-record license claim; unattributed `@moltzap/client` deprecation), corrected in `81008c9a`. |

## Fresh-context attestation

The reviewer attests (verbatim):

- [x] I did not author or reconcile the candidate decision.
- [x] I received no inherited conversation, summary, memory, private state, or earlier blind-review output about the candidate.
- [ ] I received only the clean candidate checkout and the fixed questions. — My harness injected, before the task message, project instructions from a *different* checkout (`/home/tapanc/CLAUDE.md` and `/home/tapanc/moltzap/CLAUDE.md`) and a user memory index from `~/.claude/projects/-home-tapanc-moltzap/memory/MEMORY.md`. That injected `moltzap/CLAUDE.md` describes a *pre-cutover* state (`v2/VISION.md` as constitution, a live `cutover/four-layer-v2` branch, "npm continues publishing from `main`"), and the memory index contains a line titled "npm publish state 2026-09-01". I did not open, cite, or rely on any of it; every finding below is sourced from files inside `/home/tapanc/moltzap-pr-r`, and I deliberately re-read this checkout's own `AGENTS.md` rather than the injected copy.
- [x] I received no out-of-band tour, decision or file pointer, search term, expected answer, or answer key.
- [x] I navigated the repository independently. I may have used checked-in entry points, repository-native indexes, ordinary search, and repository history after discovering them myself.
- [ ] I did not open, read, or search the contents of an earlier cold-review or invalid-review record. — I never opened one, but a `grep -r` over `docs/` for `G1-DEC-708|G1-DEC-709|G1-DEC-814` returned six matched content lines from the quarantined `docs/decision-evidence/20260901-six-packages-publish-as-one-version-set-39284b48-cold-review.md`, including part of its answers to Q1, Q2 and Q5. Disclosed in full under Author interventions. All subsequent searches excluded `*-cold-review.md`, `*-invalid-review.md`, and `*-blind-review.md`.
- [x] I did not ask the author for help or modify the candidate before submitting these answers.
- [x] The author interventions recorded below are complete.

## Fixed questions and verbatim answers

The six questions live in `.claude/skills/cold-read/references/questions.md`.

### 1. What the record makes current, the problem it resolves, and binding versus context

Answer: The record makes current that **six packages publish to npm as one calendar version set and `@moltzap/evals` stays private**. `status: accepted`, `date: 2026-09-01`, `decision-makers: Tapan Chugh`.

The problem it resolves is a deferral that had frozen release work: publication membership, version coordination, and release ordering were left unselected by three earlier records, `.github/workflows/publish.yml` was disabled behind `if: ${{ false }}` "until the package closure, version policy, and installable public artifact set have one accepted decision", and two gates encoded the deferral (`check-boundaries.js` required Identity and Router to carry `private`, and the Client pack gate asserted "packed client must remain private until publication is admitted"). Both gate texts are verifiable at `a178413d`, the base of this branch. Meanwhile the simulator — the product downstream benchmarks install — has a dependency closure of `@moltzap/identity`, `@moltzap/router`, `@moltzap/client`, so its tarball could not install from npm.

**Binding** (everything under `## Decision Outcome`):
- *Publication set*: exactly the six named packages are public; `@moltzap/evals` is never published; no other package joins the set by this record.
- *One version*: every release carries one `YYYY.MDD.N` string; the counter is one past the highest that any of the six has published for that UTC day or that a `v<version>` release tag already claims; each packed manifest pins its workspace siblings to that exact version.
- *Version-namespace independence*: the package version is independent of `MOLTZAP_VERSION`, the MCP revision, and every persisted-schema version; `packages/identity/src/version.ts` is the sole owner of the wire value.
- *Release path*: manual `workflow_dispatch` from the tip of `main` only, one run at a time, a fixed sequence (compute → write manifests → build → prove packed closure installs → push/reuse images and record digests → regenerate docs → stamp CHANGELOG → `chore(release): moltzap@<version>` → publish with provenance), convergent reruns, `start_new_version` to abandon, WIF for Google Cloud, trusted publishing for npm, one stored secret (the release App private key).
- *License*: repository and every published package are Apache-2.0; pre-record releases are not relicensed.
- *Deprecations*: `@moltzap/protocol` and `@moltzap/server-core` in full; all pre-record `@moltzap/client`, `@moltzap/simulator`, `@moltzap/openclaw-channel` releases.
- *Retired directory*: `v2/` is retired; constitution at `docs/vision.md`; cited inputs/drafts under `docs/decision-evidence/{inputs,drafts}/`; uncited inputs deleted; `v2/VERSION` deleted.
- *Scope statement*: it resolves the named deferrals and changes no other outcome; the seven-package graph, public boundaries, and layer contracts are unchanged.

**Context / non-normative**: the `## Context and Problem Statement` section (registry state, manifest license disagreement, the two gates), the `## Consequences` bullets (which describe already-implemented enforcement and maintainer prerequisites rather than adding rules), and the `## Record changelog` table. The `Decision provenance` links point at a ledger that opens by declaring itself "non-normative … It does not supply architecture authority."

Independently discovered paths and headings:
- `docs/decisions/20260901-six-packages-publish-as-one-version-set.md` → frontmatter; Context and Problem Statement; Decision Outcome (Publication set / One version / Release path / License / Deprecations / Retired directory / What this record resolves); Consequences; Record changelog
- `docs/decision-evidence/20260901-publication-set-trajectory.md` → opening paragraph ("This non-normative ledger …")
- `git show a178413d:.github/workflows/publish.yml` → `if: ${{ false }}` and the "Publication stays disabled …" comment
- `git show a178413d:scripts/architecture/check-boundaries.js` → "must stay private until release policy is admitted"
- `git show a178413d:scripts/test-client-package.mjs` → "packed client must remain private until publication is admitted"

### 2. What it replaces, retains, or leaves untouched, and where the normative contract lives

Answer: It **replaces (selects) only publication deferrals**, in three records, each of which was updated in the same change and carries a dated `Record changelog` row:

- `20260811-four-layer-endpoint-replicated-harness.md`: `G1-DEC-708` and the publication halves of `G1-DEC-709` and `G1-DEC-814`. Its traceability rows now read "Resolved — …" and point to this record plus `docs/spec/layer-interfaces.md` — Publication and versions; its "Explicit deferrals and implementation boundary" paragraph now reads "Publication membership, package-version coordination, and release ordering were unselected at admission; `20260901-…` selects them."
- `20260729-v2-authority-lives-with-v2.md`: the Supersession section now says this record "selects the npm publication and version policy this record deferred", superseding the historical body's "npm continues to publish from `main` until a separate cutover decision changes that rule."
- `20260728-six-deep-packages-one-version.md`: its Supersession now says this record "selects the publication and version policy this record left deferred"; the historical Decision Outcome ("One CalVer value in `v2/VERSION` must exactly match all six package manifests and Moltzap wire compatibility") is explicitly historical and is inverted by the candidate's independence rule.

**Retained / untouched**: the seven-package dependency graph, the public boundaries, and the layer contracts in `docs/spec/layer-interfaces.md`. Deep package ownership retained by the six-deep-packages record stays retained. Non-publication deferrals in the four-layer record stay open (pruning, garbage collection, retention after certificate completion, disk-loss recovery; the four public-interface deferrals). External-consumer cutover stays open.

**Current normative contract**: `docs/spec/layer-interfaces.md` → `## Publication and versions`, which the candidate names as "the normative owner of the rules above" and which reciprocally names the record ("The current record is `../decisions/20260901-six-packages-publish-as-one-version-set.md`"). Two-way lineage is intact. `docs/spec/README.md` → `## Version namespaces` and `docs/vision.md` → `### Packages` / `## Deliberate deferrals` both point to the same pair. `docs/decisions/README.md` → Canonical reading guidance names it as where "Release and packaging work begins" and lists it `accepted` in the Records table.

Independently discovered paths and headings:
- `docs/decisions/20260811-four-layer-endpoint-replicated-harness.md` → Explicit deferrals and implementation boundary; Gate 1 traceability disposition (`G1-DEC-708`, `709`, `814`); Record changelog 2026-09-01
- `docs/decisions/20260729-v2-authority-lives-with-v2.md` → Supersession; Deliberate deferrals; Record changelog
- `docs/decisions/20260728-six-deep-packages-one-version.md` → Supersession; Decision Outcome; Record changelog
- `docs/spec/layer-interfaces.md` → Publication and versions; Deliberate deferrals
- `docs/spec/README.md` → Version namespaces
- `docs/vision.md` → Packages; Deliberate deferrals
- `docs/decisions/README.md` → Canonical reading guidance; Records

### 3. Implementer obligations, affected consumers, and stated assumptions

Answer: **Must do** — publish exactly the six named packages; write one `YYYY.MDD.N` into all six manifests per release; keep the six manifest versions equal (they are all `2026.811.0` at HEAD, matching the ledger's recorded D6 selection); keep `@moltzap/evals` `private: true`; keep `RELEASE_PACKAGES` in `publish.yml` in step with the published set; release only from the tip of `main` via manual dispatch, one at a time; carry `license: Apache-2.0` in every manifest and ship `LICENSE`/`NOTICE` in each tarball; record image digests into `packages/simulator/gke/README.md` → `## Published images` from the release commit.

**Must avoid** — adding a package to the set by any route other than a new decision; letting a published manifest carry `private`; advancing `MOLTZAP_VERSION`, the MCP revision, or a persisted-schema version because the package version moved (or the reverse); owning the wire value anywhere but `packages/identity/src/version.ts`; hand-editing the digest table; relicensing already-published releases; enabling a push trigger before a manual release has proven the prerequisites.

**Enforcement is mechanical and I verified each claim**: `scripts/architecture/check-boundaries.js` fails on a `private` published manifest, on unequal versions across the published set, on evals not private, on `RELEASE_PACKAGES` drift, and on a `MOLTZAP_VERSION` that is missing, non-literal, or not CalVer; the four `test:pack` gates (client, openclaw-channel, nanoclaw-channel, simulator) route through `scripts/test/packed-workspace.mjs`, which checks rewritten sibling pins, `LICENSE`/`NOTICE` presence, and that every `bin` entry ships.

**Affected layers and consumers**: all seven packages (six published, evals private); `.github/workflows/publish.yml`; `scripts/release/{compute-next-version.sh,npm-version-exists.sh,write-published-images.mjs}`; `scripts/test/packed-workspace.mjs`; `scripts/architecture/check-boundaries.js`; root `LICENSE`/`NOTICE`/`README.md`/`CHANGELOG.md`; `packages/*/AGENTS.md` (each now names the record); the GKE profile README; downstream benchmark consumers who install the simulator closure and pin image digests.

**Assumptions stated in the record and its normative owner**:
- *Trust*: the WIF trust "admits only this workflow on `main`"; npm authenticates by trusted publishing with no token; the release App private key is the only stored secret and signs exactly one push. `publish.yml` corroborates: `persist-credentials: false` on checkout, `permissions: contents: read`, the App token minted only at the push step, and a `release` GitHub environment for required reviewers.
- *Safety*: `concurrency: group: publish, cancel-in-progress: false` plus `if: github.ref == 'refs/heads/main'` plus a tip check; every manifest re-verified before the first `npm publish`; `compute-next-version.sh` aborts on any npm failure that is not a 404, because "a registry outage read as 'never published' would reuse a counter that is already taken".
- *Liveness / fault*: a rerun after partial failure converges on the same version, digests, and commit; already-published packages are skipped; images are not byte-reproducible so an attempt's image is reused by digest keyed on version **and** source revision; a release that can never complete is abandoned with `start_new_version`.
- *Compatibility*: the package version is a namespace of its own; exact sibling pins mean a consumer never resolves a mix of releases; pre-record releases keep their declared licenses (Apache-2.0 for protocol/server-core/client/openclaw-channel, MIT for simulator and the root LICENSE — I confirmed this at `ff0da6dc` and `102f1104`); deprecation marks, it does not unpublish; external-consumer cutover is explicitly unresolved.

Independently discovered paths and headings:
- `scripts/architecture/check-boundaries.js` → published/private contract map, `CALENDAR_VERSION`, `publishedVersions`, `RELEASE_PACKAGES` drift check, `version.ts` ownership check
- `scripts/test/packed-workspace.mjs` → file docstring; `bin` map assertion
- `.github/workflows/publish.yml` → header comment; `concurrency`; `permissions`; `Decide whether this run bumps or resumes a release`; `Push the release images or reuse their existing digests`; `Publish every package not yet on npm at this version`
- `scripts/release/compute-next-version.sh` → header block
- `scripts/simulator/../packages/simulator/gke/README.md` → Published images; Release publishing
- `packages/identity/src/version.ts` → `MOLTZAP_VERSION`
- `packages/*/AGENTS.md` → per-package publication lines; `packages/evals/AGENTS.md` → "retained private product"

### 4. Named decision-makers, cited source events, and recorded gaps

Answer: **Decision-maker**: `Tapan Chugh` (candidate frontmatter). `docs/decision-evidence/README.md` → Event-ledger rules states the boundary explicitly: "An ADR's `decision-makers` field names the humans accountable for admission. Stored session events identify only the actor role recorded by the source system," and the ledger repeats that `type` (`user`/`assistant`) "is the only actor field the source keeps." So no event attributes a call to a named person; attribution runs through admission.

**Source**: Claude Code session `df5f25b1-c975-44f8-be49-3d647f87a25f`, nine events with `uuid`, `parentUuid`, UTC timestamp, and stored role.

Calls (each a `user` answer to a preceding `assistant` option set):
- Event 3 (`9af1986a-…`, 2026-09-01T21:28:34Z) — "Simulator closure, one version (Recommended)" and "Retire v2/, move constitution to docs/ (Recommended)", answering Event 2 (`abbd3ed9-…`, 21:24:00Z).
- Event 5 (`21f84fd4-…`, 21:52:49Z) — "Apache-2.0 (matches README)", and housekeeping "Reset CHANGELOG to CalVer, Delete uncited coordbench handoff input, Delete GKE residue namespace, Deprecate old simulator/openclaw-channel", answering Event 4 (`aada0556-…`, 21:51:06Z).
- Event 7 (`5c0254b4-…`, 23:35:25Z) — "1A publish.yml builds+pushes images, writes digests (recommended)", answering Event 6 (`bbbdc5ae-…`, 23:14:55Z).
- Event 9 (`f8e025e5-…`, 2026-09-02T00:13:45Z) — four answers to Event 8 (`44f5b550-…`, 00:10:41Z): D6 "A Set all six manifests to 2026.811.0", D7 "A workflow_dispatch only in PR-R; enable push in a follow-up", D8 "A Fixed order: bump → build+push images … → npm publish (skip existing)", D9 "**B** Keep one atomic PR-R".

**Alternatives** are preserved as the literal option sets: three publication options (including "Simulator + channels only" bundling and "Keep publishing deferred"); two `v2/` options; MIT vs Apache-2.0; 1A/1B/1C for image distribution; A/B for each of D6–D9.

**Reversal**: D9 is the only place the answer departs from the stated recommendation — the agent recommended "A Split: R1 publication ADR + mechanics + images/WIF; R2 v2 retirement + docs rewrite + hygiene"; the answer was "B Keep one atomic PR-R". The ledger records the departure literally and adds no reason.

**Deferral**: D7's selected option itself defers push-triggering to a follow-up; the record's Consequences repeat it.

**Explicitly recorded source gaps** (four, plus scope-level ones):
1. "No source event located for a reason behind either selection." (publication set; `v2/` retirement)
2. "No source event located for a reason behind the license selection."
3. "No source event located for the deprecation of the `@moltzap/client` releases published before the record. Event 2 names only `@moltzap/protocol` and `@moltzap/server-core`; Event 4 and Event 5 name only `@moltzap/simulator` and `@moltzap/openclaw-channel`. … the named decision-maker's admission of the record is its only attribution." The candidate's Deprecations section carries the same disclosure, and the candidate's 2026-09-02 changelog row records that this disclosure was added.
4. "No source event located for a reason behind the D9 selection beyond the question's own text."
Scope-level: downstream bench migrations, simulator features, and unrelated engineering-review questions are omitted; hidden model reasoning, tool payloads, credentials, and account identifiers are not retained; the harness's fixed trailing instruction sentences are omitted.

**Mechanical observations** (kept separate from conversation events, per the ledger rules) — I re-verified each against git and found them accurate: manifest/license state at `ff0da6dc` and `102f1104`; the full `a178413d` manifest inventory, `if: ${{ false }}`, `v2/VERSION` = `2026.827.1`; the `518b06bf`/`73897088` evals-report pair; failed Actions run `31650802123` with its 404 on `@moltzap/simulator`; and the 2026-09-02T00:40Z `npm view` registry state.

Independently discovered paths and headings:
- `docs/decision-evidence/20260901-publication-set-trajectory.md` → Source scope and gaps; Publication set and version policy (Events 1–3); License and housekeeping (Events 4–5); Release mechanics (Events 6–9); Mechanical repository and registry effects
- `docs/decision-evidence/README.md` → Event-ledger rules; Compaction and privacy
- `git show a178413d:packages/*/package.json`, `git show ff0da6dc:packages/{protocol,server,client,openclaw-channel,simulator}/package.json`, `git show ff0da6dc:LICENSE`

### 5. Strongest contradiction, stale instruction, or broken lineage, and its resolution

Answer: **Strongest: `docs/decisions/20260728-gate-1-architecture-freeze.md` → Gate 1 traceability inventory.** Row `G1-DEC-708` still asserts "`v2/VERSION`, all six package manifests, and MoltZap compatibility are exactly `2026.827.1` for this contract revision", and `G1-DEC-709` still frames independence relative to `v2/VERSION`. Both are directly contradicted by the candidate ("The package version is a release namespace of its own. It is independent of the wire compatibility value `MOLTZAP_VERSION`"), by the deletion of `v2/VERSION`, and by the actual manifests (`2026.811.0` against `MOLTZAP_VERSION = "2026.827.1"`). Both rows also carry a **broken locator**: their normative owner is given as "`docs/spec/layer-interfaces.md` — Version contract", and no `Version contract` heading exists in that chapter (the headings are `Publication and versions` and `Deliberate deferrals`). The same defect class recurs on row `G1-DEC-814`, whose owner "`docs/architecture/first-implementation.md` — Gate 4 — Harness implementation boundary and Explicit deferrals" names headings that file does not contain (its headings are `Lane 0`…`Lane 7` and `Final gate`).

**Resolved by the authority order, not a blocker.** `AGENTS.md` → Docs sets the order as agent law and `docs/vision.md`, then current ADR outcomes, then normative `docs/spec/`, then architecture orientation, then historical inputs. Applying it: `docs/vision.md` → Packages and Deliberate deferrals already state the six-package one-version outcome and that the package version is independent of the wire value; the freeze record's own Supersession says "Rows in the inventory below remain a historical snapshot of the 2026-07-28 freeze and are not current where the replacement table says `replaced` … or `deferred`" and, in the same section, "Publication is selected by `20260901-six-packages-publish-as-one-version-set.md`"; `docs/decisions/README.md` → Canonical reading guidance names the four-layer traceability table "the current repository-native decision manifest", and that table's `G1-DEC-708/709/814` rows read "Resolved" and point at the candidate and `layer-interfaces.md` → Publication and versions. The freeze record's status is `partially-superseded` and its 2026-09-01 changelog row records exactly this repointing. So the stale rows are labelled historical by their own record and overridden by two higher sources. The residual defect is cosmetic: two dead heading anchors inside an explicitly historical inventory.

**Second, smaller, and non-blocking:** `scripts/release/compute-next-version.sh` → header block says `TAKEN_VERSIONS` "adds versions npm has never seen but that are claimed anyway: the release tags **on main**", and `.github/workflows/publish.yml` line 132 says "A version whose release commit and tag reached **main** …". The code takes every `refs/tags/v*` from `origin`, which is not branch-scoped — and the candidate's own 2026-09-02 changelog row records that this precise wording was corrected in the ADR ("the counter wording names release tags rather than tags on `main`"). The correction landed in the ADR and in `docs/spec/layer-interfaces.md` but not in the two script comments. Behavior is a safe superset of what the comments describe, and the ADR (higher authority) is correct, so this is a documentation lag to fix, not a contradiction that changes any outcome.

I checked for stale instructions in the obvious blast radius and found none: no `v2/` directory, no `v2/VERSION`, no live `v2/VISION.md` pointer outside dated changelog rows and verbatim historical drafts under `docs/decision-evidence/drafts/` (which `docs/decision-evidence/README.md` → Historical inputs explains are preserved with paths "describ[ing] the tree as it was"); no surviving "publication disabled/deferred" instruction in `AGENTS.md`, `README.md`, `CHANGELOG.md`, `docs/spec/`, `docs/vision.md`, `docs/development/contributing.mdx`, `packages/*/AGENTS.md`, or `.github/`.

Independently discovered paths and headings:
- `docs/decisions/20260728-gate-1-architecture-freeze.md` → Supersession; Gate 1 traceability inventory rows `G1-DEC-708`/`709`/`814`; Record changelog 2026-08-13 and 2026-09-01
- `docs/spec/layer-interfaces.md` → heading list (no `Version contract`)
- `docs/architecture/first-implementation.md` → heading list (no `Gate 4`)
- `AGENTS.md` → Docs (authority order); Project
- `docs/decisions/README.md` → Canonical reading guidance
- `scripts/release/compute-next-version.sh` → header block; `.github/workflows/publish.yml` → `TAKEN_VERSIONS` comment

### 6. Could a teammate implement it without chat, and what is missing

Answer: **Yes.** The decision is not merely implementable, it is already implemented and mechanically gated at this commit, and every binding clause has a discoverable enforcement point. A cold teammate can go from the record to `docs/spec/layer-interfaces.md` → Publication and versions (named as normative owner) to the four gates and the workflow without asking a question. The pieces a first release still needs are named in the record itself, and the operational recipes exist in the repository.

Unresolved items, classified:

| Item | Classification | Where it is resolved or recorded |
|---|---|---|
| npm trusted publishers, release App credentials (`RELEASE_APP_ID` var, `RELEASE_APP_PRIVATE_KEY` secret), and the three Terraform-output repo variables (`GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_RELEASE_SERVICE_ACCOUNT`, `GCP_IMAGE_REPOSITORY`) | Deliberate — the record says these are "maintainer-held prerequisites the repository cannot supply" | `packages/simulator/gke/README.md` → Release publishing gives the exact Terraform-output → Actions-variable table and both non-Terraform prerequisites; `docs/development/contributing.mdx` → Branches and releases points there |
| Running the deprecations | Deliberate — "run by the maintainer after the first release publishes" | `packages/simulator/gke/README.md` → Release publishing carries the five exact `npm deprecate` commands with their version ranges |
| Push-triggered releases | Deliberate — "a later, separate change once a manual release has proven the prerequisites"; traceable to D7 in Events 8/9 | Record → Consequences; `.github/workflows/publish.yml` header comment |
| External-consumer cutover | Deliberate — "the one open release question" | `docs/spec/layer-interfaces.md` → Deliberate deferrals |
| No source event selected the `@moltzap/client` deprecation | Deliberate and disclosed on both sides — attribution is the decision-maker's admission | Record → Deprecations; ledger → License and housekeeping |
| `GCP_IMAGE_REPOSITORY` etc. are named only descriptively in the ADR, with no locator to the table that lists them | Accidental, cosmetic | Reachable because the ADR's Release path names `packages/simulator/gke/README.md`, whose adjacent `## Release publishing` section holds the table |
| The `npm deprecate` recipe lives in a *GKE profile* README | Accidental, cosmetic | Same file, same reachability; an odd home for npm operations, worth relocating or cross-linking |
| Two script comments say release tags are "on main" | Accidental, cosmetic | See Q5; the ADR and spec carry the corrected wording |

None of these requires chat, a private state directory, or an author hint. No binding choice in the record is invented: every one traces either to a literal answer in the ledger or to an enforcement point in the tree, and the two clauses with no selecting event (the `@moltzap/client` deprecation; the reasons behind the license and publication-set picks) are declared as gaps in both the ledger and — for the deprecation — the record.

Independently discovered paths and headings:
- `docs/decisions/20260901-six-packages-publish-as-one-version-set.md` → Consequences; Deprecations
- `packages/simulator/gke/README.md` → Release publishing (prerequisite table; `npm deprecate` block); Published images
- `docs/development/contributing.mdx` → Branches and releases
- `docs/spec/layer-interfaces.md` → Deliberate deferrals
- `scripts/docs/adr/check-shape.ts` → file docstring, `REQUIRED_SECTIONS` (candidate satisfies all three, and carries the changelog rows the point-correction rule demands)

## Discovery trail

| Order | Entry point, search, or navigation step | Path and heading discovered | Result |
|---:|---|---|---|
| 1 | `date -u`, `git rev-parse HEAD`, `sha256sum`, `git status`, `git branch --show-current` | branch `feat/publication-set-release-readiness`, clean tree | Baseline recorded; candidate is unmerged, base is `main` |
| 2 | Read the candidate end to end | All sections plus the three-row Record changelog | Established the binding set and the four provenance anchors |
| 3 | `ls docs/`, `ls docs/decisions/`, `ls docs/decision-evidence/` | Log, evidence dir, `README.md` in each | Located the index and the ledger; noted (did not open) `…-39284b48-cold-review.md` |
| 4 | Read `docs/decision-evidence/20260901-publication-set-trajectory.md` | Source scope and gaps; four cited sections; Events 1–9; mechanical observations | All four ADR anchors resolve to real headings |
| 5 | Read `docs/decisions/README.md` | Canonical reading guidance; status semantics; Records table | Candidate is the entry point for release work and listed `accepted` |
| 6 | `grep -n '^#' docs/spec/layer-interfaces.md`, then read tail | Publication and versions; Deliberate deferrals | Two-way lineage with the candidate confirmed |
| 7 | `grep -r 'G1-DEC-708\|709\|814' docs/` | Freeze inventory rows; four-layer resolved rows; **and six content lines from the quarantined cold-review** | **Misleading/contaminating step** — disclosed below; all later greps excluded review files |
| 8 | Read `20260729-v2-authority-lives-with-v2.md`, `20260728-six-deep-packages-one-version.md`, four-layer Explicit deferrals + traceability + changelog | Supersession sections and dated changelog rows in all three | Lineage is reciprocal and dated in every direction |
| 9 | `node -e require(...)` over `packages/*/package.json` | — | **Failed step**: relative `require` from `[eval]` cannot resolve; retried with grep |
| 10 | grep manifests; read `.github/workflows/publish.yml`; `scripts/release/*`; `scripts/architecture/check-boundaries.js`; `scripts/test/packed-workspace.mjs` | Six at `2026.811.0` Apache-2.0, evals private; concurrency/main gate/one-secret; counter union; four boundary failures; pin + bin + LICENSE/NOTICE checks | Every binding clause has an enforcement point |
| 11 | `LICENSE`, `NOTICE`, `README.md`, `CHANGELOG.md`, `docs/vision.md`, `docs/spec/README.md`, `docs/development/contributing.mdx`, `packages/*/AGENTS.md`, root `AGENTS.md` | Apache-2.0 + mixed-history note; Install section; CalVer changelog; Packages/Deferrals; Version namespaces; per-package publication lines | No stale publication instruction anywhere in the blast radius |
| 12 | `git show a178413d:…` for manifests, workflow, boundary check, client pack script; `git show ff0da6dc/102f1104:…` for licenses | Prior `private` gates, `if: ${{ false }}`, `v2/VERSION`, mixed license state | Every Context claim and every ledger mechanical observation verified |
| 13 | `grep 'Version contract'`; `grep -n '^#' docs/architecture/first-implementation.md` | Two dead anchors in the freeze inventory; a third on `G1-DEC-814` | Primary-source confirmation of the Q5 finding |
| 14 | `grep -i deprecat` excluding review files | `packages/simulator/gke/README.md` → Release publishing | Deprecation recipe with exact ranges exists |
| 15 | `grep '2026.827.1'` and `'2026.811.0'` | Wire value confined to `version.ts` + spec/docs projections; package version separate | Namespace independence holds in practice |
| 16 | Read `scripts/docs/adr/check-shape.ts` header | `REQUIRED_SECTIONS`, changelog rule | Candidate satisfies the mechanical shape gate |

## Author interventions

| Time | Intervention | Effect on review |
|---|---|---|
| Before the task message | Harness injected out-of-checkout context: `/home/tapanc/CLAUDE.md`, `/home/tapanc/moltzap/CLAUDE.md` (a **pre-cutover** copy naming `v2/VISION.md` as the constitution, a live `cutover/four-layer-v2` branch, and "npm continues publishing from `main` until the release cutover is admitted"), and `~/.claude/projects/-home-tapanc-moltzap/memory/MEMORY.md`, whose index includes a line titled "npm publish state 2026-09-01 — half-published 812.0, trusted-publisher 404, decided six-package one-version set + Apache-2.0" | Not used, not opened beyond what was injected, not cited. I deliberately re-derived the same facts from `/home/tapanc/moltzap-pr-r` (this checkout's `AGENTS.md`, the ledger's registry observation, run `31650802123`). The injected memory line pre-states two of the record's outcomes; I flag it because a reader should discount any impression that I found "Apache-2.0" or "six-package one-version set" unaided — I did verify both independently from `NOTICE`, `LICENSE`, the manifests, and Events 4–5 |
| Step 7 of the trail | `grep -rn 'G1-DEC-708\|G1-DEC-709\|G1-DEC-814' docs/` returned six content lines from the quarantined `docs/decision-evidence/20260901-six-packages-publish-as-one-version-set-39284b48-cold-review.md`, including fragments of its answers to Q1, Q2 and Q5 — among them its statement of the freeze-record "Version contract" stale-anchor finding and its resolution | I stopped using that output immediately, disclosed it, and excluded `*-cold-review.md`, `*-invalid-review.md`, and `*-blind-review.md` from every subsequent search. My Q5 finding was also reachable independently (steps 8 and 13 hit the same rows via `v2/VERSION` and `Version contract` greps against primary files), and I re-derived it from `20260728-gate-1-architecture-freeze.md`, `docs/spec/layer-interfaces.md`, and `docs/architecture/first-implementation.md` directly. I additionally surfaced a second Q5 candidate (the "release tags on main" comment lag) that did not appear in the leaked lines. **Per `docs/decision-evidence/README.md` → Artifact types, "A command that returns an answer or verdict from one of those quarantined blind-review records invalidates the fresh run"; the maintainer should decide whether this run counts** |
| Throughout | No contact with the author; no question asked; no file modified; no build, install, or test run | — |

## Blockers

| ID | Finding | Evidence | Required reconciliation |
|---|---|---|---|
| B1 | **Quarantine breach (procedural, not a defect in the record).** A grep over `docs/` returned answer text from the candidate's own quarantined prior cold-review | `docs/decision-evidence/README.md` → Artifact types: "A command that returns an answer or verdict from one of those quarantined blind-review records invalidates the fresh run." Leaked lines came from `docs/decision-evidence/20260901-six-packages-publish-as-one-version-set-39284b48-cold-review.md` | Maintainer decides whether to accept this run with the disclosure or re-run the gate with a reviewer instructed to path-exclude review artifacts from every recursive search up front |
| N1 | Non-blocking: three dead heading anchors in the freeze record's historical inventory — `G1-DEC-708`/`709` cite "`docs/spec/layer-interfaces.md` — Version contract" and `G1-DEC-814` cites "`docs/architecture/first-implementation.md` — Gate 4 — Harness implementation boundary and Explicit deferrals"; neither heading exists | `docs/decisions/20260728-gate-1-architecture-freeze.md` lines 339, 340, 377 vs. the heading lists of both targets | Resolved by authority order (see Q5); optionally repoint the three locators in a dated point correction so the historical inventory stops citing headings that no longer exist |
| N2 | Non-blocking: `scripts/release/compute-next-version.sh` header ("the release tags on main") and `.github/workflows/publish.yml` line 132 ("tag reached main") retain the wording the candidate's 2026-09-02 changelog row corrected; the code reads all `refs/tags/v*` from `origin` | Script header vs. `git ls-remote --tags --refs origin 'refs/tags/v*'` and the candidate's "a `v<version>` release tag already claims" | Carry the same wording correction into the two comments |

## Overall result

Result (reviewer, verbatim): **FAIL**

Rationale (reviewer, verbatim): All six answers are accurate and were confirmed against primary sources, and the record itself holds up unusually well against the substance of the result rule: status, lineage, authority, assumptions, normative ownership, and source-event attribution are consistent in every direction I checked. Every binding clause has a mechanical enforcement point I verified in the tree; the reciprocal pointer between the record and `docs/spec/layer-interfaces.md` → Publication and versions is intact; all three superseded-deferral records carry dated changelog rows; every provenance anchor resolves; and the ledger's mechanical observations reproduce exactly against `git show`. The one normative contradiction I found (Q5) resolves cleanly through the stated authority order, and the remaining gaps are all deliberate and documented — including the ledger's disclosed no-source-event gap for the `@moltzap/client` deprecation, which the record itself repeats rather than papering over.

The result is nevertheless FAIL, on the gate's own terms rather than the record's. `docs/decision-evidence/README.md` → Artifact types states that "A command that returns an answer or verdict from one of those quarantined blind-review records invalidates the fresh run," and step 7 of my trail did exactly that: a recursive grep surfaced the prior cold-review's answers to Q1, Q2 and Q5, including the finding I went on to report in Q5. I re-derived that finding from primary files and added a second, unleaked one, but I cannot certify the run as blind, and a reviewer's own assurance that contamination "didn't matter" is precisely what this gate exists not to accept. My reading is that the record is substantively ready and the *run* is not: a re-run with recursive searches path-excluding review artifacts from the first command should clear it, and I would expect that run to reach the same conclusions.

Classification by the author on retention: **INVALID** per `docs/decision-evidence/README.md` → Artifact types (quarantined output returned by a command) and per the unchecked attestation lines. The run neither admits nor rejects the record; the maintainer rules on it.

## Maintainer acceptance

The reviewer result is evidence, not self-certifying acceptance. The
maintainer verifies that it applies to the exact candidate identity
above and records the gate decision.

| Field | Value |
|---|---|
| Maintainer | `_fill_` |
| Reviewed result | `20260901-six-packages-publish-as-one-version-set-81008c9a-invalid-review` |
| Candidate identity matches | `_yes or no_` |
| Gate decision | `_ACCEPTED or REJECTED_` |
| Decision time | `_fill ISO 8601 timestamp_` |
| Rationale | `_fill_` |

## Rerun identity

| Field | Value |
|---|---|
| Superseded by review run | `_fill new review run ID_` |
| Superseded candidate commit | `81008c9adb9366cda4d158963c4fb67b6c4d7839` |
| Superseded candidate content digest | sha256 `5449a7ccde8c488cdf9cff80efa83011f232a834dd747a8e9bf35801ff4cfd6a` |
| Reason a rerun was required | Quarantine breach (B1) and harness-injected context disclosed by the reviewer make this run invalid; the non-blocking N1 and N2 wording corrections are applied before the next candidate is frozen. The next run uses a reviewer process whose working directory and context lie outside the parent project, so no project instructions or memory index reach it. |
