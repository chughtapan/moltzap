# Blind decision review record

Blind review of `docs/decisions/20260901-six-packages-publish-as-one-version-set.md`
at candidate commit `39284b48`, run per the `cold-read` skill in
repository-scoped (`--questions`) mode. The reviewer received the checkout
root, the candidate path, and the six fixed questions from
`.claude/skills/cold-read/references/questions.md`; nothing else from the
author. Answers below are the reviewer's, verbatim.

## Review identity

| Field | Value |
|---|---|
| Review run ID | `20260901-six-packages-publish-as-one-version-set-39284b48-cold-review` |
| Candidate commit | `39284b483e93a92ce3fd5c58f37e9d9b0c70482e` |
| Candidate tree | `ef33927166f9a7613a09a3c16a0a4bbd93c2c997` |
| Candidate content digest | sha256 `0e96f8f4faeef66d7e60bed6e7c83bbb978a9171c4fd71a1834709f7dee78b40` (record); sha256 `9d17eae00072bfca23b2917e9fcb2fe62676b908cb62c63fa03cef1599e5a6c3` (trajectory) |
| Digest scope and command | `git checkout 39284b483e93a92ce3fd5c58f37e9d9b0c70482e && sha256sum docs/decisions/20260901-six-packages-publish-as-one-version-set.md docs/decision-evidence/20260901-publication-set-trajectory.md` |
| Reviewer | Claude Code `general-purpose` subagent dispatched by the `cold-read` skill (repository-scoped mode) |
| Reviewer session | fresh subagent context, no parent conversation, summary, or memory handed over; dispatched 2026-09-02T03:38Z with the checkout root, the candidate path, and the fixed questions only |
| Review started | 2026-09-02T03:38:07Z |
| Review finished | 2026-09-02T03:44:13Z |
| Review duration | 6m 06s |
| Review budget | one uninterrupted run; no mid-run interaction permitted |
| Rerun of | none |
| Rerun reason | none |

## Fresh-context attestation

The reviewer attests (verbatim):

- [x] I did not author or reconcile the candidate decision.
- [ ] I received no inherited conversation, summary, memory, private state, or earlier blind-review output about the candidate. — The harness system prompt injected (a) the `CLAUDE.md` of a *different* checkout (`/home/tapanc/moltzap`, cutover-era text naming `v2/VISION.md` as constitution) and (b) an auto-memory index whose one line reads "[npm publish state 2026-09-01] — half-published 812.0, trusted-publisher 404, decided six-package one-version set + Apache-2.0". I did not open that memory file or use either as evidence; every answer below cites repository content in `/home/tapanc/moltzap-pr-r`. No blind-review output reached me.
- [x] I received only the clean candidate checkout and the fixed questions. (Modulo the harness-injected context disclosed above, which was not from the author and carried no file pointers.)
- [x] I received no out-of-band tour, decision or file pointer, search term, expected answer, or answer key.
- [x] I navigated the repository independently. I may have used checked-in entry points, repository-native indexes, ordinary search, and repository history after discovering them myself.
- [x] I did not open, read, or search the contents of an earlier cold-review or invalid-review record. (I also did not open any `*-blind-review.md` or `*-source-gap.md` file.)
- [x] I did not ask the author for help or modify the candidate before submitting these answers.
- [x] The author interventions recorded below are complete.

## Fixed questions and verbatim answers

The six questions live in `.claude/skills/cold-read/references/questions.md`.

### 1. Current decision, problem resolved, binding vs. context

Answer: The record makes current that **six packages publish to npm as one calendar version set and `@moltzap/evals` stays private**. It resolves the deferred publication membership / version coordination / release ordering that the four-layer record (`G1-DEC-708`, publication halves of `G1-DEC-709` and `G1-DEC-814`), the V2-authority record, and the six-deep-packages record had left open, and under which `.github/workflows/publish.yml` was disabled.

