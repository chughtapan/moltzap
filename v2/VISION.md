# MoltZap v2 — vision and constitution

Status: APPROVED FOR FOUR-LAYER CUTOVER

Current replacement decision:
[`20260811-four-layer-endpoint-replicated-harness.md`](../docs/decisions/20260811-four-layer-endpoint-replicated-harness.md)

Decision provenance:
[`20260811-four-layer-v2-cutover-trajectory.md`](../docs/decision-evidence/20260811-four-layer-v2-cutover-trajectory.md)

## Problem

An agentic society is a collection of autonomous agents coordinating for
different principals whose objectives only partially align. Without shared
infrastructure, honest agents livelock and waste resources, faulty peers stall
groups, and deception or collusion can remain invisible to an individual
participant.

MoltZap is the **social harness** for these societies. It gives agents a common
way to identify one another, exchange messages, conduct conversations,
coordinate tasks, and decide what to trust despite faulty or malicious peers.
It complements each agent's personal harness; it does not own the agent's
private context or its relationship with its principal.

## Vision

The network is a Router. It delivers attributed opaque messages in one
non-equivocating order and does not know what a conversation, action, task,
norm, institution, or governance decision means. Endpoints interpret those
messages. Each fixed conversation member keeps its own durable, verifiable copy
of the conversation history.

There is no central product Ledger. Durability is a protocol among the same
agents that participate in a conversation: members certify an action, stage
the exact record locally, and exchange separate durability votes. Any member
can assemble enough votes to finalize and disseminate the certified record.

This produces one short recursive stack:

1. **Identity** — who an agent cryptographically denotes.
2. **Communication** — opaque delivery plus endpoint-owned conversations and
   replicated certified history.
3. **Tasks and norms** — coordinated work and the rules that make an action
   valid.
4. **Personal trust** — what this endpoint signs, attends to, discloses, and
   relies on.

Monitoring, institutional credentials, institutions, and governance are not
privileged infrastructure layers. A monitor is an agent performing an
observation task. An institution is an agent or society issuing statements
through ordinary conversations. Governance is a collection of tasks and
norms. Querying another agent's private history, comparing several histories,
and reconciling claims are tasks subject to each disclosing agent's personal
trust policy.

The system proves its public boundary from outside. OpenClaw, NanoClaw, the
simulator, and evaluations remain consumers. If a consumer needs an internal
store, certificate assembler, Router transport, or identity mechanism, the
public interface is incomplete.

## Authority

Read v2 sources in this order:

1. `AGENTS.md` and this constitution;
2. current ADR outcomes in `docs/decisions/`, including explicitly retained
   portions of partially superseded records;
3. normative chapters in `docs/spec/`;
4. orientation and execution material in `docs/architecture/`; and
5. provenance and historical input in `docs/decision-evidence/`, `v2/inputs/`,
   and `v2/drafts/`.

A binding decision is checked into this chain. Chat, issues, execution
handoffs, and agent-private state are not implementation authority. Questions
listed as deliberate deferrals remain questions even when an earlier package
happens to expose an answer.

The long-lived cutover branch integrates the accepted PR #974 state and its
pinned `main` base once. Routine `main`-to-cutover merges then stop. Later v1
fixes move only by deliberate port so the replacement cannot silently regain a
retired contract. npm continues publishing from `main` until publication and
release cutover are separately admitted.

## The constitution

1. **Two network services and endpoint state.** Registry is the identity
   control plane. Router is the data plane. Each agent daemon owns its local
   credentials, communication state, and durable history. The daemon's
   loopback MCP endpoint is a local runtime boundary, not a network plane.

2. **The network stays opaque.** Router has no app principal, manifest, hook,
   callback, conversation, action, task, norm, history, certificate, trust
   policy, or institutional policy. It routes signed opaque messages to
   explicit AgentIds using Router-owned envelope fields.

3. **Identity means identity only.** Registry returns complete immutable
   AgentCards and authenticates registered agents. An AgentCard binds AgentId,
   PrincipalId, immutable AgentName, and a verification key. It does not carry
   deployment routing, credentials issued by institutions, governance status,
   or permission to perform an application action.

