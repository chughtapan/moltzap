# Blind decision review record

This record captures an isolated teammate review of the addressed-messaging
authority candidate. It is review evidence, not normative authority or
maintainer acceptance.

## Review identity

| Field | Value |
|---|---|
| Review run ID | `addressed-messaging-441d80f8-blind-review` |
| Candidate commit | `441d80f8aca21a1009f4edfa5c891db8221115ac` |
| Candidate tree | `a802b30f91c41b757891f88785195f9364fc9d24` |
| Candidate content digest | SHA-256 `feaa3b8ee342ed7b3d36bef43765183b55da4f3cef6dc7b036312b14061d4115` |
| Digest scope and command | Complete candidate tree listing: `git ls-tree -r --full-tree 441d80f8aca21a1009f4edfa5c891db8221115ac \| sha256sum` |
| Reviewer | Codex fresh teammate agent `/root/blind_authority_review_v8` |
| Reviewer session | `/root/blind_authority_review_v8` |
| Review started | `2026-08-28T01:46:04Z` |
| Review finished | `2026-08-28T01:58:30Z` |
| Review duration | 12 minutes 26 seconds |
| Review budget | One uninterrupted fresh-agent context, maximum 45 minutes |
| Rerun of | none disclosed to the reviewer |
| Rerun reason | none disclosed to the reviewer |

## Exact review prompt

```text
You are a fresh blind teammate reviewer. Review exact candidate `441d80f8aca21a1009f4edfa5c891db8221115ac` in repository `/home/tapanc/moltzap-v2-cutover`. Use only that candidate repository and normal repository navigation/history/search. Do not open, read, or search the contents of any earlier `*-cold-review.md`, `*-blind-review.md`, or invalid-review record; seeing an artifact path in a listing is allowed. If any command returns an answer or verdict from one, invalidate the run immediately. You have no author conversation, summary, diff tour, expected outcome, or private state. Do not ask the author questions and accept no hints. Record candidate identity, this exact prompt, reviewer identity/isolation attestation, duration, unedited answers, independently discovered paths/headings, discovery trail, author interventions, per-question verdicts, blockers, and overall PASS/FAIL under `docs/decision-evidence/` in a newly named artifact containing the short candidate SHA. Answer exactly these six questions:

1. What decision does this candidate make current, what problem does it resolve, and which statements are binding versus context or non-normative explanation?
2. What earlier outcomes does it replace, retain, or leave untouched, and where does the current normative contract live?
3. What must an implementer now do or avoid, which layers or consumers are affected, and under what fault, trust, safety, liveness, and compatibility assumptions?
4. Which humans are named as decision-makers, which source events does the compacted trajectory cite for their calls, alternatives, reversals, and deferrals, and what source gaps does it explicitly record? Report only what the event ledger states; do not infer motives, confidence, urgency, or rationale.
5. Find the strongest apparent contradiction, stale instruction, or broken lineage elsewhere in the repository. Resolve it using the authority order or report it as a blocker.
6. Could a teammate implement the decision without chat or guessing? List every missing link or unresolved choice and classify each as a deliberate deferral or an accidental gap.

PASS only if all six answers are accurate and discoverable with consistent status, lineage, authority, assumptions, normative ownership, and source-event attribution. Any wrong or unfindable answer, broken locator, unresolved contradiction, invented binding choice, or need for an author hint is FAIL.
```

## Fresh-context attestation

The reviewer attests:

- [x] I did not author or reconcile the candidate decision.
- [x] I received no inherited author conversation, design summary, memory,
      private state, or earlier blind-review output about the candidate.
- [x] I received the clean candidate checkout, its identity, the fixed
      questions, and the isolation constraints reproduced above.
- [x] I received no out-of-band design tour, ADR or specification pointer,
      search term, expected answer, or answer key.
- [x] I navigated the repository independently using checked-in entry points,
      repository-native indexes, ordinary search, and repository history.
- [x] I did not open, read, or search the contents of an earlier cold-review,
      blind-review, or invalid-review record. Artifact paths appeared in a
      directory listing and history only; no answer or verdict from one was
      returned.
