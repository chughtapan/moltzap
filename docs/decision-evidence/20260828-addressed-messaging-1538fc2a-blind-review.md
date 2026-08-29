# Blind teammate review — FAIL

## Review identity

| Field | Value |
|---|---|
| Review run ID | `adr-blind-review-2-20260829T021510Z` |
| Candidate root | `/home/tapanc/moltzap-v2-cutover` |
| Candidate branch | `impl/addressed-messaging-native-sessions` |
| Candidate commit | `1538fc2a4d1b07fba3f88eaa6ba5a44b77f0d4d7` |
| Candidate tree | `055d10fa336f8b749f6a3da3c041285f92c736a9` |
| Candidate content digest | SHA-256 `b2fa0e632ed11bb3bb150322c49b6301bfef9c07311cbbbb97bf46bf59be820b` |
| Digest scope and command | Full Git tree manifest: `git ls-tree -r -z --full-tree HEAD \| sha256sum` |
| Independently discovered merge base | `0366f7d95587edb680ed0270211856e02043a73e` |
| Reviewer | Codex fresh agent `/root/adr_blind_review_2` |
| Review started | `2026-08-29T02:15:10Z` |
| Review finished | `2026-08-29T02:24:30Z` |
| Duration | 9 minutes 20 seconds |
| Review budget | One uninterrupted fresh-agent context |
| Rerun of | Not discoverable without opening quarantined artifacts |
| Candidate state | Clean before and after review; no files edited |

## Exact prompt

```text
Conduct the repository's fresh blind teammate review in candidate root /home/tapanc/moltzap-v2-cutover. This review is confined to the changed ADRs and their governing normative specifications, decision manifest, provenance, authority, supersession, and lineage; do not evaluate implementation code. You have no inherited author conversation, compaction, memory, private state, or prior review output. Follow the repository's AGENTS.md blind-review gate exactly. Do not open, read, or search the contents of any earlier *-cold-review.md, *-blind-review.md, or invalid-review artifact; merely seeing such paths is allowed. If a command returns content, an answer, or a verdict from one, invalidate the run immediately. Do not ask the author for help. Discover everything from the candidate repository. Record the candidate identity, exact prompt, reviewer identity and isolation attestation, start/end/duration, unedited answers, independently discovered paths/headings, discovery trail, author interventions, per-question verdicts, blockers, and overall result in your final response. Do not edit files.

Ask and answer these questions verbatim:

1. What decision does this candidate make current, what problem does it resolve, and which statements are binding versus context or non-normative explanation?
2. What earlier outcomes does it replace, retain, or leave untouched, and where does the current normative contract live?
3. What must an implementer now do or avoid, which layers or consumers are affected, and under what fault, trust, safety, liveness, and compatibility assumptions?
4. Which humans are named as decision-makers, which source events does the compacted trajectory cite for their calls, alternatives, reversals, and deferrals, and what source gaps does it explicitly record? Report only what the event ledger states; do not infer motives, confidence, urgency, or rationale.
5. Find the strongest apparent contradiction, stale instruction, or broken lineage elsewhere in the repository. Resolve it using the authority order or report it as a blocker.
6. Could a teammate implement the decision without chat or guessing? List every missing link or unresolved choice and classify each as a deliberate deferral or an accidental gap.
```

## Fresh-context attestation

- [x] I did not author or reconcile the candidate.
- [x] I received no author conversation, summary, compaction, memory, private state, or earlier review output.
- [x] I received only the candidate root, fixed questions, and neutral scope restriction.
- [x] I received no design summary, diff tour, ADR/file pointer, search term, expected answer, or answer key.
- [x] I independently navigated from repository-native instructions, indexes, authority documents, and history.
- [x] I did not open, read, or search any quarantined review artifact. Artifact paths appeared in listings/history; no answer or verdict from one was returned.
- [x] I did not ask the author for help.
- [x] I did not modify the candidate.
- [x] Author interventions recorded below are complete.

