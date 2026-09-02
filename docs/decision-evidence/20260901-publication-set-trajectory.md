# Publication set decision trajectory

This non-normative ledger compacts the recoverable source events for the
decision that six packages publish to npm as one version set. It does not
supply architecture authority.

## Source scope and gaps

The source is the Claude Code session
`df5f25b1-c975-44f8-be49-3d647f87a25f`, stored as a JSON-lines transcript
under the project's session directory. Each retained event cites the record's
stored `uuid`, its `parentUuid` when present, its UTC `timestamp`, and its
stored `type`, which is the only actor field the source keeps (`user` or
`assistant`).

The maintainer answered the agent's structured questions through the
harness's question tool. The source stores each answer as the tool's result
inside a `user` record, so the literal excerpts below are the answer strings
that record carries; the surrounding tool envelope is omitted. Option labels
and descriptions from the preceding `assistant` question record are retained
because a reply such as `A` has no meaning without them.

The session also covers the downstream benchmark migrations, the simulator
features, and the engineering-review questions that do not bear on this
record. Those events are omitted. Hidden model reasoning, tool payloads,
credentials, and account identifiers are not retained.

Where the retained events state no reason for a selection, none is recorded
here: `No source event located` marks each such gap rather than a
reconstruction.

Quoted text is reproduced character for character. Code formatting was added
around three tokens that the documentation site's MDX parser would otherwise
read as tags (`<=2026.811.0` in Event 4 and `<version>` in Events 8 and 9);
the characters inside are unchanged.

## Publication set and version policy

### Event 1

- Source system: Claude Code session transcript
- Source session: `df5f25b1-c975-44f8-be49-3d647f87a25f`
- Native locator: `uuid` `a0a49b29-4399-4920-922f-71fd58abd838`
- Enclosing turn and parent locator: first record; no `parentUuid`
- UTC timestamp: `2026-09-01T21:12:20Z`
- Stored actor role: `user`
- Literal excerpt:

  > Your job is to audit the releasae readiness and look at migrating our
  > downstream consumer ~/moltzap-propagation-bench to the new version. The
  > goal is to be quick and reduce the technical debt but not take on a huge
  > project. Simualator package should now be distributed over npm. Also look
  > at latest ReSaharma/AgentSocietyCoordBench or something (I have a local
  > stale fork) which also needs to be updated to the latest version of the
  > simualator.

Omission: the rest of the submission asks for bench plumbing removal, parallel
GKE runs, a documentation audit, and which skills to apply. It is omitted as
outside this record.

### Event 2

- Source system: Claude Code session transcript
- Source session: `df5f25b1-c975-44f8-be49-3d647f87a25f`
- Native locator: `uuid` `abbd3ed9-ef2b-49d6-afe9-7f0f5cf135b8`
- Enclosing turn and parent locator: `parentUuid`
  `78aca39e-5c0b-44b0-8fa8-038447212450`
- UTC timestamp: `2026-09-01T21:24:00Z`
- Stored actor role: `assistant`
- Literal excerpt (structured question with its options):

  > Which packages should be published to npm as the simulator's public
  > closure? This resolves the deferred publication decision and needs a
  > small ADR.
  >
  > - Simulator closure, one version (Recommended) — Publish identity,
  >   router, client, simulator, openclaw-channel, nanoclaw-channel as one
  >   CalVer set; evals stays private. Deprecate @moltzap/protocol and
  >   @moltzap/server-core on npm. Re-enable publish.yml for these six.
  > - Simulator + channels only — Publish simulator, openclaw-channel,
  >   nanoclaw-channel and bundle identity/router/client into the simulator
  >   tarball. Avoids three more npm packages but adds a bundling step and
  >   hides the layer boundary.
  > - Keep publishing deferred — Consumers install from git or a workspace
  >   link. Contradicts distributing the simulator over npm; only cleanup and
  >   docs happen in moltzap.

  > The v2/ directory still holds the constitution (v2/VISION.md) plus
  > superseded VERSION, drafts, inputs. How should it be handled now that the
  > cutover landed on main?
  >
  > - Retire v2/, move constitution to docs/ (Recommended) — Move
  >   v2/VISION.md to docs/vision.md, keep drafts/inputs only as
  >   decision-evidence where an ADR cites them, delete the rest, and record a
  >   point-correction to the 'v2 authority lives with v2' ADR. AGENTS.md and
  >   README get rewritten for the single-track state.
  > - Keep v2/ as-is, fix references only — Leave the directory and
  >   constitution path untouched. Rewrite AGENTS.md, README, CI triggers, and
  >   the dead-branch permalink constant so nothing describes the cutover as
  >   in flight.