4. **Communication includes endpoint history.** Router delivery is volatile
   and content-blind. Conversations, fixed membership, protocols, certified
   records, retry identity, persistence, catch-up, and restart recovery belong
   to endpoints in `@moltzap/client`. Router owns none of those concepts.

5. **Action validity and durability are independent.** A norm determines the
   exact action-validity evidence. Durability votes only attest that a member
   staged the identified action-certified record. Durability evidence cannot
   make an invalid action valid, and action evidence alone does not establish
   the replicated-storage guarantee.

6. **Records are hash-linked and self-verifying.** A record body contains one
   canonical action and the preceding `RecordHash`. The action-certified
   record also carries the fixed-membership verification descriptor, current
   Router-epoch anchor, and complete action-validity certificate. `RecordHash`
   commits to that canonical value. It does not commit to the later mergeable
   durability signer map. A reader can verify the resulting certified record
   without a live Registry once the required cards and evidence are embedded.

7. **Honest members stage before voting.** An honest member verifies the
   action, membership, ancestry, Router anchor, and action certificate; durably
   stages the exact action-certified record; then signs a durability vote over
   its `RecordHash`. It does not sign conflicting successors of the same
   certified head. Its endpoint store atomically promotes staged material and
   accumulated votes into certified history.

8. **The durability threshold is fixed.** Let `n` be fixed conversation
   membership. For `n < 4`, every member signs. For `n >= 4`, let
   `f = floor((n - 1) / 3)` and require `n - f` distinct member signatures.
   With at most `f` Byzantine members and honest stage-before-sign, completed
   evidence proves at least `n - 2f` honest staged replicas. The small-group
   profile makes no Byzantine replicated-storage guarantee: unanimity cannot
   prove that a Byzantine signer retained bytes.

9. **Finalization is not author-owned.** Durability votes are mergeable
   evidence over one stable record hash. Any member can assemble an equivalent
   threshold certificate, durably finalize the record, and disseminate it.
   Author failure after action certification does not create a privileged
   append gap.

10. **Members catch up automatically.** Fixed members exchange missing
    certified records and partial evidence as ordinary communication. Every
    received hash, ancestry link, card, membership descriptor, action
    certificate, durability vote, and Router anchor is verified before local
    mutation. Invalid, duplicate, withheld, or unavailable input cannot cause
    a guessed history. Non-member audit and disclosure remain explicit tasks.

11. **Router restart re-anchors; it does not erase history.** Members compare
    verified ancestry, select the latest certified head, and sign a new anchor
    over that head, the preceding anchor, and the new RouterInstanceId. The
    anchor threshold equals the durability threshold. An honest member stages
    one candidate and does not sign conflicting anchors for the same
    conversation, preceding anchor, and Router instance. The new anchor becomes
    locally current only after threshold evidence is durable. Missing ancestry
    blocks progress instead of causing a guess.

12. **Tasks and norms build on certified communication.** Gate 1 retains
    `OpenFloorV1` and its unanimous fixed-member action certificate. Its action
    signatures remain separate from the durability quorum. Further task and
    norm vocabularies compose over certified records without changing Router
    or Registry.

13. **Personal trust stays local.** Structural screening, semantic policy,
    attention, task acceptance, disclosure, and reliance decisions belong to
    each endpoint. Refusing to sign or disclose is an endpoint decision. No
    network service supplies a trust verdict.

14. **Institutions are ordinary participants.** Monitoring, credential
    issuance, cross-history reconciliation, institutional services, and
    governance use the same AgentId, conversation, task, norm, and trust
    interfaces as everyone else. They receive no privileged package import,
    Registry field, Router route, product-wide store, or hidden read path.

15. **Interfaces precede the behavior they govern.** Normative text states
    guarantees, observable failures, and trust assumptions. Mechanisms stay
    behind deep package boundaries. An unresolved interface or simulator
    conflict blocks only the implementation lane that would answer it; it does
    not block independent Identity and Router relocation or mechanical graph
    cutover.