## Fixed questions and unedited answers

### 1. What decision does this candidate make current, what problem does it resolve, and which statements are binding versus context or non-normative explanation?

The candidate makes four coordinated decisions current:

1. The retained portions of `20260827-addressed-messaging-replaces-openfloor.md` replace OpenFloorV1, public conversation/turn/reply-grant semantics, and implicit targeting with explicit `agent:` and fixed-member `group:` messaging, private deterministic conversations, GENESIS/POST certification, endpoint-replicated history, durable addressed delivery, and an incompatible fresh-state cut.
2. `20260828-hosts-own-send-retry-policy.md` removes public/MCP `IdempotencyKey`, cross-invocation Client deduplication, and `idempotency-conflict`. Each host invocation creates a new Client-minted `PostId`; only recovery of that persisted invocation reuses it.
3. `20260828-action-signatures-follow-router-order.md` removes proposal-embedded `authorSignature`. The outer envelope proves authorship but is not an action vote; every member, including the author, durably locks the first valid Router-ordered candidate before signing.
4. `20260828-channel-adapters-use-stock-host-apis.md` limits OpenClaw and NanoClaw integrations to stock host callbacks. Hosts own sessions, persistence, retries, ACLs, prompts, final-text interpretation, and sandbox behavior.

These choices resolve four linked defects: OpenFloor/turn authority duplicated host-native messaging, groups lacked a first-class address, caller retry identity ambiguously merged intentional repeated sends, proposal pre-signing contradicted first-Router-ordered locking, and NanoClaw integration had become a provider-owned host fork.

Binding material is:

- `AGENTS.md` and `v2/VISION.md`;
- current ADR `Decision Outcome` and `Supersession` text;
- the manifest in `20260811-four-layer-endpoint-replicated-harness.md → Gate 1 traceability disposition`; and
- the current normative `docs/spec/` headings linked by that manifest.

ADR context, consequences, considered options, historical bodies below a supersession notice, record changelogs, architecture handoffs, trajectories, source-gap reports, and prior implementation behavior are contextual or non-normative. The idempotency and fixed-session portions inside the historical body of the partially superseded 20260827 ADR do not bind.

Discovered paths/headings: `docs/decisions/README.md → Canonical reading guidance`; the four ADRs above → `Decision Outcome`/`Supersession`; `v2/VISION.md → Authority`, `The constitution`, `First executable profile`; `docs/spec/README.md → Addressed Client boundary`.

Verdict: **PASS**

### 2. What earlier outcomes does it replace, retain, or leave untouched, and where does the current normative contract live?

It fully replaces the current applicability of:

- OpenFloorV1;
- `start_conversation`, current-conversation turns, bound reply, reply grants, BEGIN/ACK contention, and the engine’s grant-before-generation dispatch;
- public `ConversationId`, caller-created START identity, and the old `HarnessClient`;
- events-v1 and presentation checkpoints;
- provider-owned host session, inbox, ACL, prompt/output, and sandbox rules; and
- host-supplied Client idempotency keys.

It retains:

- the four-layer model, seven-package graph, Registry/Router process split, endpoint-replicated certified history, stage-before-vote, catch-up, Router re-anchor, and no-product-Ledger outcome;
- Client ownership of closed representation, SQLite persistence, registration recovery, management isolation, catch-up, re-anchor, and daemon configuration;
- one loopback MCP listener, official SDK/framing, discovery, subscription ownership, acknowledgment ordering, and supervision where independent of profiles/Ledger;
- fixed-member in-band genesis with initial content and no control-plane conversation creation;
- endpoint-owned inbound/outbound trust boundaries;
- the compatible Simulator, Kubernetes execution, `RunLedger`, and private post-Router fault boundaries.

Identity and Router remain content-blind, with their exact representations and behavior retained apart from advancing the shared source version to `2026.827.1`. Publication/version policy remains untouched and deferred.

