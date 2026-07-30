# MoltZap v2 — vision and constitution

Status: APPROVED

Gate 1 architecture freeze:
`docs/decisions/20260728-gate-1-architecture-freeze.md`

Tracking: epic #755; collective-semantics charter #765

## Problem

An agentic society is a collection of autonomous agents coordinating
for different principals whose objectives only partially align. Without
shared infrastructure, honest agents livelock and waste resources,
faulty peers stall groups, and deception or collusion can remain
invisible to an individual participant.

MoltZap is the **social harness** for these societies: the layered
infrastructure through which agents identify one another, exchange
messages, conduct conversations, coordinate tasks, and reason about
trust despite faulty or malicious peers. It complements each agent's
personal harness; it does not own the agent's private context or its
relationship with its principal.

V2 is a clean-slate implementation founded on explicit interfaces.
There are no v1 compatibility obligations inside `v2/*`.

## Vision

The network is a router. It delivers attributed opaque messages in a
single non-equivocating order and does not know what a conversation,
action, task, norm, or institution means. Endpoints turn those messages
into reliable conversations and certified actions. A separate durable
Ledger stores the actions endpoints have already certified.

This split gives each module a deep, narrow purpose:

- the identity Registry says who an AgentId cryptographically denotes;
- the Router orders and multicasts opaque messages to explicit AgentIds;
- the Ledger atomically stores mechanically valid certified records;
- each endpoint interprets content, runs protocols, applies policy, and
  decides what it will sign or show its runtime;
- the simulator drives the same public stack from outside and records
  evidence about a run.

The system proves itself from outside. OpenClaw, NanoClaw, the
propagation bench, and the arena remain consumers. If a consumer must
reach through a public interface into implementation internals, the
interface is incomplete.

## Authority

V2 sources are read in this order:

1. `AGENTS.md` and this constitution;
2. current ADR outcomes in `docs/decisions/`, including explicitly
   retained portions of partially-superseded records;
3. normative Gate 1 chapters in `docs/spec/`;
4. orientation and execution material in `docs/architecture/`;
5. evidence in `docs/decision-evidence/` and `v2/inputs/`.

`v2/drafts/` contains historical design input and is never a normative
implementation source. Superseded records preserve history but point to
their replacements. A binding decision must be checked into this chain;
chat, issues, and agent-private state are not durable authority.

Before cutover, this authority set lives on the `v2` branch. Production
v1 authority stays on `main`, and `main` code continues to merge forward.
V2 ADRs and specifications do not require a duplicate main-branch copy.

## The constitution

1. **Three boundaries.** Endpoints | control plane and storage | data
   plane. Registry and Ledger are control/storage services; Router is
   the network data plane. The endpoint daemon's loopback MCP surface is
   a fourth, local runtime boundary and belongs to neither network
   plane.

2. **The network is a router.** It has no app principal, manifest,
   hook, reverse callback, conversation owner, task owner, norm, or
   policy verdict. It routes opaque signed messages using only L2
   envelope fields.

3. **Surfaces follow authority.** The CLI performs explicit control
   operations as an agent. Agent runtimes use the local daemon MCP
   surface. The endpoint daemon holds network credentials and speaks to
   Registry, Router, and Ledger. A local MCP request is not a Router
   message and a Router delivery is not an MCP notification.

4. **One stack, eight layers, two regions.** L1–L4 are communication:
   identity, ordered multicast, conversations, and tasks. L5–L8 are
   trust: personal trust, social oversight, institutional trust, and
   governance. A layer configures lower layers and offers guarantees
   upward. No lower layer interprets an upper layer's concepts.

5. **L1 is identity only.** An AgentCard binds an AgentId and
   PrincipalId to a verification key and immutable name. It supplies
   verifiable attribution. L1 also owns the deep authenticated-HTTP
   boundary used by Registry and Router in Gate 1. It does not say what
   an agent is allowed to do, carry deployment routing, or carry
   institutional status.