- [x] I did not ask the author for help or change the candidate tree before
      submitting these answers. This new review record is the only working-tree
      addition.
- [x] The author interventions recorded below are complete.

## Fixed questions and verbatim answers

### 1

The candidate makes addressed messaging the current Client and runtime
contract. Applications send to exactly `agent:<AgentName>` or
`group:<AgentName>,...`; Client privately resolves fixed membership and
conversation identity. Direct conversations have two members. Groups have 3
through 32 total members, insert the local member when omitted, reject
duplicates and unknown names, serialize canonical AgentNames in ASCII order,
and deterministically reuse one private conversation for one member set.

The public runtime capability is the structural, scoped `HarnessEndpoint` with
`send({idempotencyKey, to, content})` and `messages`. An inbound delivery is a
discriminated direct or group message plus a transport-only acknowledgment.
The host's durable outbox identity derives the author-scoped `PostId`;
identical intent resumes, changed destination or content conflicts, and send
returns `void` only after the local endpoint has complete action and durability
certification. Public `ConversationId`, `HarnessClient`, turns, START, bound
reply, reply grants, implicit current-chat routing, proof-shaped results, and
reply-by-identifier are absent.

Every address enters one native session per local agent: OpenClaw's resolved
main session or NanoClaw's `agent-shared`. Visible output uses the host's native
messaging path with an explicit address. Plain final text is private. Inbound
messages themselves provide attention; the adapter acknowledges only after
durable host insertion, and neither receipt nor acknowledgment creates reply
authority or an automatic semantic response.

The private fixed-post protocol is unanimous `GENESIS` followed by `POST`.
Ordinary `POST` requires the author and
`q(n)=n` for `n<4`, otherwise `q(n)=n-floor((n-1)/3)`. Honest endpoints durably
lock and sign only the first valid gap-free Router-ordered successor for one
predecessor. Action signatures and durability votes are separate mergeable
signer maps; logical hashes exclude evidence maps. Honest durability voters
stage the canonical record core and sufficient action evidence before voting.
Any member may assemble a threshold certificate.

The cut is fresh-state and intentionally incompatible: protocol
`2026.827.1`, `moltzap/client/v2/*` hash domains, events-v2, and endpoint SQLite
schema 2. Old peers, prior event clients, and nonempty old stores fail closed;
there is no migration, alias, dual stack, feature flag, or automatic rollback.

The problem was that the former Client duplicated native OpenClaw/NanoClaw
session and messaging behavior, exposed caller-minted conversation/turn/reply
authority, required contention acknowledgments, fragmented cross-address
context, and did not give runtimes first-class fixed groups. The replacement
keeps opaque Router transport and endpoint-replicated, recoverable certified
history while moving presentation, memory, and intentional output back to the
native hosts.

Binding authority is `AGENTS.md` plus `v2/VISION.md`'s constitution, followed
by the accepted addressed-messaging ADR's `Decision Outcome`, the explicitly
retained portions of partially superseded ADRs, and the normative
`docs/spec/` headings named by the stable manifest. The ADR's context explains
the problem, and its consequences describe effects rather than creating a
second interface. Architecture pages are orientation or execution material.
The trajectory is source evidence only. Historical ADR bodies and the
pre-cutover implementation are not current contract authority.

Independently discovered paths and headings:

- `AGENTS.md` — Project, Decisions, Docs
- `v2/VISION.md` — Authority, The constitution, First executable profile
- `docs/decisions/README.md` — Canonical reading guidance, Records
- `docs/decisions/20260827-addressed-messaging-replaces-openfloor.md` —
  Context and Problem Statement, Decision Outcome, Consequences
- `docs/spec/README.md` — Authority and reading order, Addressed Client
  boundary
- `docs/spec/harness/client.md` — Service shape, Addressed send, Addressed
  inbound delivery

Per-question verdict: **PASS**. The current choice, problem, and authority
classes are explicit and independently discoverable.

### 2

