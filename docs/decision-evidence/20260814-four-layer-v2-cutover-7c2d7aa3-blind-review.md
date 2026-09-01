# Blind teammate review

## Review metadata

- Reviewer: Codex fresh sub-agent `/root/blind_candidate_review_7c2d7aa3`
- Isolation attestation: I did not author or reconcile this candidate. I received only the repository root, candidate identity, and the six fixed questions. I received no design summary, diff tour, file pointer, expected answer, prior-review output, or author coaching.
- Author interventions: none
- Quarantine attestation: I saw prior-review filenames in directory and history listings but did not open, read, or search their contents.
- Start: `2026-08-14T08:01:05Z`
- Finish: `2026-08-14T08:09:47Z`
- Duration: 8 minutes 42 seconds
- Candidate: `7c2d7aa3de683433af785ac940ae893c0f7c11a0`
- Candidate tree: `1d9c6e87bdbacdc833a9576b76e887da5088abb0`
- Parents:
  - `75e7584639cdde46b43851a482ea404bc387cf63`
  - `78e376341eb4b37aafbc5a3c446bb10826564085`
- First-parent tree: `1d9c6e87bdbacdc833a9576b76e887da5088abb0`
- Tree observation: candidate and first parent have identical Git trees.
- Repository state after review: clean; no changes made.

## Discovery trail

I independently:

1. Verified HEAD, tree, parents, timestamps, branch, and working-tree state.
2. Read root and v2 agent law and loaded the repository-required decision-review procedure.
3. Queried the Nx project list and dependency graph; it contains the seven named package products plus the root workspace project, with the documented dependency edges.
4. Discovered the decision index and followed its current lineage to:
   - `20260811-four-layer-endpoint-replicated-harness.md`
   - `20260812-harness-client-uses-conversation-id.md`
   - `20260813-client-protocol-and-attention.md`
   - `20260813-simulator-link-faults-perturb-delivery.md`
5. Read `v2/VISION.md`, the current ADR outcomes, their supersession sections, and their three non-review trajectories.
6. Followed normative ownership into `docs/spec/layer-interfaces.md`, `conversation-history.md`, the Harness chapters, management, Router, Identity, and enforcement.
7. Compared current orientation with historical implementation slates and inspected the candidate’s Git ancestry.
8. Independently discovered the branch-lineage contradiction described under question 5.

## Unedited answers

### 1. What decision does this candidate make current, what problem does it resolve, and which statements are binding versus context or non-normative explanation?

The candidate’s tree makes the four-layer cutover authority current:

1. Identity.
2. Communication: a content-blind Router plus endpoint-owned conversations, certified history, durability, catch-up, and Router re-anchoring.
3. Tasks and norms.
4. Personal trust.

Registry and Router are the only network services. Each agent has a Client-owned daemon and endpoint store. There is no product Ledger, Transcript service, global `LedgerOffset`, profile system, standalone testbed, or privileged monitoring/institution/governance layer. Institutions, monitors, and governance are ordinary agents and protocols.

The current decision also includes three refinements:

- `HarnessClient` uses a caller-minted `ConversationId`, `start`, current-action turns, and content-only bound reply; runtime completion is `void` after local certified durability.
- Client owns the exact private protocol, daemon/MCP representation, durable attention consumption, and five Simulator compatibility removals.
- Explicit Simulator link faults act privately after Router ordering; inactive delivery remains byte- and order-preserving.

This resolves the former eight-layer design’s central-Ledger dependency, privileged trust layers, duplicated implementation trees, profile-selected daemon, overly broad Client/proof surface, incomplete endpoint-recovery protocol, and conflict between retained Simulator faults and Router conformance.

Binding authority is:

- `AGENTS.md` and `v2/VISION.md`;
- current ADR Decision Outcomes and the explicitly retained Supersession scope of partially superseded records;
- normative `docs/spec/` chapters.

The four-layer ADR is partially superseded: its four original Client-interface deferrals and proof-shaped success result are historical; the four-layer model, replicated history, quorum, re-anchor, recursive social features, topology, package graph, and cutover outcome remain current.

ADR context, considered options, historical examples, and explanatory consequences are not independently binding. `docs/architecture/` is orientation/execution material. The trajectories are non-normative source-event ledgers. The decision index is a reviewed navigation aid, while frontmatter and current outcomes control status.

The candidate commit itself introduces no new content-level decision relative to its first parent because their tree hashes are identical.

