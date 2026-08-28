# Blind decision review: addressed messaging at `b77175a7`

## Review identity

| Field | Value |
|---|---|
| Review run ID | `addressed-messaging-b77175a7-cold-review-v4` |
| Candidate repository root | `/home/tapanc/moltzap-v2-cutover` |
| Candidate commit | `b77175a75075cb8bedac0835c9907bc507e50ea4` |
| Candidate tree | `0b4f0d2946c1b640944caf0d45453b17415a9464` |
| Candidate content digest | SHA-256 `33a74f25b9822a6ee952e67e295805e29bc4a66227739321808f2e2216503e74` |
| Digest scope and command | Complete tracked candidate tree listing: `git ls-tree -r --full-tree b77175a75075cb8bedac0835c9907bc507e50ea4 \| sha256sum` |
| Reviewer | Codex fresh blind teammate, `/root/blind_authority_review_v4` |
| Reviewer session | One uninterrupted fresh-agent context; no inherited candidate conversation |
| Review started | `2026-08-28T00:42:34Z` |
| Review finished | `2026-08-28T00:54:45Z` |
| Review duration | 12 minutes 11 seconds |
| Review budget | One uninterrupted fresh-agent context |
| Rerun of | Not provided. Earlier review records remained quarantined. |
| Rerun reason | Not provided. |

## Fresh-context attestation

The reviewer attests:

- [x] I did not author or reconcile the candidate decision.
- [x] I received no inherited conversation, summary, memory, private state,
      or earlier blind-review output about the candidate.
- [x] I received only the candidate repository root, exact candidate revision,
      and the fixed questions below.
- [x] I received no out-of-band design summary, diff tour, ADR or file pointer,
      search term, expected answer, or answer key.
- [x] I navigated the repository independently using checked-in entry points,
      repository-native indexes, ordinary search, and repository history.
- [x] I did not open, read, or search the contents of an earlier cold-review,
      blind-review, or invalid-review record. Directory listing returned only
      quarantined artifact paths, never an answer or verdict from one.
- [x] I did not ask the author for help or modify the frozen candidate before
      submitting these answers.
- [x] The author interventions recorded below are complete.

The review artifact is added after evaluation of the frozen candidate. It is
not part of candidate commit `b77175a75075cb8bedac0835c9907bc507e50ea4`.

## Exact review prompt

1. What decision does this candidate make current, what problem does it resolve, and which statements are binding versus context or non-normative explanation?
2. What earlier outcomes does it replace, retain, or leave untouched, and where does the current normative contract live?
3. What must an implementer now do or avoid, which layers or consumers are affected, and under what fault, trust, safety, liveness, and compatibility assumptions?
4. Which humans are named as decision-makers, which source events does the compacted trajectory cite for their calls, alternatives, reversals, and deferrals, and what source gaps does it explicitly record? Report only what the event ledger states; do not infer motives, confidence, urgency, or rationale.
5. Find the strongest apparent contradiction, stale instruction, or broken lineage elsewhere in the repository. Resolve it using the authority order or report it as a blocker.
6. Could a teammate implement the decision without chat or guessing? List every missing link or unresolved choice and classify each as a deliberate deferral or an accidental gap.

## 1. Current decision, problem, and authority

The candidate makes **addressed fixed-member messaging** current. Applications
send nonempty posts to `agent:<AgentName>` or
`group:<AgentName>,<AgentName>,...`; Client privately derives the deterministic
conversation, exposes one structural `HarnessEndpoint` with `send` and
`messages`, and removes public `ConversationId`, START, `HarnessTurn`, bound
reply, reply grants, current-chat targeting, and OpenFloorV1. Every local
runtime uses one host-native session. Visible output uses the host's durable
native messaging path with an explicit address, while plain final text remains
private.

GENESIS is unanimous. Ordinary POST uses the author-inclusive threshold
`q(n)=n` for `n<4` and `q(n)=n-floor((n-1)/3)` otherwise. Action certification
and durability voting remain separate. Logical post, action, and record hashes
exclude mergeable signer evidence, while every verified signer AgentId and
signature remains auditable. A successful send returns `void` only after the
local endpoint holds the complete certified record. Remote certified posts
create durable pending deliveries that are acknowledged only after native host
persistence.