Binding (Decision Outcome and its subsections): the publication set (identity, router, client, openclaw-channel, nanoclaw-channel, simulator public; evals never published; no other package added); one `YYYY.MDD.N` version across all six, counter one past the highest published that day or claimed by a `v<version>` tag, exact sibling pins; package version independent of `MOLTZAP_VERSION`, MCP revision, and persisted-schema versions, with `packages/identity/src/version.ts` the sole wire-value owner; the release path (manual dispatch from `main`, one run computes/writes/builds/packs/pushes images/records digests/regenerates docs/stamps CHANGELOG/commits `chore(release): moltzap@<version>`/publishes with provenance; convergent reruns; `start_new_version`; single serialized run from tip of `main`; WIF + trusted publishing; the App private key as the only stored secret); Apache-2.0 for repository and every published package; deprecation of `@moltzap/protocol`, `@moltzap/server-core` in full and of every pre-record `@moltzap/client`, `@moltzap/simulator`, `@moltzap/openclaw-channel` release; retirement of `v2/` (constitution → `docs/vision.md`, cited inputs → `docs/decision-evidence/{inputs,drafts}/`, `v2/VERSION` deleted). "What this record resolves" is binding lineage: it changes no other outcome, and names `docs/spec/layer-interfaces.md` → Publication and versions as normative owner.

Context / non-normative: "Context and Problem Statement" (history of the deferral, registry state, license disagreement); "Consequences" (what the boundary check and `test:pack` gates enforce, maintainer-held prerequisites, push-trigger as a later change, external-consumer cutover still open); "Record changelog" (two pre-admission point corrections, Decision Outcome unchanged). The provenance ledger is explicitly non-normative ("does not supply architecture authority").

Independently discovered paths and headings:
- `docs/decisions/20260901-six-packages-publish-as-one-version-set.md` → Decision Outcome; Publication set; One version; Release path; License; Deprecations; Retired directory; What this record resolves; Consequences; Record changelog
- `docs/decisions/README.md` → Canonical reading guidance ("Release and packaging work begins with the publication set"); status semantics
- `docs/decision-evidence/20260901-publication-set-trajectory.md` → opening paragraph ("non-normative ledger")

### 2. Earlier outcomes replaced, retained, untouched; where the normative contract lives

Answer: Replaced/selected: the publication deferrals only — `G1-DEC-708` and the publication halves of `G1-DEC-709`/`G1-DEC-814` in the four-layer record (its traceability table rows now read "Resolved — ..." and point to this record and to `layer-interfaces.md` → Publication and versions; its explicit-deferral paragraph was repointed); the "Publishing from V2 … npm continues to publish from `main` until a separate cutover decision" deferral in `20260729-v2-authority-lives-with-v2.md` (Supersession + 2026-09-01 changelog rows); and the version/publication policy the Supersession section of `20260728-six-deep-packages-one-version.md` left deferred (its historical body still says `v2/VERSION` must match the six manifests — historical, superseded by the candidate per its own Supersession text). The candidate also states it changes no other outcome: the seven-package graph, public boundaries, and layer contracts in `layer-interfaces.md` are untouched. Untouched deferrals: external-consumer cutover (named in `layer-interfaces.md` → Deliberate deferrals); pruning/GC/retention/disk-loss recovery remain unselected in the four-layer record.

Normative contract: `docs/spec/layer-interfaces.md` (Status: "Gate 1 normative") → **Publication and versions** carries the rules (six-package set, evals private, `YYYY.MDD.N` one past the highest npm-or-tag counter, exact sibling pins, version independence, release from `main` via `publish.yml` with provenance and image digests, boundary-check and `test:pack` enforcement). `docs/spec/README.md` → Version namespaces and `docs/vision.md` → Packages / Deliberate deferrals defer to that section and this record. The freeze record `20260728-gate-1-architecture-freeze.md` is historical for these rows (see Q5).

Independently discovered paths and headings:
- `docs/decisions/20260811-four-layer-endpoint-replicated-harness.md` → Gate 1 traceability disposition rows `G1-DEC-708/709/814`; explicit-deferral paragraph; Record changelog 2026-09-01
- `docs/decisions/20260729-v2-authority-lives-with-v2.md` → Supersession; Deliberate deferrals; Record changelog
- `docs/decisions/20260728-six-deep-packages-one-version.md` → Supersession; Record changelog
- `docs/spec/layer-interfaces.md` → Purpose; Exact package graph; Publication and versions; Deliberate deferrals
- `docs/spec/README.md` → Version namespaces
- `docs/vision.md` → Packages; Deliberate deferrals
- `docs/decisions/20260728-gate-1-architecture-freeze.md` → Supersession

### 3. Implementer obligations, affected layers/consumers, assumptions