The replacement is comprehensive for the former runtime messaging surface.
It replaces OpenFloorV1; START, BEGIN, ACK, and MULTICAST; unanimous ordinary
actions; caller-visible conversation identity; consumed turns and reply
grants; events-v1; bound reply and implicit current-conversation targets;
Client-built context/checkpoints; and the five Simulator contracts that
depended on content-free open, unaddressed send, message-only receive,
runtime Router authority, or persisted Router commit/order.

The decision index and visible Supersession sections consistently mark the
ConversationId/bound-reply Client ADR, production `HarnessClient` ADR, runtime
context ADR, grant-bearing notification ADR, model-output ADR, OpenFloorV1
ADR, old model-surface ADR, and grant-before-dispatch ADR as fully superseded.

The following scopes are retained:

- The partially superseded four-layer ADR retains the four-layer model,
  endpoint-replicated certified history, stage-before-vote durability,
  catch-up, Router re-anchor, recursive social features, daemon topology,
  seven-package graph, and cutover outcome.
- The partially superseded Client-protocol ADR retains Client ownership of
  closed representation, endpoint SQLite persistence, registration recovery,
  management isolation, verified catch-up, Router re-anchor, and exact daemon
  configuration.
- The endpoint-daemon ADR retains the pinned MCP core and official SDK,
  Streamable HTTP, one loopback listener, discovery, local subscription
  ownership/trust, acknowledgment ordering, and host-specific supervision
  where independent of profiles or Ledger.
- The in-band lifecycle ADR retains fixed-membership genesis with initial
  content and no control-plane create operation.
- The Simulator execution ADR retains `RunSpec`, `Run.execute`, the one
  Kubernetes execution path, runtime gateways, closed events, failure
  semantics, compatible public facades, and simulation `RunLedger`.

Identity/Registry and opaque Router representations, authentication, limits,
and retry/poll behavior remain untouched. One daemon per AgentId, explicit
daemon configuration, the seven-package dependency graph, endpoint durability
and recovery, and unrelated stable manifest rows also retain their existing
meaning. An unlisted manifest row retains its disposition.

The current normative contract lives in `AGENTS.md` and the constitution,
then the accepted addressed-messaging ADR plus only the explicit retained
scopes of partially superseded records. The single current manifest is
`docs/decisions/20260811-four-layer-endpoint-replicated-harness.md` under
`Gate 1 traceability disposition`; its changed rows point to exact headings in
`docs/spec/conversation-history.md`, `docs/spec/harness/{client,tasks,output,
ingress,channels,daemon}.md`, `docs/spec/management.md`, and
`docs/spec/layer-interfaces.md`. Historical bodies, handoffs, and code do not
override those owners.

Independently discovered paths and headings:

- `docs/decisions/README.md` — Canonical reading guidance, Records
- `docs/decisions/20260811-four-layer-endpoint-replicated-harness.md` —
  Supersession, Gate 1 traceability disposition
- `docs/decisions/20260813-client-protocol-and-attention.md` — Supersession
- `docs/decisions/20260812-harness-client-uses-conversation-id.md` —
  Supersession
- `docs/decisions/20260728-open-floor-v1.md` — Supersession
- `docs/decisions/20260728-endpoint-daemon-speaks-modern-mcp.md` —
  Supersession
- `docs/spec/README.md` — Gate 1 chapters

Per-question verdict: **PASS**. Status, supersession lineage, retained scope,
and normative ownership agree.

### 3

An implementer must replace the transitional Client with the exact addressed
`HarnessEndpoint` and keep all conversation protocol, hashes, certificates,
storage, catch-up, re-anchor, pending deliveries, and MCP representation
private to `@moltzap/client`. The implementation must use the closed schemas,
canonical preimages, nested signed evidence, fixed thresholds and limits,
first-candidate lock, stage-before-vote ordering, fresh-store preflight,
closed error unions, address-based management operations, events-v2
subscription, stable delivery replay, and native-host-before-ack ordering in
the normative chapters.