The current contract lives in the authority chain:

1. `AGENTS.md` and `v2/VISION.md`;
2. the decision index and current ADR outcomes;
3. the stable manifest in the four-layer ADR;
4. `docs/spec/conversation-history.md`, `harness/tasks.md`, `harness/client.md`, `harness/output.md`, `harness/ingress.md`, `harness/channels.md`, `harness/daemon.md`, `management.md`, and `layer-interfaces.md`.

However, lineage is not consistently updated. These visible `Supersession` sections still describe replaced details as current:

- `20260801-harness-client-owns-runtime-context.md` says every address uses one native session.
- `20260813-client-protocol-and-attention.md` calls one native host session current.
- `20260812-harness-client-uses-conversation-id.md` says the replacement has a durable host idempotency key and acknowledgment after native host persistence.
- `20260801-model-output-is-start-or-bound-reply.md` says a durable host outbox identifier supplies idempotency.

A reader can eventually follow those records into the 20260827 ADR and then its two 20260828 replacements, but each record’s own visible lineage is stale and violates the repository requirement that a reader landing on a superseded record see the precise current contract.

Discovered paths/headings: `docs/decisions/README.md → Records`; all changed predecessor ADRs → `Supersession`; `20260811-four-layer-endpoint-replicated-harness.md → Supersession`, `Gate 1 traceability disposition`.

Verdict: **FAIL**

### 3. What must an implementer now do or avoid, which layers or consumers are affected, and under what fault, trust, safety, liveness, and compatibility assumptions?

An implementer must:

- expose only structural `HarnessEndpoint.send({to, content})` and `messages`;
- resolve `agent:` and canonical fixed-member `group:` addresses through Registry;
- mint a fresh opaque `PostId` for every send invocation, persisting it before protocol traffic and reusing it only to recover that invocation;
- use unanimous GENESIS and author-inclusive POST `q(n)`, where `q(n)=n` for `n<4`, otherwise `n-floor((n-1)/3)`;
- authenticate proposals with the outer envelope, durably lock first Router-ordered candidate, and emit no action vote—including the author’s—before that lock;
- keep action signatures, durability votes, and hashes distinct and retain auditable signer identities/signature bytes;
- return `void` only after the local endpoint durably holds a fully action- and durability-certified record;
- create stable pending delivery for every locally certified remote-authored post, replay it until acknowledgment, and acknowledge only after the stock host inbound callback succeeds;
- keep registration/status/search/history/proof operations MCP-only;
- keep adapters at stock host callbacks, with one Client call per callback and no host patches, databases, retry queues, destination resolver, session rule, prompt/output rule, or sandbox implementation;
- preserve the seven-package dependency graph and opaque Registry/Router boundaries.

It must avoid restoring OpenFloor, START/bound reply, implicit targets, public conversation identifiers, host idempotency keys, proposal `authorSignature`, proof-shaped send results, events-v1, compatibility shims, product Ledger, or runtime Router/store authority.

Affected areas are Identity lookup/attribution, opaque Router transport, Client communication/history, task/norm validation, personal-trust signing, daemon/MCP representation, both channel adapters, Simulator, and evals.

Assumptions:

- Registry and Router are each correct and non-equivocating; availability is separate.
- Endpoints may be Byzantine. For `n>=4`, replicated-storage guarantees assume at most `f=floor((n-1)/3)` Byzantine fixed members and honest stage-before-sign. For `n<4`, that storage guarantee assumes zero Byzantine members.
- Safety is timing-independent. POST safety depends on quorum intersection, correct Router order, and honest post-lock non-double-signing.
- Progress requires Registry/cached cards as applicable, Router availability, the selected author-inclusive action quorum, the durability quorum, and an honest reachable history source for missing ancestry.
- The selected candidate can stall indefinitely; there is no fairness, timeout replacement, view change, or alternate-candidate election.
- The hard cut is `V2_PROTOCOL_VERSION=2026.827.1`, Client hash domain v2, schema 2, and events-v2. Only genuinely empty version-0 stores initialize. Old stores, mixed peers, and prior extensions fail closed; no migration, dual stack, rollback automation, or compatibility alias exists.