Answer: Do: keep the six manifests non-private, Apache-2.0, at one identical `YYYY.MDD.N` version (currently `2026.811.0` in all six); keep evals `private: true`; keep `RELEASE_PACKAGES` in `publish.yml` equal to the published set (`scripts/architecture/check-boundaries.js` fails otherwise, and fails vacuously-guarded if no published manifest is scanned); keep `packages/identity/src/version.ts → MOLTZAP_VERSION` as the sole wire value and never couple it to the package version; release only via manual `workflow_dispatch` of `publish.yml` from the tip of `main` (job `if: github.ref == 'refs/heads/main'`, `concurrency: publish`); let reruns resume an incomplete release commit, use `start_new_version` only to abandon one; each pack gate (`client`, `openclaw-channel`, `nanoclaw-channel`, `simulator` `test:pack` via `scripts/test/packed-workspace.mjs`) must prove the tarball closure installs with exact pins and executables. Avoid: adding an eighth package, a compatibility facade, or restoring removed Simulator contracts (`layer-interfaces.md` → Deliberate deferrals); publishing evals; switching to a push trigger (deferred); re-creating `v2/` paths.

Affected layers/consumers: all six published packages plus evals (private); downstream benchmarks installing `@moltzap/simulator` (closure identity/router/client); container images (controller, OpenClaw, NanoClaw) pinned by digest from `packages/simulator/gke/README.md` → Published images; existing npm consumers of `@moltzap/protocol`, `@moltzap/server-core`, and pre-record `@moltzap/client`/`simulator`/`openclaw-channel` releases (deprecated).

Assumptions stated: trust — WIF provider `attribute_condition` admits only `publish.yml@refs/heads/main` of this repository (`packages/simulator/gke/terraform/main.tf`); npm trusted publishing (no npm token); the only stored secret is `RELEASE_APP_PRIVATE_KEY`, used for one atomic push. Fault/liveness — registry answers other than 404 abort rather than being read as "absent" (`scripts/release/npm-version-exists.sh`, `compute-next-version.sh`); image builds are not byte-reproducible so an attempt tag `<version>-<sha>` is reused; reruns converge on the same version/digests/commit; a stuck release is abandoned by hand. Safety — the tip-of-`main` check and `persist-credentials: false` keep pre-push steps tokenless. Compatibility — package version implies no wire/MCP/schema compatibility; consumers pin one version and one digest set per release; pre-record releases are deprecated, not removed. Fault, trust, and liveness assumptions for the *runtime protocol* are not part of this record (unchanged in `layer-interfaces.md` → Cross-layer laws).

Independently discovered paths and headings:
- `.github/workflows/publish.yml` → header comment; `on.workflow_dispatch`; `concurrency`; job `if`; steps "Decide whether this run bumps or resumes a release", "Push the release images or reuse their existing digests", "Publish every package not yet on npm at this version"
- `scripts/architecture/check-boundaries.js` → published/private contract table; `CALENDAR_VERSION`; one-version check; `RELEASE_PACKAGES` drift check
- `scripts/release/compute-next-version.sh`, `scripts/release/npm-version-exists.sh`, `scripts/release/write-published-images.mjs` → header comments
- `packages/simulator/gke/README.md` → Published images; Release publishing
- `packages/simulator/gke/terraform/main.tf` → `google_iam_workload_identity_pool_provider.github_actions` `attribute_condition`
- `packages/*/package.json` (name/version/license/private), `packages/identity/src/version.ts`, `LICENSE`, `NOTICE`, `README.md` → Install; License
- `packages/{identity,router,simulator,evals}/AGENTS.md` publication lines

### 4. Decision-makers, cited source events, explicit source gaps

Answer: `decision-makers: Tapan Chugh` (frontmatter). The ledger records source system "Claude Code session transcript", session `df5f25b1-c975-44f8-be49-3d647f87a25f`, with actor roles only `user`/`assistant`:

- Event 1 (`a0a49b29…`, 2026-09-01T21:12:20Z, user): task text — "Simualator package should now be distributed over npm."
- Event 2 (`abbd3ed9…`, 21:24:00Z, assistant): options for publication set (Simulator closure one version / Simulator+channels only / Keep deferred) and for `v2/` (Retire v2/ move constitution / Keep v2/ as-is).
- Event 3 (`9af1986a…`, 21:28:34Z, user): answers "Simulator closure, one version (Recommended)" and "Retire v2/, move constitution to docs/ (Recommended)". Gap recorded: "No source event located for a reason behind either selection."
- Event 4 (`aada0556…`, 21:51:06Z, assistant): license options (MIT / Apache-2.0), a ledger-catalog question, and housekeeping options (deprecate old simulator/openclaw-channel `<=2026.811.0`, reset CHANGELOG to CalVer, delete uncited coordbench input, delete GKE residue namespace).
- Event 5 (`21f84fd4…`, 21:52:49Z, user): "Apache-2.0 (matches README)"; "Keep exact equality" (noted as belonging to a simulator change, not this record); all four housekeeping items. Gap recorded: "No source event located for a reason behind the license selection."
- Event 6 (`bbbdc5ae…`, 23:14:55Z, assistant): D2 image-distribution options 1A/1B/1C. Event 7 (`5c0254b4…`, 23:35:25Z, user): "1A publish.yml builds+pushes images, writes digests".
- Event 8 (`44f5b550…`, 2026-09-02T00:10:41Z, assistant): D6 (set six manifests to 2026.811.0 vs tolerant guard), D7 (workflow_dispatch only vs push+var), D8 (fixed convergent order vs npm-first), D9 (split R1/R2 vs one atomic PR). Event 9 (`f8e025e5…`, 00:13:45Z, user): A, A, A, and "B Keep one atomic PR-R" — a reversal of the agent's D9 recommendation. Gap recorded: "No source event located for a reason behind the D9 selection beyond the question's own text."

Other explicit gaps/omissions: the session's bench-migration, simulator-feature, and engineering-review events are omitted; hidden reasoning, tool payloads, credentials, account identifiers not retained; the harness's fixed instruction sentences omitted. Mechanical observations (separate from conversation events): `a178413d` state of `publish.yml` (`if: ${{ false }}`) and manifests; deletion of the evals GKE report (`518b06bf`/`73897088`); Actions run `31650802123` (2026-08-12, head `102f1104…`) publishing protocol/server-core/client 2026.812.0 and failing on simulator with 404; `npm view` at 2026-09-02T00:40Z (identity/router/nanoclaw/evals E404; simulator `2026.811.0`; openclaw `latest` `2026.811.0`; client/protocol/server-core `latest` `2026.812.0`).

Not attributed by any event and not marked as a gap: the deprecation of pre-record `@moltzap/client` releases (Event 2 names only protocol/server-core; Event 4 names only simulator/openclaw-channel), and the statement that pre-record releases "were MIT-licensed". The source transcript itself is not checked in; locators cannot be verified from the repository (by design per `docs/decision-evidence/README.md` → Compaction and privacy).

Independently discovered paths and headings:
- `docs/decision-evidence/20260901-publication-set-trajectory.md` → Source scope and gaps; Publication set and version policy (Events 1–3); License and housekeeping (Events 4–5); Release mechanics (Events 6–9); Mechanical repository and registry effects
- `docs/decision-evidence/README.md` → Event-ledger rules; Compaction and privacy
- Candidate frontmatter `decision-makers`

### 5. Strongest contradiction, stale instruction, or broken lineage

Answer: **Strongest (unresolved, reported as blocker B1):** Candidate → License says "Releases published before this record were MIT-licensed and stay so" (echoed in `CHANGELOG.md` → "Changed: license": "Releases before this one were published under MIT"). The record's own ledger (Event 4) states "identity/router/client/openclaw-channel say Apache-2.0, simulator/evals/nanoclaw-channel say MIT, root LICENSE is MIT", and repository history confirms it: at the 2026.811.0 release commit `ff0da6dc` and at the 2026.812.0 head `102f1104`, `packages/{protocol,client,openclaw-channel}/package.json` declare `"license": "Apache-2.0"` with `files: ["dist"]` (no LICENSE file in the tarball), while only `simulator` declares MIT; `ebe33577 chore: license all packages as Apache-2.0` predates those releases. Authority order does not resolve this: the ADR governs *decisions*, but this is a factual claim about already-published artifacts that the ADR's cited evidence and git history both contradict.