OpenClaw and NanoClaw must consume Client only, route all addresses through
one native session, use their durable native messaging path with an explicit
destination, and leave plain final output private. Simulator and evals must
use Client/daemon semantics, keep compatible Simulator facades and
`RunLedger`, remove the five incompatible contracts, and keep directed link
faults private and post-Router. Identity and Router move to their final package
homes without changing their owned bytes or semantics. Registry and Router
must not learn Client addresses, conversations, certificates, history,
delivery state, tasks, norms, trust, or policy. No Ledger, compatibility
package, profile, duplicate messaging/session layer, raw-runtime network
authority, implicit target, proof-shaped runtime result, or hidden shim may be
introduced.

The affected conceptual layers are Communication and Tasks/norms directly,
plus Personal trust at endpoint screening. Identity is used for name/card
resolution, authentication, and signatures but its trust domain is unchanged.
The affected products are Client, its daemon/MCP surface, OpenClaw,
NanoClaw, Simulator, and evals; Registry and Router remain independent
services with opaque boundaries.

The profile assumes one correct, non-equivocating Registry and one correct,
non-equivocating Router. Router may be unavailable or restart but does not
fork an accepted order within one instance. For `n>=4`, at most
`f=floor((n-1)/3)` fixed members may be Byzantine; the resulting completed
durability evidence proves at least `n-2f` honest staged replicas when honest
members stage before signing. For `n<4`, all members vote and the replicated
storage guarantee assumes zero Byzantine members. The small-group unanimity
does not prove a Byzantine signer retained bytes.

Safety is timing-independent. Quorum intersection plus the honest
first-candidate lock prevents conflicting completed successors under the
stated Router and endpoint assumptions. Invalid evidence is rejected before
mutation, missing ancestry blocks instead of selecting by arrival or hash,
and already certified local history remains readable through Registry/Router
outages. Personal trust remains local; endpoints may refuse to sign, accept,
disclose, or rely, and no network service supplies a trust verdict.

Progress requires Registry or cached cards as applicable, Router
availability, the selected author-inclusive action quorum, a durability
quorum, and an honest reachable source for missing ancestry. A withheld
selected candidate, unavailable member set, missing history, or unavailable
service may stall one conversation. There is no timeout replacement, view
change, fairness, or starvation-freedom claim. Router restart requires
verified head reconciliation and threshold re-anchor before new actions.

Compatibility is a hard cut: all participants use protocol `2026.827.1`,
Client hash domain v2, events-v2, and SQLite schema 2. Only an observably empty
version-0 store initializes; version 2 reopens; every old, mixed, or nonempty
legacy state fails closed without decoding, mutation, migration, erasure,
dual stack, feature flag, alias, or rollback automation.

Independently discovered paths and headings:

- `v2/VISION.md` — Trust, safety, and progress; Processes and persistence;
  Conversations and records; Local runtime surface; Packages
- `docs/spec/conversation-history.md` — Canonical encoding and preimages;
  Action validity and storage durability; Catch-up and Router restart;
  Persistence and compatibility
- `docs/spec/harness/tasks.md` — GENESIS, POST, Candidate selection,
  Durability
- `docs/spec/harness/ingress.md` — MCP extension, Durable acceptance
- `docs/spec/harness/channels.md` — One native session, Native messaging
- `docs/spec/layer-interfaces.md` — Exact package graph, Cross-layer laws,
  Simulator cutover

Per-question verdict: **PASS**. Required behavior, prohibitions, consumers,
and separate fault, trust, safety, liveness, and compatibility assumptions are
discoverable and consistent.

### 4

The accepted addressed-messaging ADR names one human decision-maker: Tapan
Chugh. The trajectory identifies Codex local-history session
`019fd899-779c-7e70-a8e4-338727b13e6c`; because that source has no native
message IDs, turn IDs, parent locators, or explicit role field, each event uses
the session, append-only local record line, exact UTC timestamp, and stored
kind/role `user input` with that limitation stated.

The retained events state only the following:

1. Event 1, line 2920 at `2026-08-27T18:57:37Z`, asks to restore
   cross-conversation context, add agent-created group chat, and have
   individual private calls with shared meetings. A near-identical line 2921
   copy is explicitly omitted.
2. Event 2, line 2922 at `19:27:10Z`, says to remove OpenFloorV1 now and that a
   projection can be added later.