Omission: the same record asks two further questions, about the depth of the
propagation-bench migration and which live infrastructure smoke runs may use.
They are omitted as outside this record.

### Event 3

- Source system: Claude Code session transcript
- Source session: `df5f25b1-c975-44f8-be49-3d647f87a25f`
- Native locator: `uuid` `9af1986a-3109-4deb-8a1d-3935896ad197`
- Enclosing turn and parent locator: `parentUuid`
  `abbd3ed9-ef2b-49d6-afe9-7f0f5cf135b8`
- UTC timestamp: `2026-09-01T21:28:34Z`
- Stored actor role: `user`
- Literal excerpt (the answer record, quoted whole):

  ```text
  The user answered: "Which packages should be published to npm as the simulator's public closure? This resolves the deferred publication decision and needs a small ADR."="Simulator closure, one version (Recommended)", "How deep should the propagation-bench migration go? Its grader reads agent-written CALENDAR.md, which the simulator cannot harvest today."="Full replacement + harvest feature (Recommended)", "The v2/ directory still holds the constitution (v2/VISION.md) plus superseded VERSION, drafts, inputs. How should it be handled now that the cutover landed on main?"="Retire v2/, move constitution to docs/ (Recommended)", "Verifying the migrations end to end means running real agent societies. Which live infrastructure may this work use for smoke runs?"="GKE mighe be faster if you can run multiple things in parallel easily".
  ```

  The record ends with the harness's fixed instruction to the agent to read
  the answers carefully; that sentence is not the maintainer's text and is
  omitted.

No source event located for a reason behind either selection.

## License and housekeeping

### Event 4

- Source system: Claude Code session transcript
- Source session: `df5f25b1-c975-44f8-be49-3d647f87a25f`
- Native locator: `uuid` `aada0556-71a1-4352-87b0-0473d6de5b07`
- Enclosing turn and parent locator: `parentUuid`
  `c39d0d06-e8bb-4946-8be8-63055f164b68`
- UTC timestamp: `2026-09-01T21:51:06Z`
- Stored actor role: `assistant`
- Literal excerpt (structured questions with their options):

  > Package licenses disagree and go public on first publish:
  > identity/router/client/openclaw-channel say Apache-2.0,
  > simulator/evals/nanoclaw-channel say MIT, root LICENSE is MIT, root
  > README says Apache-2.0. Which license applies to the six published
  > packages?
  >
  > - MIT (matches root LICENSE) — Set license: MIT in all six manifests,
  >   fix the README line. No new LICENSE files needed.
  > - Apache-2.0 (matches README) — Set license: Apache-2.0 in all six
  >   manifests, replace root LICENSE text, add NOTICE if required.

  > Adding core ledger tags (harvest, message records) makes previously
  > exported ledgers fail the reader's exact catalog check, including the
  > retained GKE qualification ledgers. How should the reader treat older
  > ledgers?
  >
  > - Relax to subset (Recommended) — ledger/read.ts → verifyCatalog accepts
  >   manifest tags ⊆ reader tags (records outside the manifest still
  >   rejected). Old ledgers stay readable; one test + one wording change in
  >   docs/simulator/overview.mdx.
  > - Keep exact equality — Same precedent as PR #981: older exported
  >   ledgers stop opening under the new catalog. Simpler contract, but the
  >   restored qualification report's ledgers become unreadable.

  > Which release housekeeping items should be included? (select all that
  > apply)
  >
  > - Deprecate old simulator/openclaw-channel — npm deprecate
  >   @moltzap/simulator and @moltzap/openclaw-channel `<=2026.811.0` with a
  >   pointer to the ADR (their public surfaces changed in the cutover).
  > - Reset CHANGELOG to CalVer — Replace the 1,800-line v1 [Unreleased]
  >   backlog with one cutover entry and fix the header from SemVer to
  >   CalVer; the workflow stamps each release.
  > - Delete uncited coordbench handoff input — Remove
  >   v2/inputs/agentcoordbench-messaging-calendar-handoff-20260827.md with
  >   the rest of v2/inputs (no ADR cites it).
  > - Delete GKE residue namespace — During verification, kubectl delete ns
  >   mz-681643794aea4327b1514dbb4c7c6a40 (14-day-old Failed controller Job)
  >   after re-checking it is still Failed.