Verdict: **PASS**

### 2. What earlier outcomes does it replace, retain, or leave untouched, and where does the current normative contract live?

It replaces or re-owns:

- Eight numbered layers and two trust regions with four layers.
- Central Ledger atomic commit with independently stored, quorum-certified endpoint histories.
- Product Transcript, `moltzap-ledger`, `LedgerOffset`, central conversation index, and author-only completion.
- Permanent Router-restart fencing with verified catch-up and threshold re-anchor.
- Privileged monitor, institution, credential, and governance layers with ordinary agents, tasks, norms, signed claims, and local trust.
- Six `v2/*` implementation packages with seven final `packages/*` products.
- Named profiles, split registration/active MCP paths, CLI/socket machinery, dual backings, and separate testbed with one explicitly configured state directory and `/mcp`.
- Runtime-visible `TxnId`, hashes, receipts, proof results, universal cross-conversation presentation, checkpoints, generic send, and reply-by-id with the reduced Client boundary.
- Five incompatible Simulator families: content-free open, generic send, message-only receive/results, runtime Router/credential authority, and persisted Router-order/commit claims.

It retains:

- One correct, non-equivocating Registry and one correct, non-equivocating Router.
- Immutable AgentCards, AgentIds, Ed25519 signing, Registry admission, authenticated HTTP, and exact Identity representations.
- Router opacity, explicit recipients, volatile global order, polling/retry behavior, and exact Router representation.
- Fixed-membership `OpenFloorV1`, unanimous action certification, and endpoint interpretation.
- Separate personal-trust decisions.
- Official MCP framing and one loopback listener.
- Compatible Simulator facades and its separate simulation `RunLedger`.
- The pinned `102f1104…` Simulator behavioral baseline; `78e37634…` is documented as release-number-only.

It leaves deliberately unresolved publication/version/release policy and the future protocol features listed under question 6.

The current normative contract lives in:

- `AGENTS.md`
- `v2/VISION.md`
- the four current ADRs listed above
- `docs/spec/layer-interfaces.md`
- `docs/spec/conversation-history.md`
- `docs/spec/harness/{client,daemon,ingress,output,tasks,screening}.md`
- `docs/spec/management.md`
- retained Identity and Router semantic/representation chapters
- `docs/spec/enforcement.md`

`20260728-gate-1-architecture-freeze.md` retains the stable trace inventory, but each row points to the current normative owner.

Verdict: **PASS**

### 3. What must an implementer now do or avoid, which layers or consumers are affected, and under what fault, trust, safety, liveness, and compatibility assumptions?

An implementer must:

- Maintain exactly seven products and the documented DAG:
  - Identity: no product dependency.
  - Router: Identity.
  - Client: Identity and Router.
  - OpenClaw/NanoClaw: Client only.
  - Simulator: Identity, Router, Client.
  - Evals: Client, Simulator.
- Run independent Registry and Router processes and one `moltzapd` per local state directory.
- Bind the daemon only to `127.0.0.1`, use the seven exact `MOLTZAPD_*` inputs, and persist endpoint state in SQLite/WAL.
- Keep Client protocol values closed, RFC 8785 canonical, versioned, and domain-separated.
- Use stable self-addressed inner `SignedMessage` evidence and replaceable all-member outer Router messages.
- Enforce fixed membership of 2–32 and at most 32,768 canonical content bytes, with no fragmentation.
- Keep unanimous action evidence separate from durability evidence.
- Durably stage before voting.
- Require all votes for `n < 4`; otherwise require `n-f`, where `f=floor((n-1)/3)`.
- Permit any member to assemble and disseminate completed durability evidence.
- Verify every hash, card, membership binding, signature, predecessor, anchor, and certificate before mutation.
- Catch up fixed members automatically and re-anchor after Router restart without guessing ancestry.
- Expose only the reduced `HarnessClient`, caller-minted `ConversationId`, `start`, turns, and bound reply to runtimes.
- Keep registration, status, search, history, and proof inspection MCP-only.
- Persist consumed attention immediately before turn-frame output; never bid or offer that head again at that endpoint.
- Preserve the exact pre/post-registration MCP catalogs and narrow listen extension.
- Keep inactive Simulator delivery byte- and order-faithful; apply explicit faults only at the private post-Router recipient boundary.

An implementer must avoid:

- Product Ledger/Transcript services, profiles, compatibility packages, forwarding shims, generic send, public hashes/proofs/receipts, raw runtime Router authority, and privileged institutional paths.
- Making Router conversation-aware or persistent.
- Treating durability votes as action approval.
- Lowering a threshold, guessing history, reconstructing a live reply from history, or automatically contending on an endpoint’s own action.
- Restoring cross-conversation context in Client or Simulator.
- Reporting fault-perturbed recipient order as Router-conformance evidence.

Fault and trust assumptions:

- Registry and Router are correct and non-equivocating. Malicious or replicated Registry/Router profiles are outside Gate 1.
- Endpoints may be Byzantine.
- For `n >= 4`, at most `f=floor((n-1)/3)` endpoints are Byzantine.
- For `n < 4`, the replicated-storage guarantee assumes zero Byzantine members.
- Honest members stage before signing and do not double-sign conflicting successors or anchors.
- Local operator and loopback MCP client are trusted.

Safety and progress:

- Safety is timing-independent under the stated assumptions.
- Unanimous action validity means one honest required member can block an invalid action, but withholding also blocks action progress.
- Completed durability evidence guarantees at least `n-2f` honest staged replicas for `n >= 4`; it does not prove Byzantine signers retained bytes.
- Registry outage blocks registration and uncached resolution.
- Router outage blocks new delivery, evidence dissemination, catch-up, and re-anchor.
- Quorum unavailability blocks completion.
- Catch-up requires at least one reachable honest holder of required history.
- Existing complete local history remains readable and verifiable.
- Explicit Simulator drop/hold/delay/reorder faults may intentionally stop progress.

Compatibility:

- Identity and Router wire bytes and deep capabilities survive relocation.
- Compatible Simulator facades remain, while five named contract families are intentionally removed.
- All sixteen eval definitions execute, but six cross-conversation cases may fail until host-native memory exists.
- External-consumer compatibility and publication/version policy are not selected.

Verdict: **PASS**

### 4. Which humans are named as decision-makers, which source events does the compacted trajectory cite for their calls, alternatives, reversals, and deferrals, and what source gaps does it explicitly record?

All four current ADRs name **Tapan Chugh** as decision-maker.

All three current trajectories cite Codex session `019fd899-779c-7e70-a8e4-338727b13e6c`.

The four-layer trajectory records:

- Initial request `msg_019ff1f8-2124-73e2-8e49-7559e6b8b43d`: shorten the eight-layer design, remove Ledger/monitoring/revocable-credential layers, keep local history copies, and treat institutions/governance as agents and tasks.
- Planning call/result pairs:
  - `fc_…4554507` / `fco_019ff1fd-87dc-7d03-b333-6f3bedf1e0d0`: rejects all proposed core/history/interface options and says to keep layering, simplify, and avoid semantic change.
  - `fc_…d425` / `fco_019ff200-fdb0-74b0-8757-b52ea4edd1f3`: selects five layers, requests a shared BFT-style quorum with catch-up, and preserves the MCP split.
  - `fc_…f767ee` / `fco_019ff202-7769-7af0-9a5e-d60e38fd8567`: selects trusted Router, fixed one-third with all members below four, and any-member finalization.
  - `fc_…27c1d2` / `fco_019ff204-876c-71f0-aac3-361b40a1bd51`: selects local record proof and automatic catch-up and suggests merging L2/L3.
  - `fc_…191af4` / `fco_019ff206-4451-78f3-8be3-30888ac565c7`: replaces the earlier five-layer selection with four layers, permits API cleanup, and selects authority/specification before code.
  - `fc_…cfcff89` / `fco_019ff209-a6a4-7d93-b543-45caf6a9445a`: selects separate action/durability certificates and questions why profiles and old Client code remain.
  - `fc_…bcd6b2bde` / `fco_019ff20c-30c7-75d3-894f-9c03246acaee`: selects explicit daemon configuration, `@moltzap/client`, and all-v1 cutover.
  - `fc_…e50a3` / `fco_019ff20f-00b2-77c1-952d-01680dbfbf52`: selects final package names, `HarnessClient`, and putting everything under `packages/*`.
  - `fc_…f44928` / `fco_019ff210-2654-71b3-b959-34c93e655183`: aborted; the ledger infers no selection.
  - `fc_…103d98` / `fco_019ff211-9d26-7051-986b-267c722b6286`: selects frozen forward merges and landing PR #974 first; asks for minimal Simulator changes and no API change.
  - `fc_…984ca3` / `fco_019ff213-9fe0-7ea0-8e57-458b9727fc70`: selects quorum re-anchor, a long-lived cutover branch, and blockers-only PR cleanup.