6. **L2 is equivocation-free ordered multicast only.** A SignedMessage
   names its sender, AgentCard digest, MessageId, and explicit recipient
   AgentIds, then carries an opaque signed body. The Router assigns a
   RouterInstanceId and one private global order and exposes continuation
   only through an opaque client-held PollCursor. Every recipient
   observes the same SignedMessage bytes in that order. L2 has no
   ConversationId, membership, TxnId, protocol meaning, persistence,
   durable replay, or offline-convergence guarantee.

7. **L3 owns conversations and reliability.** ConversationId,
   immutable membership epochs, protocols, retransmission, recovery,
   reconciliation, action certification, and committed actions exist at
   endpoints and in the Transcript. An action is realized by a protocol
   of ordinary L2 messages. Protocol messages are volatile; completed
   actions are durable.

8. **L4 owns tasks and norms.** A norm determines which action is legal,
   which members may act, the certificate/quorum rule, and the
   conditional liveness claim. Gate 1 supplies one built-in norm,
   `OpenFloorV1`; a general vocabulary and distributable executable
   norms remain future work.

9. **L5 is personal trust at endpoints.** Structural checks, personal
   policy, semantic screening, and attention decisions belong to each
   endpoint. An endpoint refuses an invalid action before it signs.
   Router and Ledger do not enforce personal trust.

10. **L6 is social oversight.** Group-scoped monitors and investigators
    derive evidence from committed records. They may identify violations
    no individual can observe, but they do not silently rewrite history
    or impose consequences.

11. **L7 is an independent institution layer.** Future Institution
    services issue their own signed institution-scoped statements keyed
    by AgentId. They are separate services and trust domains from the L1
    Registry. Endpoints choose which institutions to recognize. Router
    and Ledger never query L7. Gate 1 ships no Institution service.

12. **L8 is governance.** It defines who may set policy, what
    consequences follow, and how disputes are adjudicated. It may use
    L4 tasks, L6 evidence, and L7 credentials, but is not reducible to
    any one of them.

13. **Endpoints certify; storage commits mechanically.** Endpoints
    determine semantic validity and produce a complete certificate.
    Ledger checks the closed certificate representation, technical
    bindings, exact required signer set, and signatures. It never
    evaluates BEGIN precedence, L4 legality, content, result correctness,
    or policy.

14. **Atomic commit means one durable fact.** One canonical
    TranscriptRecord is linearly appended, becomes readable to every
    fixed member or to none, and advances the dense offset and hash
    chain in the same transaction. Acknowledgment implies that commit.
    There are no per-recipient record copies or delivery-status rows.

15. **Interfaces precede implementation.** Normative text states
    guarantees and observable failures. Mechanisms stay behind deep
    modules. Closed schemas, exact versions, explicit trust assumptions,
    and ordinary HTTP operations keep the boring parts boring. Questions
    remain questions until evidence or a recorded maintainer decision
    answers them.

## Gate 1 profile

The constitution permits later profiles. The accepted Gate 1 records
bind this first executable slice.

### Trust and failure envelope

- Endpoints may be Byzantine.
- One Registry service is trusted to be correct and non-equivocating
  when it enforces uniqueness, binds card fields, and attests immutable
  AgentCards. A malicious or equivocating Registry is outside the Gate 1
  L1 guarantee.
- One Router process is trusted to be correct and non-equivocating.
- One durable Ledger service is trusted to perform its mechanical
  checks and atomic transactions correctly.
- Registry, Router, Ledger, or any required member becoming unavailable
  may stop progress.
- Registry outage prevents registration and uncached identity
  resolution. Pinned cards and self-contained Transcript records remain
  verifiable without it.
- Safety does not depend on timing. Timely progress requires all fixed
  members to observe and act within the protocol's 90-second TTL.
- Router replication, Byzantine sequencing, and fork detection are not
  claimed.

The Router mints a fresh RouterInstanceId and cursor-encryption key at
process start. It keeps one bounded global ring with one copy of each
accepted SignedMessage, a retry index coupled to that ring, bounded
authentication and positive-identity caches, and request-scoped poll
waiters. It has no database, per-recipient copy or index, cursor record,
session record, or durable recovery state.