**Second (resolved by authority order):** `docs/decisions/20260728-gate-1-architecture-freeze.md` → Gate 1 traceability inventory rows `G1-DEC-708`/`G1-DEC-709` say "`v2/VERSION`, all six package manifests, and MoltZap compatibility are exactly `2026.827.1`" with owner "`docs/spec/layer-interfaces.md` — Version contract" — a heading that no longer exists, and manifests are `2026.811.0` with `v2/VERSION` deleted. Resolution: the freeze record's Supersession section declares the inventory "a historical snapshot … not current where the replacement table says replaced … or deferred" and states "Publication is selected by `20260901-…`"; `docs/decisions/README.md` names the four-layer traceability table "the current repository-native decision manifest", and that table's `G1-DEC-708/709` rows point to `layer-interfaces.md` → Publication and versions. Likewise `20260728-six-deep-packages-one-version.md` → Decision Outcome ("One CalVer value in `v2/VERSION` must exactly match…") is historical body superseded by its own Supersession section. No stale `v2/`, `cutover/four-layer`, or "publication disabled" instruction remains in `AGENTS.md`, `README.md`, `docs/spec/`, `docs/vision.md`, `packages/*/AGENTS.md`, or `.github/`.

Independently discovered paths and headings:
- Candidate → License; `CHANGELOG.md` → Changed: license
- `docs/decision-evidence/20260901-publication-set-trajectory.md` → License and housekeeping (Event 4), Mechanical repository and registry effects
- `git show ff0da6dc:packages/{protocol,client,openclaw-channel,simulator}/package.json`; `git show ff0da6dc:LICENSE`; `git log -S'"license": "Apache-2.0"' -- packages/client/package.json` (→ `ebe33577`)
- `docs/decisions/20260728-gate-1-architecture-freeze.md` → Supersession; Gate 1 traceability inventory
- `docs/decisions/20260811-four-layer-endpoint-replicated-harness.md` → Gate 1 traceability disposition
- `docs/decisions/README.md` → Canonical reading guidance

### 6. Implementable without chat or guessing? Missing links and unresolved choices

Answer: Mostly yes for the mechanics — the workflow, scripts, boundary check, pack gates, manifests, license files, and `v2/` retirement are all present at HEAD and match the record. Remaining items:

1. Maintainer-held prerequisites (npm trusted publishers for six packages; `RELEASE_APP_ID` var + `RELEASE_APP_PRIVATE_KEY` secret; `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_RELEASE_SERVICE_ACCOUNT`, `GCP_IMAGE_REPOSITORY` vars from Terraform outputs; `release` environment reviewers) — **deliberate deferral**, documented in Consequences and `packages/simulator/gke/README.md` → Release publishing. Whether they are configured is Not discoverable from the repository.
2. Push-triggered release — **deliberate deferral** (Consequences; Event 8/9 D7).
3. External-consumer cutover — **deliberate deferral** (`layer-interfaces.md` → Deliberate deferrals).
4. Deprecation execution: no script, no deprecation message text, and no exact version ranges in the record; the ledger's Event 4 option text gives `<=2026.811.0` for simulator/openclaw-channel "with a pointer to the ADR", and the mechanical section gives the last versions (client/protocol/server-core `2026.812.0`). An implementer must derive the `npm deprecate` commands — **accidental gap** (minor; recoverable from the ledger).
5. Pre-record `@moltzap/client` deprecation has no cited source event and no `No source event located` marker — **accidental gap** in provenance (blocker B2).
6. "Releases published before this record were MIT-licensed" is contradicted by the ledger and git history — **accidental error** (blocker B1).
7. Minor divergence: the record says the counter honors "a `v<version>` tag on `main`"; `publish.yml` collects every `refs/tags/v*` on `origin` regardless of branch. Tags are only created by this workflow's atomic push to `main`, so no practical ambiguity — noting only.

Independently discovered paths and headings:
- Candidate → Consequences; Deprecations; One version
- `packages/simulator/gke/README.md` → Release publishing
- `.github/workflows/publish.yml` → "Decide whether this run bumps or resumes a release" (`TAKEN_VERSIONS`)
- `docs/decision-evidence/20260901-publication-set-trajectory.md` → License and housekeeping; Mechanical repository and registry effects
- `docs/spec/layer-interfaces.md` → Deliberate deferrals
- repo-wide grep for `npm deprecate` (no script found)

## Discovery trail