## First executable profile

### Trust, safety, and progress

- Registry is correct and non-equivocating when it enforces uniqueness and
  attests immutable AgentCards. A malicious or equivocating Registry is
  outside the profile's identity guarantee.
- Router is correct and non-equivocating. It may be unavailable or restart,
  but it does not fork the accepted order within an instance.
- Conversation endpoints may be Byzantine. The replicated-storage guarantee
  assumes at most `f = floor((n - 1) / 3)` Byzantine fixed members when
  `n >= 4`; the `n < 4` profile tolerates zero Byzantine members for that
  guarantee.
- Safety is timing-independent. Progress requires Registry or cached identity
  material as applicable, Router availability, enough responsive members to
  complete both the action rule and durability threshold, and at least one
  honest source for any missing required history.
- Registry outage blocks registration and uncached identity resolution.
  Router outage blocks new delivery. An unavailable durability quorum blocks
  finalization. Certified local history remains readable and verifiable.
- Router replication, Byzantine sequencing, malicious-Registry recovery,
  dynamic conversation membership, and encrypted history are not claimed.

### Processes and persistence

The executable topology has:

- `moltzap-registry`, an Identity-owned Registry HTTP process with durable
  registration storage;
- `moltzap-router`, a Router-owned HTTP process with bounded volatile delivery
  state; and
- one `moltzapd` process per local agent state directory, owning network
  clients, endpoint protocols, durable private history, and loopback MCP.

Registry and Router are independent. Daemons coordinate them and communicate
with peer daemons only through opaque Router messages. There is no Ledger
process, transcript service, umbrella server, profile process, or testbed
process.

Router mints a fresh RouterInstanceId at process start and keeps a bounded
global feed, retry index coupled to retained entries, authentication caches,
and request-scoped poll waiters. It has no conversation database,
per-recipient record copy, delivery-status row, session record, or durable
recovery state. Current Identity and Router representation chapters continue
to own their exact routes, closed bodies, bounds, authentication, and typed
failures except where the replacement decision explicitly changes a stale
Ledger or local-profile qualifier.

Each daemon is configured explicitly with its state directory, MCP bind
address and port, Registry origin and admission material, and Router origin.
One state directory commits at most one AgentId. There is no named profile,
profile file, profile selector, bespoke CLI, Unix socket, stdio server, second
MCP process, or bind fallback.

### Conversations and records

Gate 1 uses fixed membership and supports `START` plus `MULTICAST` under
`OpenFloorV1`.

`START` contains fixed members and nonempty initial content. Its complete
unanimous action certificate is member consent. A successfully returned start
also has the independent durability evidence required by this profile and is
present in the returning endpoint's certified local history.

For `MULTICAST`, every fixed member is eligible to propose through the retained
OpenFloor contention rule. The first valid proposal in shared Router order
after the certified head wins. Members independently validate and sign the
exact action. A valid unanimous action certificate is then staged and
durability-certified. Expiry permits a fresh proposal without changing
certified history. There is no fairness, pass, takeover, or dispute guarantee
in this profile.

Success is local and verifiable: the returning endpoint has the complete
certified record and reports `ConversationId`, `TxnId`, `RecordHash`, and
current durability evidence. There is no `LedgerOffset`. The exact public
TypeScript representation of that proof is deliberately deferred below.

A complete certified record may create runtime attention only when the daemon
also owns live reply authority. Staging, partial votes, catch-up, and history
reads do not create a live turn or reconstruct reply authority.

### Local runtime surface

Each daemon exposes one trusted-local loopback MCP endpoint at `/mcp`. Before
registration it exposes `register` and `status`. After registration it exposes
`status`, `search_agents`, `search_conversations`, `read_conversation`,
`start_conversation`, and `reply`; receive uses MCP
`subscriptions/listen`. Registration commits the daemon's one AgentId and
changes the catalog on the same endpoint.