3. Event 3, line 2924 at `19:55:09Z`, says to reduce debt by falling back to
   existing OpenClaw and NanoClaw code where possible.
4. Event 4, line 2925 at `20:41:17Z`, asks whether both hosts can route through
   one main session with only `agent:` and `group:`.
5. Event 5, line 2927 at `20:52:54Z`, rejects attendee-email form in favor of
   agent addresses and says not to send automatic notifications. Its omitted
   remainder asks how hosts present incoming messages.
6. Event 6, line 2930 at `21:29:13Z`, asks whether OpenClaw's message tool makes
   more sense and says direct reply feels strange. It does not establish the
   answer.
7. Event 7, line 2932 at `21:52:53Z`, says the native-messaging requirement is
   not understood and requires recipients to know a group message is a group.
   The explanation and later selection are absent.
8. Event 8, line 2929 at `21:17:54Z`, defers CoordBench migration to a later
   handoff, says backward compatibility is not a goal, rejects complicated
   rollback, and requests the named engineering guides.
9. Event 9, line 2936 at `22:21:49Z`, asks whether work is on the four-layer
   cutover branch. The agent answer is absent.
10. Event 10, line 2940 at `22:52:08Z`, says `Implement the plan.` The referenced
    plan is absent, so this does not establish its contents.
11. Event 11, line 2943 at `23:54:53Z`, says `ookay, that sounds good. proceed`.
    The preceding prompt is absent, so the ledger does not independently prove
    what that reply accepted.

The ledger preserves questions as questions. It records no recoverable source
event that independently proves a reversal or the missing option selections.
It expressly does not reconstruct the rationale for canonical sorting, the
ordinary-post threshold, detailed interface/wire shapes, native-messaging
selection, or retained evidence/hash treatment. It also omits intervening
agent explanations, structured-choice prompts/selections, the final plan,
the branch answer, parts of long submissions, and one duplicate, marking each
omission. The ledger says the named decision-maker must review the outcomes
directly when admitting the ADR; I make no claim about motive, confidence,
urgency, rationale, or omitted content.

Independently discovered paths and headings:

- `docs/decisions/20260827-addressed-messaging-replaces-openfloor.md` —
  frontmatter, Decision provenance
- `docs/decision-evidence/20260827-addressed-messaging-trajectory.md` — Source
  scope and gaps; Addressed messaging, groups, and shared meetings; Native
  messaging and group visibility; Compatibility, process, and downstream
  deferral

Per-question verdict: **PASS**. The human attribution, literal source events,
alternatives/questions/deferrals, omissions, and source limitations are
explicit; no rationale or missing selection must be inferred.

### 5

The strongest apparent contradiction is the executable pre-cutover tree:
`packages/client` still exposes `HarnessClient`, public `ConversationId`,
OpenFloorV1, START/reply, and events-v1, and current Simulator/adapters still
import those types. A broad reader could mistake that code for the current
contract. Several architecture slates also retain those terms in their
historical bodies.

The authority chain resolves this without a blocker to the decision gate.
`v2/VISION.md` under `Evidence and path` orders the isolated blind review
before Client and adapter implementation. `docs/spec/README.md` calls the
addressed slices ready, not already implemented.
`docs/spec/layer-interfaces.md` under `Relocation and deletion law` explicitly
requires wholesale replacement of the transitional Client and deletion of
the five old Simulator contracts. `docs/architecture/first-implementation.md`
then assigns that work to lanes 4 through 7. The older architecture slates
are visibly labeled historical, superseded, and non-normative at their tops.
Code and lower-order orientation therefore cannot override the constitution,
current ADR outcome, or normative specs. The mismatch is the documented input
state for the next implementation lanes, not broken decision lineage.

A narrower terminology tension is also resolvable. `v2/VISION.md`'s conceptual
`Vision` summary says members stage the exact record, while the binding
constitution and `docs/spec/conversation-history.md` under `Action validity
and storage durability` specify the operational invariant: durably stage the
canonical record core and sufficient action certificate, then atomically
promote the staged core and accumulated threshold votes into certified
history. The summary does not authorize staging less evidence. No current
source requires the obsolete evidence-bearing value itself to define
`RecordHash`.