This resolves the duplication between Client's caller-minted conversation and
turn/grant model and OpenClaw/NanoClaw's existing durable messaging and session
behavior. It also supplies first-class immutable groups without adding a group
directory, invitation lifecycle, central product Ledger, or second host
messaging implementation.

The binding source is the accepted Decision Outcome in
`docs/decisions/20260827-addressed-messaging-replaces-openfloor.md`, read under
`AGENTS.md` and `v2/VISION.md`. Its exact interface, protocol, persistence,
MCP, adapter, and failure contracts are delegated to the normative
`docs/spec/` headings named in the current trace manifest. The ADR's Context
and Problem Statement explains why the decision exists. Its Consequences and
Record changelog describe effects and history rather than independently
creating a second outcome. The compacted trajectory explicitly declares
itself non-normative. `docs/architecture/` and the AgentCoordBench handoff are
orientation or downstream input and cannot override the outcome.

Independently discovered paths and headings:

- `docs/decisions/20260827-addressed-messaging-replaces-openfloor.md` —
  Decision Outcome, Traceability disposition, Consequences
- `v2/VISION.md` — Authority, The constitution, First executable profile
- `docs/spec/README.md` — Addressed Client boundary, Version namespaces
- `docs/spec/harness/client.md` — Service shape, Addressed send, Addressed
  inbound delivery
- `docs/spec/conversation-history.md` — Addresses and membership, GENESIS and
  POST, Action validity and storage durability

## 2. Replacement, retention, untouched outcomes, and normative owners

The candidate fully supersedes these prior runtime/protocol outcomes:

- `20260726-the-engine-dispatches.md`;
- `20260728-model-surface-is-start-reply-listen.md`;
- `20260728-open-floor-v1.md`;
- `20260801-harness-client-owns-runtime-context.md`;
- `20260801-inbound-notifications-separate-content-from-grants.md`;
- `20260801-model-output-is-start-or-bound-reply.md`;
- `20260805-harness-client-is-the-production-adapter-contract.md`; and
- `20260812-harness-client-uses-conversation-id.md`.

Their START/MULTICAST, BEGIN/ACK, OpenFloor contention, live grants, turn
delivery, events-v1, public conversation identity, bound reply, presentation
checkpoint, and current-conversation-only outcomes have no current scope.

The candidate partially supersedes and precisely retains portions of earlier
records:

- `20260723-lifecycle-rides-l3.md` retains in-band fixed-membership genesis
  with initial content and no control-plane create operation.
- `20260724-firewall-two-directions.md` retains the inbound/outbound endpoint
  boundary and local signing, attention, disclosure, and reliance policy.
- `20260728-endpoint-daemon-speaks-modern-mcp.md` retains modern MCP framing,
  the official SDK boundary, one loopback listener, local trust, discovery,
  subscription ownership, and compatible supervision mechanics.
- `20260728-gate-1-architecture-freeze.md` retains repository-native authority,
  stable trace IDs, contradiction checks, and the blind gate.
- `20260728-simulator-is-the-system-driver.md` retains one simulator, its
  system-driver role, closed events, and simulation `RunLedger`.
- `20260801-main-simulator-runs-container-societies-on-kubernetes.md` retains
  `RunSpec`, `Run.execute`, Kubernetes execution, native gateways, run
  evidence, and compatible facades.
- `20260811-four-layer-endpoint-replicated-harness.md` retains four layers,
  endpoint-replicated certified history, stage-before-vote durability,
  catch-up, Router re-anchor, daemon topology, seven-package graph, and the
  cutover outcome.
- `20260813-client-protocol-and-attention.md` retains Client ownership of
  closed representation, SQLite persistence, registration recovery,
  management isolation, verified catch-up/re-anchor, and daemon configuration.

Identity and Router ownership, authentication, opaque non-equivocating Router
order, the no-product-Ledger boundary, the seven-package DAG, the accepted
post-Router Simulator fault decision, and unrelated stable trace rows remain
untouched except that every participating wire value must use the one advanced
source protocol version.

The current normative contract is intended to live in this order:

1. `AGENTS.md` and `v2/VISION.md`;
2. the accepted addressed-messaging ADR and explicitly retained portions of
   partially superseded ADRs;