### Event 5

- Source system: Claude Code session transcript
- Source session: `df5f25b1-c975-44f8-be49-3d647f87a25f`
- Native locator: `uuid` `21f84fd4-78a1-421a-b0e1-0d67ed15f4e2`
- Enclosing turn and parent locator: `parentUuid`
  `aada0556-71a1-4352-87b0-0473d6de5b07`
- UTC timestamp: `2026-09-01T21:52:49Z`
- Stored actor role: `user`
- Literal excerpt (the answer record, quoted whole):

  ```text
  Your questions have been answered: "Package licenses disagree and go public on first publish: identity/router/client/openclaw-channel say Apache-2.0, simulator/evals/nanoclaw-channel say MIT, root LICENSE is MIT, root README says Apache-2.0. Which license applies to the six published packages?"="Apache-2.0 (matches README)", "Adding core ledger tags (harvest, message records) makes previously exported ledgers fail the reader's exact catalog check, including the retained GKE qualification ledgers. How should the reader treat older ledgers?"="Keep exact equality", "Which release housekeeping items should be included? (select all that apply)"="Reset CHANGELOG to CalVer, Delete uncited coordbench handoff input, Delete GKE residue namespace, Deprecate old simulator/openclaw-channel".
  ```

  The record ends with the harness's fixed continuation sentence, which is
  omitted. The ledger-compatibility answer belongs to a simulator change,
  not to this record.

No source event located for a reason behind the license selection.

No source event located for the deprecation of the `@moltzap/client`
releases published before the record. Event 2 names only `@moltzap/protocol`
and `@moltzap/server-core`; Event 4 and Event 5 name only `@moltzap/simulator`
and `@moltzap/openclaw-channel`. The record's Deprecations section states the
`@moltzap/client` deprecation without a retained selection; the named
decision-maker's admission of the record is its only attribution.

## Release mechanics

### Event 6

- Source system: Claude Code session transcript
- Source session: `df5f25b1-c975-44f8-be49-3d647f87a25f`
- Native locator: `uuid` `bbbdc5ae-712e-404f-b45a-6049ad0876af`
- Enclosing turn and parent locator: `parentUuid`
  `2fc8e1a7-c7af-43e4-8fb9-9a0b1051988a`
- UTC timestamp: `2026-09-01T23:14:55Z`
- Stored actor role: `assistant`
- Literal excerpt (structured question; option labels only, descriptions
  omitted):

  > D2 — Issue 1 (Architecture, confidence 8/10): image digests are consumer
  > inputs with no release-time distribution. ELI10: a downstream bench needs
  > MOLTZAP_CONTROLLER_IMAGE and MOLTZAP_APPLICATION_IMAGE as @sha256
  > digests, but publish.yml only publishes npm tarballs; images are built by
  > repo-only Nx targets and pushed by `gke/cluster.sh publish-image`, and
  > the plan records digests in a hand-edited README table. Stakes: a stale
  > table sends consumers to an image that predates the harvest/endpoint
  > features, and runs fail at controller import time. Recommendation: 1A
  > because it ships the complete distribution story with the release commit,
  > and GitHub Actions already has GCP-capable OIDC for the bucket module.
  > Completeness: A=10/10, B=6/10, C=8/10. Which option?
  >
  > - 1A publish.yml builds+pushes images, writes digests (recommended)
  > - 1B Manual table via gke/cluster.sh publish-image
  > - 1C Push images from publish.yml to GHCR (public), digests in release
  >   commit