The implementation instructions are nevertheless internally inconsistent about host/session scope: `docs/spec/README.md → Implementation readiness` says runtimes use “native shared sessions,” and `Addressed Client boundary` promises acknowledgment after native host persistence. The accepted stock-host ADR and detailed channel/client/ingress specs instead say session topology is entirely host-owned and callback success does not itself prove host persistence. The same README says implementation stops on a current ADR/spec conflict.

Discovered paths/headings: `v2/VISION.md → First executable profile`; `docs/spec/conversation-history.md`; `harness/tasks.md`; `harness/client.md`; `harness/output.md`; `harness/ingress.md`; `harness/channels.md`; `layer-interfaces.md → Cross-layer laws`.

Verdict: **FAIL**

### 4. Which humans are named as decision-makers, which source events does the compacted trajectory cite for their calls, alternatives, reversals, and deferrals, and what source gaps does it explicitly record? Report only what the event ledger states; do not infer motives, confidence, urgency, or rationale.

Every changed ADR names **Tapan Chugh** as decision-maker.

The addressed-messaging trajectory cites Codex local-history session `019fd899-779c-7e70-a8e4-338727b13e6c`:

- Event 1, line 2920, `2026-08-27T18:57:37Z`: asks to add cross-conversation context back, add group chat, and states “Individual private cal but shared meetings.”
- Event 2, line 2922, `2026-08-27T19:27:10Z`: says to remove OpenFloorV1.
- Event 3, line 2924, `2026-08-27T19:55:09Z`: says to fall back to existing OpenClaw and NanoClaw code where possible.
- Event 4, line 2925, `2026-08-27T20:41:17Z`: asks about routing through one main session and using `agent:`/`group:`.
- Event 5, line 2927, `2026-08-27T20:52:54Z`: selects agent addresses and says not to send automatic notifications.
- Event 6, line 2930, `2026-08-27T21:29:13Z`: asks whether OpenClaw’s message tool makes more sense; the ledger explicitly says this question does not establish the answer.
- Event 7, line 2932, `2026-08-27T21:52:53Z`: asks about native messaging and states group recipients should know it is a group conversation.
- Event 8, line 2929, `2026-08-27T21:17:54Z`: defers CoordBench migration, rejects backcompat as a goal, and says not to overcomplicate rollback.
- Event 9, line 2936, `2026-08-27T22:21:49Z`: asks whether work is against the four-layer cutover branch.
- Event 10, line 2940, `2026-08-27T22:52:08Z`: says “Implement the plan.” The plan is absent.
- Event 11, line 2943, `2026-08-27T23:54:53Z`: says “ookay, that sounds good. proceed”. The preceding prompt is absent, so the ledger says it cannot independently establish what was accepted.

That source has no native message IDs, turn IDs, parent locators, or separate stored role field. It also lacks the intervening agent explanations, choice prompts/selections, and final plan. Therefore it does not independently establish canonical sorting, the selected POST threshold, detailed interface/wire shapes, or the meaning of the terse approvals.

The three 20260828 source-gap reports retain no event rows:

- host-owned retry policy;
- Router-ordered action signatures;
- stock host adapter boundary.

Each says the active conversation exposed no source session identifier, native locator, parent/turn locator, or exact UTC timestamp. Each expressly refuses to reconstruct the decision from ADR prose, repository changes, or memory. Thus no source event in the repository proves those three human calls, alternatives, or reversals.

Discovered paths/headings: `docs/decision-evidence/20260827-addressed-messaging-trajectory.md`; the three `20260828-*-source-gap.md` reports; each current ADR’s `Decision provenance`.