3. the single current stable manifest at
   `20260811-four-layer-endpoint-replicated-harness.md` — Gate 1 traceability
   disposition; and
4. its exact owners in `docs/spec/`, chiefly `conversation-history.md`,
   `harness/client.md`, `harness/tasks.md`, `harness/output.md`,
   `harness/ingress.md`, `harness/channels.md`, `harness/daemon.md`,
   `management.md`, and `layer-interfaces.md`.

That lineage is not internally consistent in the candidate; question 5
records the blocking stale entry points.

Independently discovered paths and headings:

- `docs/decisions/README.md` — Canonical reading guidance, Records
- `docs/decisions/20260811-four-layer-endpoint-replicated-harness.md` —
  Supersession, Gate 1 traceability disposition
- each changed predecessor ADR — Supersession
- `docs/spec/README.md` — Authority and reading order, Gate 1 chapters

## 3. Implementation obligations and assumptions

An implementer must:

- replace Client's public root with the exact structural `HarnessEndpoint`,
  closed addressed values and errors, `send({idempotencyKey,to,content})`, and
  an inbound delivery stream;
- canonicalize direct and group addresses through Registry, insert self into a
  group when omitted, reject duplicates and unknown names, sort names by ASCII
  bytes, enforce direct membership 2 and group membership 3 through 32, and
  deterministically reuse one private conversation for one AgentId set;
- persist author-scoped post intent before traffic, make identical retries
  resume, reject changed intent, run unanimous GENESIS and author-inclusive
  threshold POST, lock the first valid gap-free Router-ordered successor, and
  separate action signatures from stage-before-vote durability evidence;
- retain verified signer identities and bytes outside `ActionHash` and
  `RecordHash`, support any-member evidence assembly, automatic catch-up,
  Router re-anchor, durable pending delivery, stable replay, and collision
  rejection;
- expose only address-based owner-authorized management and events-v2 on one
  loopback `/mcp`, with delivery acknowledgment after host durability;
- route every OpenClaw delivery through its resolved main session and every
  NanoClaw delivery through `agent-shared`; use native `message`,
  `send_message`, or `<message to>` for visible output; and keep plain final
  text private;
- update Simulator and evals to consume the same Client boundary while
  preserving compatible Simulator facades and the private post-Router fault
  seam; and
- perform the fresh-state hard cut, remove retired APIs and implementation,
  and keep the exact seven-package dependency graph.

It must avoid public conversation/proof/protocol values, inherited targets,
reply-by-identifier, group CRUD or directories, automatic semantic
acknowledgments, a Client retry queue, a second model send tool, raw network or
store authority in runtimes, Client-managed prompt/session snapshots, central
Ledger storage, compatibility aliases, dual stacks, migrations, feature flags,
and silent old-state erasure.

The affected owner is `@moltzap/client`; direct consumers are OpenClaw,
NanoClaw, Simulator, and evals. Registry remains identity-only and name
resolution. Router remains content-blind and volatile. The daemon owns local
protocol and persistence. Host runtimes own sessions, scheduling, durable
inbox/outbox behavior, and model invocation.

The trust and fault profile assumes one correct non-equivocating Registry and
one correct non-equivocating Router. Either may be unavailable and Router may
restart, but malicious/equivocating service behavior is outside the profile.
Endpoints may be Byzantine. For `n>=4`, with at most
`f=floor((n-1)/3)` Byzantine members and honest stage-before-sign behavior,
`q(n)=n-f` durability evidence proves at least `n-2f` honest staged replicas.
For `n<4`, the storage guarantee assumes zero Byzantine members. GENESIS
requires unanimity; ordinary POST safety relies on quorum intersection, an
author-inclusive certificate, and each honest endpoint's durable
first-candidate/no-double-sign lock.

Safety is timing-independent. Progress requires available or cached identity
material, Router delivery, a responsive selected action quorum, a responsive
durability quorum, and at least one honest source for missing ancestry. Trust
refusal, a selected candidate that cannot reach threshold, a service outage,
or missing ancestry may stall one conversation. The profile claims no
fairness, starvation freedom, view change, malicious-service recovery, dynamic
membership, or encrypted history. Already certified local history remains
readable and verifiable during service outages.