### Event 7

- Source system: Claude Code session transcript
- Source session: `df5f25b1-c975-44f8-be49-3d647f87a25f`
- Native locator: `uuid` `5c0254b4-6774-48ae-94d8-1fbc13ab93b9`
- Enclosing turn and parent locator: `parentUuid`
  `bbbdc5ae-712e-404f-b45a-6049ad0876af`
- UTC timestamp: `2026-09-01T23:35:25Z`
- Stored actor role: `user`
- Literal excerpt (the answer string):

  > "1A publish.yml builds+pushes images, writes digests (recommended)"

### Event 8

- Source system: Claude Code session transcript
- Source session: `df5f25b1-c975-44f8-be49-3d647f87a25f`
- Native locator: `uuid` `44f5b550-ca6b-40d6-8461-f8fc6ea90ff8`
- Enclosing turn and parent locator: `parentUuid`
  `50012097-0357-43d8-91ee-5da802c4f9ea`
- UTC timestamp: `2026-09-02T00:10:41Z`
- Stored actor role: `assistant`
- Literal excerpt (four structured questions; option labels only,
  descriptions omitted):

  > D6 — Tension A: PR-R cannot pass its own one-version guard while the six
  > manifests stay unequal (codex, confirmed: identity/router 2026.729.1,
  > client 2026.805.1, simulator 2026.811.0, openclaw 2026.805.0, nanoclaw
  > 0.0.0). Recommendation: A because the guard must be true at merge, and
  > the highest published value is the only string that does not go
  > backwards for any package. Completeness: A=10/10, B=7/10.
  >
  > - A Set all six manifests to 2026.811.0 in PR-R (recommended)
  > - B Make the guard tolerant until a release commit exists

  > D7 — Tension B: `on: push: main` would fire the first publish the moment
  > PR-R merges, before trusted publishers, WIF, and the release App are
  > configured (codex). Recommendation: A because bootstrap needs a human
  > hand on the trigger; flipping to push-triggered is a one-line follow-up
  > after the first green publish. Completeness: A=10/10, B=8/10.
  >
  > - A workflow_dispatch only in PR-R; enable push in a follow-up
  >   (recommended)
  > - B Keep push + dispatch, gate on repo var RELEASE_ENABLED

  > D8 — Tension C: the release is not atomic across npm, images, table, and
  > commit; and a tag's existence is not an integrity check (codex).
  > Recommendation: A because it names one commit point and makes reruns
  > converge on the registry's own digests. Completeness: A=10/10, B=6/10.
  >
  > - A Fixed order: bump → build+push images tagged `<version>` (reuse digest
  >   if tag exists) → write table → release commit → npm publish (skip
  >   existing) (recommended)
  > - B Publish npm first, images best-effort, table hand-edited later

  > D9 — Tension D: codex calls PR-R over-composed (relicensing,
  > WIF/Terraform, registry publishing, versioning, v2 deletion, constitution
  > move, ADR, docs). Your standing preference is atomic cutovers for shape
  > changes; the decisions skill requires the ADR to land with its affected
  > docs. Recommendation: A because v2 retirement has its own
  > point-correction record and a different rollback domain, while
  > publication stays one atomic PR. Note: options differ in kind, not
  > coverage — no completeness score.
  >
  > - A Split: R1 publication ADR + mechanics + images/WIF; R2 v2 retirement
  >   + docs rewrite + hygiene (recommended)
  > - B Keep one atomic PR-R

### Event 9

- Source system: Claude Code session transcript
- Source session: `df5f25b1-c975-44f8-be49-3d647f87a25f`
- Native locator: `uuid` `f8e025e5-2dea-417a-b68c-cf928ddea3e3`
- Enclosing turn and parent locator: `parentUuid`
  `44f5b550-ca6b-40d6-8461-f8fc6ea90ff8`