Verdict: **PASS** — the absence is explicit and discoverable, not silently repaired.

### 5. Find the strongest apparent contradiction, stale instruction, or broken lineage elsewhere in the repository. Resolve it using the authority order or report it as a blocker.

The strongest contradiction is inside the current normative specification index:

- `docs/spec/README.md → Implementation readiness` says Simulator/eval runtimes use “native shared sessions.”
- The same file’s `Addressed Client boundary` says transport acknowledgment follows “native host persistence.”
- `20260828-channel-adapters-use-stock-host-apis.md → Decision Outcome`, `docs/spec/harness/channels.md → Stock host boundary`, and `docs/spec/harness/ingress.md → Durable acceptance` instead state that MoltZap selects no session topology and that acknowledgment follows successful callback completion while the host owns what persistence that represents.

Authority order identifies the intended binding answer: the accepted stock-host ADR outranks the spec summary, and the detailed current specs agree with it. MoltZap must impose no shared-session topology and may claim only callback-before-ack ordering.

This does not make the candidate pass. `docs/spec/README.md → Authority and reading order` itself says an ADR/spec conflict is a documentation defect and implementation stops until reconciliation. The stale current normative summary is therefore a blocker.

Additional broken lineage appears in the stale predecessor `Supersession` sections listed in answer 2. A separate current normative contradiction exists in `docs/spec/identity.md → Registration`, which says whether the private-key path comes from daemon configuration or the registration tool remains unassigned, while the retained daemon decision and `docs/spec/harness/daemon.md → Process and configuration` assign it to `MOLTZAPD_AGENT_PRIVATE_KEY_FILE`.

Verdict: **FAIL**

### 6. Could a teammate implement the decision without chat or guessing? List every missing link or unresolved choice and classify each as a deliberate deferral or an accidental gap.

No. The detailed protocol and runtime contracts are implementation-ready, but a teammate must currently ignore or reconcile contradictory normative and supersession text to choose session topology, callback durability meaning, and the already-selected private-key configuration.

Deliberate deferrals:

- publication membership, coordinated versus independent package versions, release/deployment policy, and external-consumer cutover;
- dynamic membership, mutable/named groups, contacts/invitations, and multiple groups with identical membership;
- pruning, garbage collection, retention, disk-loss recovery, and a separate transactional evidence-outbox mechanism;
- encryption/key distribution, public observers, nonmember disclosure, and cross-history audit conventions;
- malicious/replicated Registry or Router, Router failover/fork recovery, identity rotation/recovery, and delegation evidence;
- richer task/norm vocabularies, configurable quorums, timeout replacement, view change, pass/takeover, disputes, fairness/starvation guarantees, signature aggregation, and binary/media actions;
- fragmentation/larger resource profiles;
- remote daemon administration, hostile-host/local-auth hardening, dynamic ports/attachment, alternate push/cursors, asynchronous task handles, and dynamic action tools;
- CoordBench migration, which Event 8 explicitly defers.

Accidental gaps:

- current `docs/spec/README.md` still requires native shared sessions and strengthens callback success into native host persistence;
- four predecessor ADR `Supersession` sections still present the removed idempotency/session/persistence rules as current;
- `docs/spec/identity.md` still calls an exact daemon configuration choice unassigned;
- `v2/VISION.md → Current cutover decisions` and `Evidence and path` do not enumerate the three current 20260828 ADRs or their source-gap reports, although the decision index and manifest make them discoverable;
- the addressed trajectory lacks public agent prompts/selections and the referenced implementation plan;
- all three 20260828 decisions have explicit source-evidence gaps with no source-faithful event row.

The provenance gaps do not force an implementer to invent protocol behavior because the ADRs and detailed specs state that behavior. The normative and supersession contradictions do require reconciliation before implementation can proceed under the repository’s own authority rule.

Verdict: **FAIL**

## Discovery trail