Compatibility is intentionally closed: the source protocol version advances
once, Client hashes move to `moltzap/client/v2/*`, MCP uses
`xyz.moltzap/events-v2`, and endpoint SQLite uses schema 2. A truly empty
version-0 store may initialize to 2; nonempty version 0, version 1, and every
other version are rejected untouched. Mixed peers and prior-extension clients
fail with typed incompatibility. There is no migration, decoder, dual stack,
feature flag, compatibility alias, automatic erase, or rollback automation.

Independently discovered paths and headings:

- `v2/VISION.md` — First executable profile
- `docs/spec/layer-interfaces.md` — Client and daemon behavior, Trust, safety,
  and progress, Simulator cutover
- `docs/spec/conversation-history.md` — Proposal ordering and idempotency,
  Action validity and storage durability, Catch-up and Router restart,
  Persistence and compatibility
- `docs/spec/harness/channels.md` — One native session, Native messaging
- `docs/architecture/first-implementation.md` — Lanes 4 through 7

## 4. Decision-makers, source events, and source gaps

The new ADR names one human decision-maker: **Tapan Chugh**. The trajectory's
source records contain `session_id`, `text`, and Unix `ts`; they contain no
separate human identity or stored actor-role field. The ledger therefore
labels each retained item `user input` and does not use the source account to
prove the ADR's rationale.

The trajectory cites these retained events from Codex local-history session
`019fd899-779c-7e70-a8e4-338727b13e6c`:

1. line 2920, `2026-08-27T18:57:37Z`: asks to restore cross-conversation
   context, requests group chat, and states “Individual private cal but shared
   meetings.” A near-duplicate at line 2921 is omitted.
2. line 2922, `2026-08-27T19:27:10Z`: says to remove OpenFloorV1 now and that
   it can be added later as a projection.
3. line 2924, `2026-08-27T19:55:09Z`: says to reduce debt and fall back to
   existing OpenClaw and NanoClaw code where possible.
4. line 2925, `2026-08-27T20:41:17Z`: asks whether both hosts can route through
   one main session with only `agent:` and `group:`.
5. line 2927, `2026-08-27T20:52:54Z`: replaces email-like attendees with
   agent addresses and rejects automatic notifications; a normal agent message
   may announce an invite.
6. line 2930, `2026-08-27T21:29:13Z`: asks whether OpenClaw's native message
   tool is preferable because direct reply feels odd. The ledger explicitly
   says this question does not establish its answer.
7. line 2932, `2026-08-27T21:52:53Z`: asks about the native-messaging rule and
   requires a group recipient to know that the message is a group
   conversation. The missing explanation and selection are not reconstructed.
8. line 2929, `2026-08-27T21:17:54Z`: defers CoordBench migration to a later
   handoff, rejects back-compat as a goal, and says not to overcomplicate
   rollback.
9. line 2936, `2026-08-27T22:21:49Z`: asks whether work is against the new
   four-layer cutover branch. The agent answer is missing.
10. line 2940, `2026-08-27T22:52:08Z`: says “Implement the plan.” The plan is
    not present in the source.
11. line 2943, `2026-08-27T23:54:53Z`: says “ookay, that sounds good.
    proceed.” The preceding prompt is absent, so the ledger does not treat the
    reply as independent proof of the detailed hash/evidence choice.

The retained material records an explicit removal of OpenFloorV1 and a move
away from reply-shaped output toward native messaging. It records questions
about the message tool and native-messaging requirement, not a recoverable
structured alternatives comparison. The only explicit downstream deferral is
the CoordBench migration. No motive, confidence, urgency, or rationale is
inferred from these events.

The trajectory explicitly records these source gaps:

- no native message ID, turn ID, parent locator, or actor-role field exists in
  the local-history source;
- intervening public agent explanations, structured-choice prompts and
  selections, and the final implementation plan are absent;
- the source therefore cannot reconstruct the rationale or direct selection
  for canonical name sorting, the ordinary POST threshold, or the detailed
  interface and wire shapes;
- the duplicate line 2921 is omitted, and longer submissions have disclosed
  omissions;
- Events 6 and 7 are questions without retained answers;
- Event 9 lacks the agent's branch answer;
- Event 10 references a missing plan; and
- Event 11 lacks the prompt needed to interpret the terse assent.