| Order | Entry point, search, or navigation step | Path and heading discovered | Result |
|---:|---|---|---|
| 1 | `date`, `git rev-parse HEAD`, `HEAD^{tree}`, `sha256sum` candidate | — | Identifiers captured |
| 2 | Read candidate | `docs/decisions/20260901-…md` → all sections | Provenance links, three prior records, spec owner named |
| 3 | `ls docs/decisions docs/decision-evidence`; `git log` on candidate and ledger; `git branch` | Directory listings; commits `feca0481`, `537df8b9`, `39284b48`; branch `feat/publication-set-release-readiness` | Quarantined names noted, not opened; candidate not on `main` |
| 4 | Read `docs/decisions/README.md`, `docs/decision-evidence/README.md` | Canonical reading guidance; Records table; Event-ledger rules; Historical inputs | Authority order, status semantics, ledger rules |
| 5 | Read ledger | `…/20260901-publication-set-trajectory.md` → all headings | Nine events, gaps, mechanical effects; anchors resolve |
| 6 | grep prior records for `G1-DEC-708/709/814`, publication, defer | four-layer → traceability rows + deferral paragraph; v2-authority → Supersession/Deferrals/changelog; six-deep → Supersession/changelog | Lineage consistent with candidate |
| 7 | awk sections of `docs/spec/layer-interfaces.md` | Publication and versions; Deliberate deferrals; Exact package graph; Purpose | Normative owner text matches candidate |
| 8 | `ls v2`, `ls docs/vision.md`, grep `AGENTS.md`, repo-wide grep `v2/VISION|v2/VERSION|v2/AGENTS` | `v2/` absent; `docs/vision.md` present; only historical/changelog mentions remain | Retirement executed |
| 9 | node over `packages/*/package.json`; `LICENSE`; `version.ts`; `CHANGELOG.md` head | Six at `2026.811.0` Apache-2.0; evals private; LICENSE Apache; `MOLTZAP_VERSION=2026.827.1` | Manifest state matches record |
| 10 | Read `.github/workflows/publish.yml` | header; plan/images/commit/publish steps | Release path matches record |
| 11 | grep `check-boundaries.js`; gke README; `test:pack`; `ls scripts/release` | published/private table; one-version and RELEASE_PACKAGES checks; Published images / Release publishing | Consequences verified |
| 12 | Read `compute-next-version.sh`, `npm-version-exists.sh`; `git tag`; `ls packed-workspace.mjs`; grep `npm deprecate` | Version and existence helpers; zero tags; no deprecation script | Gap 4 identified |
| 13 | grep terraform for WIF; read freeze Supersession | `main.tf` `attribute_condition`; freeze → Supersession + inventory rows 708/709 | Trust claim verified; stale "Version contract" heading found and resolved |
| 14 | `git log --grep="chore(release)"`; `git show ff0da6dc`/`102f1104` manifests; `git log -S'Apache-2.0'` | Pre-record release manifests: protocol/client/openclaw Apache-2.0, simulator MIT; `ebe33577` | Contradiction with License section (B1) |
| 15 | grep ledger for `client`; read `docs/spec/README.md` → Version namespaces; `docs/vision.md` → Deliberate deferrals; README Install/License; `packages/*/AGENTS.md` | Cross-references all point to candidate | Client deprecation has no event (B2) |
| 16 | `git diff feca0481 HEAD` on candidate; `git log` on publish.yml | Two pre-admission revisions match changelog rows | Changelog honest |
| 17 | grep for stale cutover-era statements in docs/README/AGENTS/.github | none | No stale instructions |
| 18 | `scripts/docs/adr/check-shape.ts` grep | STATUSES, provenance link/anchor, changelog rule | Shape rules understood; candidate conforms |
| 19 | `date` | — | Finish time |

Misleading step: the initial WIF grep on `packages/simulator/gke/*.tf` returned nothing because the files live in `gke/terraform/`; retried successfully.

## Author interventions

| Time | Intervention | Effect on review |
|---|---|---|
| 2026-09-02T03:38Z (session start) | Harness-injected system context: `CLAUDE.md` from a different checkout (`/home/tapanc/moltzap`, cutover-era) and an auto-memory index line "npm publish state 2026-09-01 — half-published 812.0, trusted-publisher 404, decided six-package one-version set + Apache-2.0". Not from the author; no file pointers. | Disclosed in attestation. Not used as evidence; the memory file was not opened; all findings trace to repository paths above. No quarantined review output reached me. |