No broken supersession edge was found. The decision index, frontmatter,
visible Supersession sections, current manifest, and manifest-owned spec
headings agree, and the repository ADR-shape check reports all 62 records
well formed.

Independently discovered paths and headings:

- `packages/client/src/harness-runtime.ts` — pre-cutover exported constants
  and types found by repository search
- `packages/client/src/endpoint/openfloor-types.ts` — pre-cutover protocol
  source found by repository search
- `v2/VISION.md` — Authority, Evidence and path
- `docs/spec/README.md` — Implementation readiness
- `docs/spec/layer-interfaces.md` — Relocation and deletion law
- `docs/architecture/first-implementation.md` — Lane 4: build Client
  communication; Lane 5: rewrite runtime adapters; Lane 6: rewire simulator
  and evals; Lane 7: remove the retired stack
- `docs/architecture/four-layer-interface-slate.md` — historical status notice

Per-question verdict: **PASS**. The strongest stale implementation and
orientation are conspicuous but explicitly staged for replacement under a
clear authority order; they do not create an unresolved contract conflict.

### 6

Yes. A teammate can implement the selected addressed-messaging cutover
without chat or guessing. The current manifest links every changed stable row
to an existing exact normative heading, and the specifications close the
public types, packet/certificate schemas, canonical encodings and hash
preimages, thresholds and resource limits, fault model, persistence preflight,
MCP events/tools, management schemas, host delivery ordering, package graph,
Simulator removals, error unions, and acceptance tests. The trajectory's
missing rationale and missing prompts are provenance gaps, not missing
implementation choices: the accepted ADR and specs state those outcomes
directly.

No accidental missing normative link or unresolved choice was found for the
selected profile. The following are deliberate deferrals or explicit
out-of-scope work and must not be guessed into this implementation:

- **Release and downstream cutover:** which products publish; coordinated
  versus independent package versions; npm/release/image/deployment and
  external-consumer cutover; a self-contained Simulator artifact; calendar
  implementation; and CoordBench migration.
- **Membership, history, and storage evolution:** dynamic, mutable, or named
  groups; multiple groups with one member set; invitations, contacts, add,
  remove, rename, or leave; pruning, garbage collection, retention after
  certification, and disk-loss recovery; alternate catch-up transports;
  public observers/history services and cross-history audit/disclosure
  conventions.
- **Stronger identity, network, and confidentiality profiles:** malicious or
  equivocating Registry tolerance; Registry/Router replication; persistent
  feeds, ordering consensus, fork detection, transparent failover, or
  per-recipient Router retention; key rotation, revocation, recovery,
  delegation, peer-card custody, encrypted keys/external signers; required
  end-to-end encryption/key distribution; and application TLS/trusted-proxy
  policy.
- **Richer protocol and liveness behavior:** executable user-provided norms,
  richer task/action vocabularies or mapping, configurable quorums, timeout
  replacement, view change, alternate-candidate election, pass, takeover,
  disputes, fairness/starvation freedom, signature aggregation, automatic
  semantic acknowledgment, and a separately specified transactional evidence
  outbox.
- **Larger or alternate transport/runtime profiles:** fragmentation, larger or
  negotiated resource limits, network push or alternate MCP delivery/cursors,
  asynchronous task handles, dynamic action tools, remote administration,
  local hostile-host defense/dynamic ports/attachment/universal supervision,
  and portable personal-trust conformance.
- **Institutional/governance vocabularies:** institution discovery, claim
  formats and revocation, monitor publication, appeals, consequences,
  governance protocols, and selective disclosure. Any future version remains
  an ordinary agent/task/norm/trust protocol, not privileged infrastructure.

Implementing any item in those groups requires later authority. Their absence
does not prevent the fixed addressed-post profile, hard compatibility cut, or
the currently specified package migration.

Independently discovered paths and headings:

- `v2/VISION.md` — Deliberate deferrals
- `docs/decisions/20260827-addressed-messaging-replaces-openfloor.md` — Fresh-
  state wire and store cut, Traceability disposition, Consequences