The cited session, line locators, timestamps, stored keys, and literal retained
text were independently checked. This verifies the ledger's locators; it does
not fill the gaps or prove omitted rationale.

Independently discovered paths and headings:

- `docs/decision-evidence/20260827-addressed-messaging-trajectory.md` — Source
  scope and gaps; Addressed messaging, groups, and shared meetings; Native
  messaging and group visibility; Compatibility, process, and downstream
  deferral
- `docs/decisions/20260827-addressed-messaging-replaces-openfloor.md` —
  frontmatter and Decision provenance

## 5. Strongest contradiction or broken lineage

The strongest contradiction is in the top-authority
`v2/VISION.md` preamble under **Current cutover decisions**. It omits the new
accepted addressed-messaging ADR and still names
`20260812-harness-client-uses-conversation-id.md` as current even though that
record's frontmatter is `superseded` and its Supersession says no portion of
the Client interface remains current. It also names
`20260813-client-protocol-and-attention.md` without limiting readers to its
explicitly retained persistence/daemon scope. Later sections of the same
Vision describe `HarnessEndpoint`, GENESIS/POST, events-v2, and native shared
sessions, so the high-authority document contradicts its own current-decision
list.

The intended result can be inferred from authoritative frontmatter and visible
Supersession sections: the 2026-08-27 ADR is current, the 2026-08-12 ADR is
historical only, and the 2026-08-13 ADR retains only the scope its Supersession
names. That inference does not cure the candidate. `v2/VISION.md` sits at the
top of the authority order, so a lower ADR cannot silently override a stale
top-level “current” list. This is a blocker.

There is a second broken navigation path in
`docs/decisions/README.md` — Canonical reading guidance. It directs a reader to
the architecture freeze's historical inventory plus the current messaging
decision's “replacement rows.” The new ADR says instead that the updated table
in `20260811-four-layer-endpoint-replicated-harness.md` is the **single current
manifest**, and the new ADR contains no separate replacement-row table. The
reviewed decision index must point directly to that current manifest.

Independently discovered paths and headings:

- `v2/VISION.md` — Current cutover decisions, Authority, Evidence and path
- `docs/decisions/20260812-harness-client-uses-conversation-id.md` —
  frontmatter, Supersession
- `docs/decisions/20260813-client-protocol-and-attention.md` — frontmatter,
  Supersession
- `docs/decisions/README.md` — Canonical reading guidance
- `docs/decisions/20260811-four-layer-endpoint-replicated-harness.md` — Gate 1
  traceability disposition

## 6. Implementability, deliberate deferrals, and accidental gaps

**No.** A teammate can implement the public semantic behavior and package
boundaries, but cannot implement an interoperable Client protocol without
inventing binding bytes and validation rules.

Deliberate deferrals are clearly classified:

- publication membership, coordinated versus independent package versions,
  external-consumer cutover, release ordering, deployment, npm/image
  publication, and a self-contained Simulator artifact;
- dynamic membership, mutable or named groups, multiple groups for one member
  set, group invitations, contacts, introductions, blocking, and approval
  semantics;
- pruning, garbage collection, retention policy, compression mechanism, and
  recovery after local disk loss;
- encryption and key distribution, public observers, non-member audit and
  disclosure conventions, malicious or replicated Registry/Router profiles,
  Router replication, Byzantine sequencing, failover, and fork recovery;
- richer task/norm action vocabularies, configurable quorums, timeout
  replacement, view change, pass/takeover, disputes, fairness, starvation
  freedom, signature aggregation, and a distinct transactional evidence
  outbox;
- fragmentation, a larger resource profile, and binary/media action content;
- portable personal-trust conformance, remote administration, hostile-host
  defense, dynamic ports, attachments, universal supervision, MCP cursors,
  alternate push, asynchronous task handles, and dynamic action tools; and
- calendar implementation and CoordBench migration, which are explicitly
  downstream handoff work.

The accidental gaps are blocking:

1. **Current-authority and manifest entry points are inconsistent.** The stale
   Vision list and decision-index guidance described in question 5 prevent one
   unambiguous cold-start reading order.