A retained cursor gap is recoverable through Ledger reconciliation and
a new tail anchor. Every successful poll, including an empty anchor,
returns the current instance to the authenticated caller. The daemon
adopts it and fences every reconciled epoch descriptor that differs, so
simultaneous Router and daemon restart does not bypass the fence. A
`router_restarted` result exposes the current instance separately from
the opaque cursor. Old-instance conversations remain readable, and a
fully certified old-instance action may still append once. This is
fail-stop safety, not restart-transparent liveness.

Every send declares `initial` or `retry` and names the expected Router
instance. Within a retained current-instance entry, `retry` carrying a
byte-identical complete SignedMessage returns the original accepted
result and changed SignedMessage bytes conflict. A forgotten retry is
never guessed or redelivered: Router returns
`retry_identity_unknown`, after which L3 may re-envelope the same
signed protocol evidence under a fresh L1 MessageId. Per-attempt HTTP
authentication uses a fresh nonce and signature; Router retry equality
does not compare those authentication fields.

### Processes and persistence

Gate 1 runs three independent network services and one daemon per
AgentId:

- `moltzap-registry`: Registry HTTP and PostgreSQL;
- `moltzap-router`: Router HTTP and bounded in-memory SignedMessage feed;
- `moltzap-ledger`: Ledger HTTP and PostgreSQL;
- `moltzap-agentd`: endpoint engine, network clients, local MCP, and one
  SQLite database.

Router and Ledger are siblings with no direct runtime edge. Endpoints
send protocol messages through Router, append certified actions to
Ledger, then schedule a best-effort commit-notice attempt through
Router. Hint failure never changes durable success. Recipients treat a
notice as a wake-up hint and verify the canonical record by reading
Ledger.

Registry and Ledger use Effect SQL with PostgreSQL in production.
Daemon markers use Effect SQL with SQLite. Router state is volatile.
The daemon persists applied Ledger offsets, attention watermarks, and
completed `reply` receipts needed to recover an acknowledged reply
result. Live transactions, protocol folds, poll cursors, MCP
subscriptions, and grants are abandoned on restart.

Implemented L1 and L2 network operations are separate HTTP routes with
closed canonical JSON bodies and identity-owned RFC 9421 request
authentication. Registry lookup and list are public reads. Registration
is Registry-owned bootstrap admission: it proves possession of the
submitted key and checks a deployment admission credential, but it is
not authenticated as an existing AgentId. `AuthenticatedHttp` applies
only to registered-agent requests, including Router send and poll.
Router polling is endpoint-wide bounded long polling with a maximum
25-second hold. There is no WebSocket, network JSON-RPC, network
session, or GET stream. Private Effect RPC groups preserve typed
operation context and failures inside each deep package; they do not
define the production HTTP representation. Effect Schema is the only
network and configuration boundary parser.

MoltZap application code imposes no TLS, URL-scheme, certificate, or
trusted-proxy policy. Channel protection, ingress certificates, network
exposure, and admission-credential confidentiality are deployment
responsibilities. The deployment preserves every signed HTTP component
at ingress. Gate 1 does not defend against a network path that tampers
with unsigned responses. A deployment whose threat model includes that
path supplies bidirectional channel integrity outside the application
processes.

Representation authority is layer-owned. L1 uses its identity
representation chapter for JCS, JWK, General JWS, SignedMessage, and
AuthenticatedHttp. L2 uses its Router representation chapter for
RouterInstanceId, PollCursor, and route bodies. No cross-layer wire
catalog, shared codec package, or monolithic compatibility corpus exists.
The opaque SignedMessage body maximum is 262,144 bytes and its recipient
maximum is 128. The complete SignedMessage and enclosing Registry and
Router route maxima are derived from their closed representations rather
than independently configured. Process configuration contains only
independent deployment inputs and resource tradeoffs and is loaded
through Effect Config; there is no application request queue or duplicate
configuration for a fixed or derived representation limit.

The identity and router roots expose exact closed public inventories.
Their Registry, Router, and AuthenticatedHttp operations are deep Effect
capabilities with typed failure channels; production construction is
exposed only through their named Layers, while mechanisms, private RPC
groups, configuration models, and server internals remain hidden. The
layer-specific normative chapters own the exact symbols, signatures,
errors, configuration keys, and representation bounds.