- `docs/decisions/20260811-four-layer-endpoint-replicated-harness.md` —
  Explicit deferrals and implementation boundary, Gate 1 traceability
  disposition
- `docs/spec/conversation-history.md` — Explicitly deferred
- `docs/spec/harness/tasks.md` — Explicitly deferred
- `docs/spec/router.md` — Explicitly deferred
- `docs/spec/identity.md` — Explicitly deferred
- `docs/spec/enforcement.md` — Explicitly deferred
- `docs/spec/layer-interfaces.md` — Deliberate deferrals

Per-question verdict: **PASS**. The selected profile is implementation-ready;
all unresolved choices found are visibly deliberate deferrals or downstream
scope exclusions rather than accidental gaps.

## Discovery trail

| Order | Entry point, search, or navigation step | Path and heading discovered | Result |
|---:|---|---|---|
| 1 | Verified `HEAD`, clean status, candidate object, timestamp, and candidate commit metadata | Candidate `441d80f8aca21a1009f4edfa5c891db8221115ac` | Exact clean candidate confirmed; commit changes staging terminology in `v2/VISION.md` and `docs/architecture/layers.md`. |
| 2 | Read repository instructions and the required local decision/documentation procedures | `AGENTS.md` — Decisions, Docs; `.claude/skills/decisions/SKILL.md`; provenance rules; blind questions | Established authority order, evidence rules, quarantine, and PASS standard. |
| 3 | Listed decision, spec, architecture, and evidence filenames | `docs/decisions/README.md`; current addressed ADR and trajectory paths | Quarantined review paths were visible only as names; none was opened or searched. |
| 4 | Followed the decision index's current-messaging entry | `docs/decisions/20260827-addressed-messaging-replaces-openfloor.md` | Found accepted outcome, provenance links, compatibility cut, and trace disposition. |
| 5 | Followed only the ADR's non-review provenance links | `docs/decision-evidence/20260827-addressed-messaging-trajectory.md` | Found Events 1–11 and explicit source gaps. |
| 6 | Followed the ADR's stable-manifest pointer | `docs/decisions/20260811-four-layer-endpoint-replicated-harness.md` — Supersession, Gate 1 traceability disposition | Found retained four-layer scope and exact current normative owners. |
| 7 | Read the constitution and manifest-owned normative chapters | `v2/VISION.md`; `docs/spec/README.md`; conversation-history and harness/layer chapters | Reconstructed exact interface, protocol, assumptions, compatibility, consumers, and deferrals. |
| 8 | Inspected visible Supersession sections of affected prior ADRs | `docs/decisions/*` — Supersession | Confirmed full and partial replacements agree with the index and manifest. |
| 9 | Searched non-quarantined architecture, specification, decision, and source trees for retired vocabulary | Historical architecture slates and transitional `packages/client`/Simulator sources | Found the strongest apparent stale contract and resolved it through the authority and execution order. |
| 10 | Ran the repository ADR shape and locator check | `scripts/docs/adr/check-shape.ts` | PASS: 62 records well formed; no broken ADR/provenance/index locator reported. |

## Author interventions

| Time | Intervention | Effect on review |
|---|---|---|
| none | none | none |

## Blockers

| ID | Finding | Evidence | Required reconciliation |
|---|---|---|---|
| none | none | none | none |

## Overall result

Result: **PASS**

All six answers are accurate and independently discoverable at the pinned
candidate. Status, supersession lineage, authority order, stable manifest,
normative ownership, fault and progress assumptions, compatibility boundary,
and source-event attribution are consistent. The strongest stale code and
orientation are explicitly identified as pre-implementation input under the
authority-first cutover sequence. The provenance ledger names its source gaps
without inviting inference, and no accidental implementation choice or broken
locator was found.

## Maintainer acceptance

The reviewer result is evidence, not self-certifying acceptance. The
maintainer verifies that it applies to the exact candidate identity above and
records the gate decision.

| Field | Value |
|---|---|
| Maintainer | pending |
| Reviewed result | `addressed-messaging-441d80f8-blind-review` |
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
| Reason a rerun was required | none |