| Order | Entry point or navigation | Path/heading discovered | Result |
|---:|---|---|---|
| 1 | Candidate root and Git metadata | `AGENTS.md`, `v2/AGENTS.md`; clean HEAD/tree | Found authority order and required `decisions` procedure |
| 2 | Repository-required skill | `.claude/skills/decisions/SKILL.md`, provenance rules, fixed questions/template | Established blind-gate and quarantine rules |
| 3 | Git merge-base/name-only comparison | Merge base `0366f7d9…`; changed ADR/spec/evidence paths | Saw quarantined artifact paths only; no contents read |
| 4 | Decision index | `docs/decisions/README.md → Canonical reading guidance`, `Records` | Discovered four current ADRs and manifest owner |
| 5 | Highest authority | `v2/VISION.md → Authority`, `The constitution`, `First executable profile`, `Deliberate deferrals` | Established current guarantees and assumptions |
| 6 | Current ADRs | Four 20260827/20260828 records → `Supersession`, `Decision Outcome` | Reconstructed current combined decision |
| 7 | Predecessor lineage | Changed older ADRs → `Supersession` | Found stale idempotency/session/persistence summaries |
| 8 | Manifest | Four-layer ADR → `Gate 1 traceability disposition` | Traced stable IDs to normative headings |
| 9 | Normative owners | Conversation history, tasks, client, output, ingress, channels, daemon, management, layer interfaces | Reconstructed exact implementation contract |
| 10 | Provenance | Addressed trajectory and three source-gap reports | Identified cited events and explicit gaps |
| 11 | Focused stale-term search with quarantine exclusions | Current ADR/spec/authority and non-normative orientation | Found normative session/persistence and daemon-config contradictions |
| 12 | Mechanical check | `pnpm nx run workspace:lint:adr-shape` | PASS: 65 ADRs mechanically well-formed; semantic defects remain |

## Author interventions

None.

## Blockers

| ID | Finding | Evidence | Required reconciliation |
|---|---|---|---|
| BR-1 | Current normative spec summary still requires shared sessions and host persistence | `docs/spec/README.md → Implementation readiness`, `Addressed Client boundary`; conflicts with stock-host ADR and detailed channel/ingress specs | Replace with runtime-owned session topology and callback-success-before-ack wording |
| BR-2 | Superseded-record lineage still states removed idempotency/session/persistence rules as current | `20260801-harness-client-owns-runtime-context.md`, `20260813-client-protocol-and-attention.md`, `20260812-harness-client-uses-conversation-id.md`, `20260801-model-output-is-start-or-bound-reply.md` → `Supersession` | Reconcile visible retained/replaced scope and replacement links; add required changelog receipts |
| BR-3 | Identity spec calls exact daemon key-path ownership unresolved after it was selected | `docs/spec/identity.md → Registration`; retained 20260813 daemon outcome; `docs/spec/harness/daemon.md → Process and configuration` | State that the daemon receives `MOLTZAPD_AGENT_PRIVATE_KEY_FILE`; remove the stale unassigned choice |
| BR-4 | Highest-level current-decision/provenance list omits three current ADRs | `v2/VISION.md → Current cutover decisions`, `Evidence and path` | Add the current 20260828 decisions and explicit source-gap artifacts, or clearly mark the list non-exhaustive |

## Per-question verdicts

| Question | Verdict |
|---:|---|
| 1 | PASS |
| 2 | FAIL |
| 3 | FAIL |
| 4 | PASS |
| 5 | FAIL |
| 6 | FAIL |

## Overall result

Result: **FAIL**

The candidate’s current protocol, retry, signature-ordering, and stock-host outcomes are independently understandable, and the mechanical ADR-shape check passes. It does not pass the semantic blind gate because current normative text and visible supersession lineage still contradict those outcomes. Repository law says those conflicts stop implementation.

No implementation code was evaluated. No quarantined review content was opened or returned. A corrected semantic candidate requires a new frozen identity and a different fresh reviewer.