## Blockers

| ID | Finding | Evidence | Required reconciliation |
|---|---|---|---|
| B1 | Decision Outcome → License states a historical fact contradicted by the record's own ledger and by git history. | Candidate: "Releases published before this record were MIT-licensed and stay so." `CHANGELOG.md`: "Releases before this one were published under MIT." Ledger Event 4: "identity/router/client/openclaw-channel say Apache-2.0, simulator/evals/nanoclaw-channel say MIT, root LICENSE is MIT". `git show ff0da6dc:packages/client/package.json` → `"license": "Apache-2.0"`, `"files": ["dist"]`; same for `protocol` and `openclaw-channel`; `simulator` → `MIT`; `ebe33577 chore: license all packages as Apache-2.0` predates the releases. | Restate the pre-record license state as the ledger records it (mixed: manifests of protocol/client/openclaw-channel declared Apache-2.0 while the root LICENSE and simulator manifest were MIT), or state only that pre-record releases keep the license their published manifests declare; align `CHANGELOG.md` → "Changed: license" in the same change with a dated Record changelog row. |
| B2 | Binding deprecation of every pre-record `@moltzap/client` release has no cited source event, and the ledger records no gap for it. | Candidate → Deprecations: "Every `@moltzap/client` release published before this record carries the v1 API and is deprecated." Ledger Event 2 option: "Deprecate @moltzap/protocol and @moltzap/server-core on npm."; Event 4 option: "npm deprecate @moltzap/simulator and @moltzap/openclaw-channel <=2026.811.0". No event names client deprecation; `docs/decision-evidence/README.md` → Event-ledger rules: "When no supporting event is present, write `No source event located`". | Add the source event that selected client deprecation, or add an explicit `No source event located` entry for it in the ledger (and, if none exists, have the maintainer confirm the choice at admission as the `decision-makers` field implies). |

## Overall result

Result: **FAIL**

Rationale (reviewer, verbatim): Questions 1–4 and 6 are answerable from the repository with consistent status, lineage, authority order, and normative ownership; the release mechanics, boundary checks, manifests, `v2/` retirement, and every cited path and anchor resolve, and the two pre-admission changelog rows honestly describe the diffs. The record fails the result rule on two points. First, an unresolved contradiction: the Decision Outcome's License section asserts that all pre-record releases were MIT-licensed, while the cited ledger (Event 4) and the manifests at the actual release commits (`ff0da6dc`, `102f1104`) show protocol, client, and openclaw-channel declaring Apache-2.0; authority order cannot repair a factual claim that the record's own evidence contradicts. Second, inconsistent source-event attribution: the binding deprecation of pre-record `@moltzap/client` releases has no cited event and no recorded gap, contrary to the ledger rules. Both are point corrections (the six-package one-version Decision Outcome itself is well-sourced and unaffected), but as written the record cannot pass a blind read.

## Maintainer acceptance

The reviewer result is evidence, not self-certifying acceptance. The
maintainer verifies that it applies to the exact candidate identity
above and records the gate decision. The one unchecked attestation line
(harness-injected project instructions and memory index, disclosed above)
is for the maintainer to weigh when deciding whether this run counts as
FAIL or INVALID; either way it does not admit the candidate.

| Field | Value |
|---|---|
| Maintainer | `_fill_` |
| Reviewed result | `20260901-six-packages-publish-as-one-version-set-39284b48-cold-review` |
| Candidate identity matches | `_yes or no_` |
| Gate decision | `_ACCEPTED or REJECTED_` |
| Decision time | `_fill ISO 8601 timestamp_` |
| Rationale | `_fill_` |

## Rerun identity

| Field | Value |
|---|---|
| Superseded by review run | `_fill new review run ID_` |
| Superseded candidate commit | `39284b483e93a92ce3fd5c58f37e9d9b0c70482e` |
| Superseded candidate content digest | sha256 `0e96f8f4faeef66d7e60bed6e7c83bbb978a9171c4fd71a1834709f7dee78b40` |
| Reason a rerun was required | Blockers B1 and B2 above: the License section's claim about pre-record releases and the unattributed `@moltzap/client` deprecation are corrected in the record, trajectory, CHANGELOG, and NOTICE, which changes the candidate. |