2. **The exact closed Client wire contract is missing.** The candidate's
   `conversation-history.md` — Closed values and hashes gives abstract “binds”
   prose and two partial action-core interfaces, but no exact closed schemas
   for `MembershipDescriptor`, `AnchorBody`/re-anchor bodies, post intent,
   action binding, canonical record core, action-signature statements,
   durability-vote statements, certificates, catch-up requests/pages,
   re-anchor votes/completion, or the direct Client packet union. It also does
   not define the deterministic stable inner `SignedMessage` MessageId and
   complete outer-envelope rules. The parent contract had explicit **Exact
   closed values** and **Stable evidence and Router envelopes** sections; the
   replacement removed them while declaring implementation readiness. Hash
   preimages, signature preimages, decoding, cross-field validation, and
   peer interoperability therefore require guesses.
3. **The exact management representation is incomplete.** `management.md`
   calls requests and results closed but does not give exact request/result
   schemas for address paging, frozen history continuations, record/evidence
   projection, or the closed failure envelope. Independent daemon and adapter
   implementations cannot derive one byte-compatible MCP contract from that
   prose.
4. **The hard-cut protocol value is not selected.** The new outcome and trace
   row say `V2_PROTOCOL_VERSION` advances once, while the candidate leaves
   `v2/VERSION` and the normative Identity/Router representation at the baked
   exact value `2026.729.1`. “Advance once” does not identify the next wire
   literal or reconcile which value the candidate makes current. The exact
   value must be selected and updated atomically across its source, generated
   snippet, Identity/Router framing, and Client representation.
5. **Fresh-store classification is underspecified.** “Truly empty version 0”
   versus “nonempty version 0” determines whether Client initializes or
   refuses a database, but the contract does not define the observable SQLite
   criterion. Implementations can disagree at a destructive compatibility
   boundary.

These are not choices listed as deliberate deferrals. The candidate instead
marks Client protocol, daemon representation, and implementation readiness as
current. They must be reconciled before implementation can proceed without
chat or guessing.

Independently discovered paths and headings:

- `docs/spec/README.md` — Implementation readiness, Version namespaces
- `docs/spec/conversation-history.md` — Closed values and hashes, Persistence
  and compatibility
- `docs/spec/management.md` — Conversation search and history, Closed failures
- `docs/spec/layer-interfaces.md` — Client and endpoint communication
- `docs/spec/identity-representation.md` — HTTP request framing and ownership
- `docs/spec/router-representation.md` — Authenticated request envelope
- `docs/snippets/constants/values.mdx`
- candidate parent history of `docs/spec/conversation-history.md` — Exact
  closed values, Stable evidence and Router envelopes
- `v2/VERSION`

## Discovery trail

| Order | Entry point, search, or navigation step | Path and heading discovered | Result |
|---:|---|---|---|
| 1 | Verified the supplied revision, clean state, parent, and changed-path list. | Candidate commit and tree | Confirmed exact frozen candidate before reading. |
| 2 | Read repository entry instructions and followed their ADR-review procedure. | `AGENTS.md` — Decisions; `.claude/skills/decisions/SKILL.md`; provenance and fixed-question references | Established authority, provenance, quarantine, and gate rules. |
| 3 | Opened the checked-in decision index without searching review contents. | `docs/decisions/README.md` — Canonical reading guidance, Records | Found the new accepted ADR and its predecessor statuses. |
| 4 | Followed the new ADR's visible provenance links. | `20260827-addressed-messaging-replaces-openfloor.md`; `20260827-addressed-messaging-trajectory.md` | Reconstructed the claimed outcome and explicit source gaps. |
| 5 | Followed the repository authority order. | `v2/VISION.md` — Authority, The constitution, First executable profile, Deliberate deferrals | Confirmed semantic outcome and found the stale current-decision list. |
| 6 | Followed the new ADR's manifest pointer. | `20260811-four-layer-endpoint-replicated-harness.md` — Supersession, Gate 1 traceability disposition | Found the single 150-row current manifest and exact normative-owner claims. |
| 7 | Followed changed manifest rows into normative specifications. | `docs/spec/README.md`, `conversation-history.md`, `harness/*`, `management.md`, `layer-interfaces.md` | Confirmed public semantics, assumptions, compatibility cut, and deferrals. |
| 8 | Read changed predecessor Supersession sections and frontmatter. | Changed ADRs under `docs/decisions/` | Classified fully and partially superseded outcomes. |
| 9 | Searched implementation-facing docs for retired terms, excluding all decision-review artifacts. | `docs/architecture/`, package instructions, guides, integrations | Historical architecture pages were visibly quarantined as superseded; current code remains migration input. |
| 10 | Compared the candidate's Client protocol chapter with its parent revision. | Git history of `docs/spec/conversation-history.md` | Found that exact closed wire schemas and envelope rules were removed without a replacement. |
| 11 | Checked source event metadata, timestamps, and retained excerpts at the cited local-history locators. | Codex local history session `019fd899-779c-7e70-a8e4-338727b13e6c` | Locators resolve and explicit source gaps remain gaps. |
| 12 | Ran the repository's mechanical ADR validator. | `scripts/docs/adr/check-shape.ts` | PASS: 62 ADR records are mechanically well formed; semantic blockers remain. |