- UTC timestamp: `2026-09-02T00:13:45Z`
- Stored actor role: `user`
- Literal excerpt (the four answer strings, in question order):

  > "A Set all six manifests to 2026.811.0 in PR-R (recommended)"
  >
  > "A workflow_dispatch only in PR-R; enable push in a follow-up
  > (recommended)"
  >
  > "A Fixed order: bump → build+push images tagged `<version>` (reuse digest
  > if tag exists) → write table → release commit → npm publish (skip
  > existing) (recommended)"
  >
  > "B Keep one atomic PR-R"

No source event located for the external-consumer cutover deferral that the
record's Consequences and `docs/spec/layer-interfaces.md` → Deliberate
deferrals carry; no retained event selects or discusses it. The deferral
predates the record (mechanical observation below) and the record retains it
without selecting anything about it.

No source event located for a reason behind the D9 selection beyond the
question's own text.

## Mechanical repository and registry effects

These observations are separate from the conversation events. They were made
against the repository and the npm registry while this ledger was compacted
and are dated as such.

- Commit `a178413d`: `docs/spec/layer-interfaces.md` → Deliberate deferrals
  already reads "Final publication/version policy and external-consumer
  cutover remain unresolved"; the record resolves the first clause and leaves
  the second in place.
- Commit `ff0da6dc` (`chore(release)` for the `2026.811.0` releases) and
  commit `102f1104` (the head the `2026.812.0` publish run built): the
  `@moltzap/protocol`, `@moltzap/server-core`, `@moltzap/client`, and
  `@moltzap/openclaw-channel` manifests declare `Apache-2.0`, the
  `@moltzap/simulator` manifest declares `MIT`, and the root `LICENSE` is the
  MIT text.
- Commit `a178413d` (merge of PR #988, the head of `main` on 2026-09-01)
  carries `.github/workflows/publish.yml` with `if: ${{ false }}` and the
  comment "Publication stays disabled until the package closure, version
  policy, and installable public artifact set have one accepted decision."
  Its manifests read: identity and router `2026.729.1` with `private: true`
  and `license: Apache-2.0`; client `2026.805.1`, `private: true`,
  `Apache-2.0`; openclaw-channel `2026.805.0`, `Apache-2.0`;
  nanoclaw-channel `0.0.0`, `private: true`, `MIT`; simulator `2026.811.0`,
  `MIT`; evals `0.0.0`, `private: true`, `MIT`. The root `LICENSE` is the MIT
  text and the root `README.md` license line reads `Apache-2.0`. `v2/VERSION`
  and `packages/identity/src/version.ts → MOLTZAP_VERSION` both read
  `2026.827.1`.
- Commit `518b06bf` (2026-09-01T19:06:13Z, "docs(evals): identify retained
  GKE artifacts") is the last revision of
  `packages/evals/results/openclaw-gke-shared-private-20260901.md`. Commit
  `73897088` (2026-09-01T20:41:02Z, "docs(evals): defer qualification
  report") deleted it.
- GitHub Actions run `31650802123` (event `push`, head
  `102f110436bedbba828591c1b97fd4e322abcf76`, created
  `2026-08-12T23:24:59Z`, conclusion `failure`) committed
  `chore(release): @moltzap/protocol@2026.812.0
  @moltzap/server-core@2026.812.0 @moltzap/client@2026.812.0
  @moltzap/simulator@2026.812.0 @moltzap/openclaw-channel@2026.812.0`,
  published the first three with provenance, and failed on the fourth with
  `npm error 404 Not Found - PUT https://registry.npmjs.org/@moltzap%2fsimulator - Not found`
  after `npm notice publish Provenance statement published to transparency
  log`.
- `npm view`, observed 2026-09-02T00:40Z: `@moltzap/identity`,
  `@moltzap/router`, `@moltzap/nanoclaw-channel`, and `@moltzap/evals` return
  `E404`; `@moltzap/simulator` has one version, `2026.811.0`;
  `@moltzap/openclaw-channel` has `latest` `2026.811.0`; `@moltzap/client`,
  `@moltzap/protocol`, and `@moltzap/server-core` have `latest` `2026.812.0`.