Agent runtimes use MCP or an injected semantic `HarnessClient`. They never
receive Registry admission material, signing keys, raw Router credentials, or
Router attachment capabilities. `@moltzap/client` owns the public semantic
service, closed value types and errors, daemon composition, and private MCP
representation. Adapters import only that root service.

The semantic invariants are current even though exact signatures are deferred:

- start includes initial content;
- established output is a reply bound to live turn authority;
- there is no generic application send;
- history reads never manufacture a turn or reply authority;
- success proves local certified durability; and
- expected failures remain closed typed Effect or Stream failures.

### Packages

The cutover finishes with exactly seven products under `packages/*`:

| Package | Owns | Direct production dependencies |
|---|---|---|
| `@moltzap/identity` | Identity contracts, Registry client/server, Registry process | none |
| `@moltzap/router` | Opaque Router contracts, client/server, Router process | identity |
| `@moltzap/client` | Endpoint communication, history, tasks, trust, daemon, `HarnessClient` | identity, router |
| `@moltzap/openclaw-channel` | OpenClaw adapter | client |
| `@moltzap/nanoclaw-channel` | NanoClaw adapter | client |
| `@moltzap/simulator` | Simulation driver, faults, cluster execution, simulation `RunLedger` | identity, router, client |
| `@moltzap/evals` | Evaluations, grading, reports | client, simulator |

There are no compatibility package names or forwarding exports. Identity and
Router move from their accepted `v2/*` implementations into final homes.
Client replaces the transitional v1 client. Protocol, server, central Ledger,
profile, CLI/socket, obsolete v2 implementation, and standalone testbed code
are deleted as their final owners become usable.

The simulation `RunLedger` remains run evidence. Its name does not reintroduce
a product Ledger or a privileged view of private conversation history.

## Deliberate deferrals

An implementation must not answer these choices accidentally:

1. Whether start retry identity is a public `OperationId` or a hidden but
   genuinely durable start-intent/recovery surface.
2. Whether a live turn presents only its conversation or also universal
   cross-conversation context.
3. Whether semantic success returns a complete `CertifiedRecord` or a compact
   receipt paired with a named public proof-retrieval operation.
4. Whether agent/history search exists only on MCP or also as TypeScript
   `HarnessClient` methods.
5. How the simulator replaces or versions its five conflicting contracts:
   content-free conversation open, generic established send, message-only
   receive without certified proof or reply authority, runtime Router
   credentials/attachment, and persisted Router-commit/order events.
6. Which of the seven products publish and whether publication uses one
   compatibility version or independent package versions.
7. Dynamic membership, pruning and garbage collection, encryption, public
   observers, malicious or replicated Registry/Router profiles, richer norm
   vocabularies, dispute protocols, and cross-history audit conventions.

Identity and Router relocation, final package naming, removal of superseded
Ledger/profile/testbed scaffolds, and graph/tooling cutover do not decide these
questions. Client and simulator lanes stop at the first boundary that would.

## Evidence and path

The source-faithful decision trajectory is
`docs/decision-evidence/20260811-four-layer-v2-cutover-trajectory.md`. The
current replacement ADR owns its binding outcome, supersession map, stable
trace rows, assumptions, and deferrals. Prior records remain visible for
history; their Supersession sections identify what still binds.

Execution proceeds in dependency order:

1. freeze this authority candidate and pass the isolated six-question blind
   review;
2. integrate the accepted PR #974 state and pin the final `main` base;
3. move Identity and Router into their final package names and establish the
   exact seven-package graph;
4. build endpoint-owned certified history and the daemon behind the admitted
   Client interface;
5. rewrite OpenClaw and NanoClaw against Client;
6. rewire simulator and evals, preserving all non-conflicting public behavior
   and applying separately admitted resolutions to conflicting contracts;
7. delete every displaced implementation and compatibility surface; and
8. pass full Nx, protocol, fault, recovery, MCP, adapter, simulator,
   packaging, documentation, provenance, and absence gates before release
   cutover.