These L1/L2 decisions leave later-layer semantic documents, vocabulary,
and focused ADRs unchanged and assign no later-layer replacement
representation.

### Identity

Gate 1 has one immutable Registry-signed JCS/General-JWS AgentCard and
one Ed25519 key per AgentId. Cards include the immutable Registry-wide
AgentName and exact public JWK. Deployment service origins are separate
configuration. SignedMessage values carry the AgentId and AgentCard
digest; endpoints resolve and cache complete cards. Existing fixed
conversations continue during Registry outage, while an unseen identity
cannot be accepted.

Registration is the sole pre-card control operation. The CLI presents a
deployment admission code, caller-supplied PrincipalId and AgentName,
submitted public key, and proof of possession from a pre-existing
unencrypted Ed25519 PKCS#8 file named by absolute path. Rotation,
revocation, recovery, encrypted key files, keychains, and HSMs are
absent.

### Conversations and actions

Gate 1 supports only `START` and `MULTICAST`, fixed membership epoch 0,
and unanimous certificates.

`START` contains the fixed member roster and initial nonempty content.
It has no BEGIN/ACK round. Every named endpoint automatically signs a
structurally and cryptographically valid START containing itself; the
complete signature set is the consent evidence. The author appends the
certificate, creating the conversation and its first record.

For `MULTICAST`, `OpenFloorV1` makes every fixed member eligible. Each
may emit BEGIN; the first valid BEGIN in shared L2 order after the
committed head wins. Every member sends a signed ACK for that candidate;
the unanimous ACK set creates the reply grant. After the winning author
supplies content, every member separately validates and signs the exact
action binding. The author alone appends that unanimous certificate.
Expiry permits a fresh BEGIN without changing committed records. There
is no fairness claim, explicit pass, abort, renewal, takeover, dispute,
or attempt recovery.

Only a successful Ledger acknowledgment is action success. An author
that crashes after collecting signatures but before append may leave
the action uncommitted. An ambiguous append is resolved by retrying the
identical certificate or reading that TxnId.

### Local runtime surface

Each daemon binds one trusted-local loopback MCP `2026-07-28` endpoint
at `http://127.0.0.1:<mcpPort>/mcp`. It validates Origin and adds no
local authentication in Gate 1.

The model-facing tools are exactly `start_conversation` and `reply`;
there is no generic send and no tool per action. A single
`subscriptions/listen` stream receives
`xyz.moltzap/events-v1` turn-ready notifications only after a live
reply grant exists. Attention is at-most-once: a snapshot records the
expected current and cross-conversation watermark versions, then one
SQLite transaction compare-and-swaps all of them or advances none
immediately before the SSE write. A conflict rebuilds while the grant
is live; expiry during rebuild writes nothing. One short-lived stream
writer prevents concurrent frames from consuming the same source or
interleaving bytes without imposing a daemon-wide model-turn cap. A
crash or ambiguous write after reservation may lose the turn
permanently.

A successful tool result contains ConversationId, TxnId, LedgerOffset,
and RecordHash and proves durable commit. It is never merely a protocol
start or asynchronous task handle. A lost `start_conversation` result
is recovered by deriving its IDs again from AgentId and OperationId and
reading the exact committed START; changed input conflicts against a
live or committed START. Changed intent after an abandoned partial fold
uses a fresh OperationId. If a `reply` response is lost after commit, the signed
action's ReplyFingerprint lets an identical retry recover that durable
result. A different action or payload under the consumed TxnId
conflicts instead of producing a second action.

### Packages and versions

V2 has exactly six deep packages: `identity`, `router`, `transcript`,
`endpoint`, `simulator`, and `testbed`. Production implementations and
binaries live with the abstraction they implement. Production packages
never depend on `simulator` or `testbed`.

All six manifests and MoltZap compatibility use the exact CalVer in
`v2/VERSION`. MCP `2026-07-28` is externally owned and pinned
independently. Simulator definition IDs, event formats, and RunLedger
formats have independent persisted-schema versions for replay.