## Author interventions

| Time | Intervention | Effect on review |
|---|---|---|
| none | none | none |

## Per-question verdicts

| Question | Verdict | Reason |
|---:|---|---|
| 1 | PASS | The semantic decision, problem, and binding/non-normative boundary are independently discoverable. |
| 2 | FAIL | Individual Supersession sections are precise, but the top-level current-decision list and canonical manifest guidance are inconsistent. |
| 3 | PASS | Required behavior, forbidden compatibility paths, affected consumers, and fault/safety/liveness assumptions are discoverable at the semantic level. |
| 4 | PASS | The named human, retained source events, literal locators, questions, deferral, and source gaps are explicit and independently checkable without inferring rationale. |
| 5 | FAIL | A top-authority current-decision list is stale and the reviewed index points to the wrong manifest composition. |
| 6 | FAIL | Exact protocol, management representation, version literal, and fresh-store classification are accidental gaps that force binding implementation guesses. |

## Blockers

| ID | Finding | Evidence | Required reconciliation |
|---|---|---|---|
| BR-1 | Top-authority current-decision list is stale. | `v2/VISION.md` — Current cutover decisions versus current ADR frontmatter and Supersession | Add the 2026-08-27 ADR, remove the fully superseded 2026-08-12 ADR, and qualify retained 2026-08-13 scope. |
| BR-2 | Decision index describes the wrong current-manifest composition. | `docs/decisions/README.md` — Canonical reading guidance versus the new ADR's Traceability disposition | Point directly to the updated 2026-08-11 single current manifest and its normative owners. |
| BR-3 | Closed Client wire and MCP management representations are not exact. | `docs/spec/conversation-history.md` — Closed values and hashes; `docs/spec/management.md`; candidate parent history | Add complete closed schemas, packet/envelope identities, signature/hash preimages, cross-field validation, and management request/result/failure representation. |
| BR-4 | The hard-cut wire version has no exact current value. | `v2/VERSION`, generated constant snippet, Identity/Router framing, new ADR Fresh-state wire and store cut | Select the exact advanced literal and update every normative and generated owner atomically. |
| BR-5 | Version-0 empty-store classification is ambiguous at a destructive boundary. | `docs/spec/conversation-history.md` — Persistence and compatibility | Define the exact observable SQLite criterion for direct initialization versus untouched rejection. |

## Overall result

Result: **FAIL**

The candidate clearly selects addressed messaging and records most semantic
replacement, retention, trust, fault, and compatibility boundaries. It does
not pass the blind gate because current-authority navigation is inconsistent
and an implementer must invent exact wire, MCP, version, and store-admission
contracts that the candidate declares ready. The mechanical ADR shape check
passes, but semantic lineage and implementability do not.

## Maintainer acceptance

This reviewer result is evidence, not self-certifying acceptance.

| Field | Value |
|---|---|
| Maintainer | pending |
| Reviewed result | `addressed-messaging-b77175a7-cold-review-v4` |
| Candidate identity matches | pending |
| Gate decision | pending |
| Decision time | pending |
| Rationale | pending |

## Rerun identity

| Field | Value |
|---|---|
| Superseded by review run | none |
| Superseded candidate commit | none |
| Superseded candidate content digest | none |
| Reason a rerun was required | none recorded in this run |