- Direct cutover request `msg_019ff209-a6b4-7660-bb73-0d7fc7fa1938`.
- Assistant plan `msg_0fe7c1dd…b21f9` and human adoption `msg_019ff231-e57a-7323-a0a3-c98c9b10ff22`: “set this plan as your goal…”
- ACG request/recommendation/selection:
  - `msg_019ff20f-0112-7c11-820b-8b4933270d85`
  - `msg_0fe7c1dd…0c3`
  - `msg_019ff210-429e-7912-8d33-b80c7b409d53`: “enable” and “I don't think we have testbed anymore.”
- Registry-recovery sequence:
  - `msg_0fe7c1dd…1cef6` proposal
  - `msg_019ff259-becc-7400-9b3f-243c73c30dd4`: “I accept that”
  - `msg_0fe7c1dd…112120a` two-part clarification
  - `msg_019ff2a0-6576-7172-8c6b-e32415d4ede2`: changed recovery arguments should fail
  - `msg_019ff2a1-23e6-7f90-b627-7df2faa176b6`: directs the unresolved Registry work into an issue and to continue cutover.
  - The ledger says item 1 remained unanswered and was deferred; issue #984 was created.
- Reduced Client sequence:
  - `msg_019ff821-75f6-70c3-b36b-54f732ad8242`, `msg_019ff822-0a13-7130-9814-109109a0ab1b`, and `msg_019ff827-7b2a-7441-9f35-8b538e86add8` request further simplification.
  - `msg_0fe7c1dd…d36c` proposes the exact reduced boundary.
  - `msg_019ff852-c742-7480-b464-fdae2792c6ad`: “accept the reduced boundary.”
  - Later messages say not to repeat reviews and “we accept the changes.”

The Client-protocol trajectory records:

- `fc_…01b843` / `fco_019ff97f-dd98-7812-a93e-9d17c9cb2dd0`: selects nested `SignedMessage`; defers host memory and lets evals fail.
- `fc_…d092` / `fco_019ff989-86d8-7d83-92c1-16da24457d21`: initially selects contention after every action.
- `msg_019ff989-fa2d-76f0-8d83-7b09f663643a`: immediately reverses that selection—“actually fine to not content again.”
- `msg_0fe7c1dd…ed417`: records the applied no-self-contention interpretation.
- `msg_019ff993-e348-7272-9e3c-f5ddce9d116e`: directs the plan back to the four-layer authority.
- `msg_0fe7c1dd…f93`: supplies the complete implementation plan.
- `msg_019ff9a4-2b1b-7103-8801-32e8ff998a36`: “Implement the plan.”

The Simulator trajectory records:

- `msg_0fe7c1dd…26512`: presents order-safe-stalling and deletion-first options.
- Human messages `msg_019ffc35-0352-7773-8385-27cd5007f44a` and `msg_019ffc35-0365-7dc3-bede-dd08ccfb4e38`: “I think life-level ordering is fine for the simulator” and “that's the point of testing right.”
- `msg_0fe7c1dd…bdc8e` is explicitly an assistant interpretation of “life-level” as link-level post-Router perturbation.

Explicit source gaps and limitations:

- Session metadata does not identify the human using the session.
- Metadata and function-call events lack some actor, parent, turn, or native-message fields; the ledgers mark them absent.
- The initial “ledger” wording is ambiguous and does not select record types, thresholds, APIs, or disclosure mechanisms.
- Adopting the execution plan does not itself say that an ADR, blind review, or every proposed interface was accepted.
- Registry-recovery item 1 was left unanswered and deferred at that point.
- The Client trajectory attributes no separate human choice for every protocol field, table, error literal, environment name, motive, confidence, urgency, or mechanism.
- The Simulator human response does not choose option 1 or 2 verbatim; post-Router semantics are recorded as the assistant’s applied interpretation.
- No source event selects the private fault interposition transport, authentication, port, deployment object, or wire representation.

Verdict: **PASS** — these gaps are discoverable and explicitly represented without inferred human rationale.

### 5. Find the strongest apparent contradiction, stale instruction, or broken lineage elsewhere in the repository. Resolve it using the authority order or report it as a blocker.

**Blocker found: the candidate contains a second post-freeze `main` merge without authority or an updated lineage record.**

Binding/current sources say:

- `AGENTS.md`: one final pinned integration, then routine `main`-to-cutover merges are frozen.
- `v2/VISION.md` Authority: integrate the accepted PR #974 state and pinned `main` base once; later v1 fixes move only by deliberate port.
- The retained cutover outcome in `20260811-four-layer-endpoint-replicated-harness.md`: PR #974 lands, the cutover takes one final `main` merge and records that base, then forward merges stop.

Repository history and orientation say:

- Commit `25179f64b2976754b7b331c26cc7b3e9641c84cc` already merged `102f110436bedbba828591c1b97fd4e322abcf76` into the cutover with subject “take final main integration before cutover freeze.”
- `docs/architecture/pr-974-forward-merge-rehearsal.md` records that as the exact final integration and says routine merges are frozen.
- `docs/architecture/simulator-domain-barrels.md` explicitly says to keep later release-only commit `78e376341eb4b37aafbc5a3c446bb10826564085` out of the candidate.
- This candidate, `7c2d7aa3…`, is nevertheless a merge whose second parent is exactly `78e37634…`.

The candidate tree being identical to its first parent proves no release-number or retired-v1 content entered the tree. It does not resolve the governance and lineage contradiction: there are now two `main` merge commits after the authority selected and recorded one final merge, and no current ADR, specification, or updated integration record authorizes or explains the ancestry-only exception.

The commit subject is not decision authority. Resolving this requires either removing the second merge from the candidate or admitting an explicit exception and updating the exact integration lineage, followed by a new frozen candidate and fresh reviewer.

Verdict: **FAIL**

### 6. Could a teammate implement the decision without chat or guessing? List every missing link or unresolved choice and classify each as a deliberate deferral or an accidental gap.

The four-layer product and protocol are implementable from repository authority without chat. The exact package graph, protocol values, hashes, thresholds, store transitions, MCP representation, daemon configuration, public Client boundary, Simulator removals, and fault boundary have normative owners.

However, a teammate cannot land this exact candidate without guessing whether the second `main` merge is allowed.

Accidental gap:

- **Branch integration lineage:** current authority and the recorded final-integration artifact identify one final merge at `25179f64`/`102f1104`, while this candidate adds `78e37634` as another `main` parent. No authority records an ancestry-only exception or updates the pinned final base. This blocks landing.

Deliberate deferrals, which do not make the Gate 1 implementation incomplete:

- Publication membership, coordinated versus independent versions, release ordering, deployment cutover, and external-consumer compatibility.
- Malicious/equivocating or replicated Registry/Router, durable Router feeds, ordering consensus, fork detection, failover, and transparent restart.
- Identity rotation, revocation, recovery, delegation evidence, peer-card custody, encrypted-key/HSM/external-signer policy, and application TLS/proxy policy.
- Dynamic membership, non-unanimous action certificates, public observers/witnesses, alternate catch-up transports, non-member audit/disclosure, encryption/key distribution, and larger/fragmented resource profiles.
- History pruning, compaction, garbage collection, retention policy, and recovery after local disk loss.
- Richer task/norm vocabularies, addressed turns, fairness, pass/abort/renewal, disputes/remedies, signature compression, per-action tools, distributed norm bundles, portable norm pins, and payload-only selection when several actions are legal.
- Cross-process reply recovery, delivery acknowledgment/replay, resumable subscriptions, daemon-wide queue/concurrency/byte/overload limits, remote administration, and global duplicate-key/copied-directory detection.
- Host-native cross-conversation memory.
- Later management query text, summaries, ranking, totals, full-text search, alternate page sizes, and remote administration.
- Semantic-screening protocols, contacts policy, judgment testimony, institution discovery and claim vocabularies, revocation, monitor publication, appeals, consequences, governance, selective disclosure, and portable trust policy.

No other accidental normative or source-link gap was found.

Verdict: **FAIL** because of the branch-lineage blocker.

## Per-question verdicts

| Question | Verdict |
|---|---|
| 1 | PASS |
| 2 | PASS |
| 3 | PASS |
| 4 | PASS |
| 5 | FAIL — unresolved second-main-merge lineage |
| 6 | FAIL — exact candidate cannot land without guessing about that exception |

## Overall result

**FAIL — blocks landing.**

The technical four-layer contract is accurate, discoverable, and implementable. The exact candidate’s Git ancestry contradicts the current one-final-merge/freeze lineage and lacks a repository-authoritative exception.