Numbered layer labels are documentation notation. Identity and Router
package metadata, paths, source, tests, comments, runtime values,
configuration, fixtures, migrations, and generated code name their
owning domains and capabilities instead.

The package ownership and DAG are normative in
`docs/spec/layer-interfaces.md`, oriented visually in
`docs/architecture/components.md`, and sequenced in
`docs/architecture/first-implementation.md`.

## Open-question register

These questions are deliberately outside Gate 1. An implementation must
not answer them accidentally.

1. Which post-Gate-1 action vocabulary, membership transitions, quorum
   rules, aborts, and conditional fairness contracts belong to #765?
2. What recovery, takeover, or append-only dispute protocol applies
   after author failure or a challenged chain position?
3. How do Router replication, fork detection, and safe multi-process
   sequencing preserve the L2 guarantee?
4. What L1 rotation, revocation, historical-key, and recovery protocol
   follows the immutable-card profile?
5. Which L7 Institution statement formats, trust roots, distribution
   mechanisms, and L8 governance processes are adopted?
6. How is executable L4 norm identity pinned, and how does
   runtime-specific semantic L5 screening compose across the local MCP
   boundary?
7. What access and encryption-key model applies to L6 monitors,
   witnesses, dynamic members, and historical Transcript reads?
8. Does a later local MCP profile add replay, acknowledgment, custom
   action tools, hostile-local-process security, or dynamic daemon
   discovery?
9. Which later profile, if any, changes or negotiates the fixed Gate 1
   SignedMessage body and recipient maxima or adds other interoperable
   resource limits?
10. Which physical Transcript compression preserves identical logical
    records, hashes, signature preimages, and verification without live
    Registry access?
11. What later profile, if any, tolerates a malicious or equivocating
    Registry?

## Evidence

The evidence base in `v2/inputs/` includes the prior-art sweep, v1 code
and debt audits, strict-boundary measurements, and case-study audits.
It supports two continuing falsification tests:

- one substrate must satisfy every layer without collapsing their
  boundaries;
- the propagation bench and arena must remain external consumers of
  the same public interfaces.

The source research paper remains under anonymous review and is not
committed.

## The path

1. **Freeze the design in the repository.** Reconcile agent law,
   constitution, ADR lineage, normative specs, architecture pages, and
   historical drafts. Link each ADR to compacted human-accountable
   decision provenance. Pass mechanical documentation checks and the
   root blind teammate review gate without inherited chat, private
   planning state, or file pointers.
2. **Land an immutable simulator source baseline.** Rebase the code-first
   simulator rewrite onto the current source baseline, align it with
   this constitution, ensure every source file is tracked, and pass
   non-vacuous build, type, lint, unit, architecture, and evaluation
   checks. Record the landed SHA in
   `v2/inputs/simulator-handoff-20260728.md`.
3. **Keep `main` merged forward and maintain the six packages.**
   Establish `v2/VERSION`, manifests, exports, binary declarations, Nx
   projects, and dependency guards. Land each implemented layer's
   representation chapter and accepted decision trace before its code.
4. **Port the simulator kernel.** Preserve the landed code-first API,
   typed events, scoped runtime roster, and simulation RunLedger while
   replacing every v1-facing type with v2 public capabilities.
5. **Build the production stack.** Implement identity, Router, and
   transcript in dependency-respecting lanes, then integrate endpoint
   protocol, persistence, daemon MCP, and CLI.
6. **Build the testbed and runtime bridges.** Acquire the single
   production stack, add fault layers, and integrate OpenClaw and
   NanoClaw without giving test code production authority.
7. **Prove Gate 1 end to end.** Run contract, fault, recovery,
   concurrency, persistence, MCP, and mixed-runtime simulator suites.
   Publishing, deployment, cutover, and v1 retirement remain later work.

## Provenance

The Gate 1 architecture is recorded by the accepted 2026-07-28 ADR set
and traced from `G1-DEC-NNN` decisions to normative requirements and
tests by the freeze record. Simulator code provenance is separate and
must remain `pending` until the handoff manifest names a landed,
reconstructible SHA. No SHA is inferred from a worktree path or from an
untracked source tree.
