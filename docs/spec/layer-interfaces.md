# Layer interfaces and package capabilities

Status: **Gate 1 normative**

## Purpose

This chapter assigns each public type and capability to one deep
package. It prevents a mechanism, test substitute, or higher-layer
concept from leaking through the stack.

The six packages are the complete v2 package set. A new package
requires a recorded architecture decision.

L3 owns conversations, live-attempt message retry and evidence
deduplication, reconciliation, recovery, action certification, and
durable Transcript state. None of those duties move into L2 merely
because their evidence is carried by Router.

## Package graph

| Package | May depend on | Owns |
|---|---|---|
| `identity` | none | L1 identities and representation, AuthenticatedHttp, Registry client and production server |
| `router` | `identity` | L2 Router contracts and representation, Router client and production server |
| `transcript` | `identity`, public `router` contracts | L3 ConversationId, TxnId, MembershipEpoch, action certificate, TranscriptRecord, Ledger client and production server |
| `harness` | `identity`, `router`, `transcript` | interpretive protocol engine, OpenFloorV1 composition, local recovery state, HarnessClient, daemon MCP, `moltzapd` |
| `simulator` | public `identity` and `harness` capabilities | portable run kernel, runtime roster, EventCatalog, run-evidence RunLedger, public StackProvider contract |
| `testbed` | all five | StackProvider Live Layer, platform/resource acquisition and process supervision, public-capability substitutes, fault layers, external-process runtime constructors, black-box subjects |

Production packages never depend on `simulator` or `testbed`.
`simulator` and `testbed` never become alternate production services.
Nothing under `v2/*` imports `packages/*`.

There are no separate `wire`, `protocol`, `endpoint`, `endpoint-core`,
`daemon-api`, `cli`, `harness-adapter`, or `conformance` packages. Those
concerns are private implementation details or tests of the owning
abstraction.

## Public exports and binaries

| Package | Export map | Production executables |
|---|---|---|
| `identity` | `.`, `./registry`, `./registry/server` | `moltzap-registry` |
| `router` | `.`, `./server` | `moltzap-router` |
| `transcript` | `.`, `./server` | `moltzap-ledger` |
| `harness` | `.`, `./server` | `moltzapd` |
| `simulator` | `.`, `./adapter`, `./ledger` | none |
| `testbed` | `.` | none |

The root export contains the package's shared stable contracts and client
capabilities. Identity places Registry-owned contracts and its client
capability under `./registry`. A server subpath exposes production composition
and the executable boundary, not repositories, database rows, HTTP handlers,
or internal protocol state machines.

## Version contract

`v2/VERSION` is the sole MoltZap compatibility value. All six package
manifests and every MoltZap-owned network schema match it exactly.
There is no range negotiation or per-layer version.

The following are independent:

- MCP revision `2026-07-28`;
- simulator definition ID;
- EventCatalog schema version;
- RunLedger storage version.

Changing one independent persisted schema does not silently change
another.

## L1 and L2 representation ownership

`identity-representation.md` owns the exact L1 refined values,
AgentCard, SignedMessage, AuthenticatedHttp, and Registry
representations. `router-representation.md` owns the exact L2 refined
values, PollCursor, and Router request and result representations.

There is no cross-layer wire catalog, codec package, or shared
compatibility corpus for L1/L2. Harness owns a separate local MCP
presentation; it does not turn Registry, Router, or Ledger operations
into one shared network wire.

## Type ownership

### Identity

`identity` owns:

- AgentId, PrincipalId, AgentName, OperationId, and MessageId;
- AgentCard, AgentCardDigest, and Ed25519 public-key identity;
- SignedMessage attribution and verification;
- the registered-agent AuthenticatedHttp profile;
- Registry-owned bootstrap admission and submitted-key
  proof-of-possession; and
- Registry operation contracts.

Other packages import these types; they do not redeclare same-shaped
aliases.

### Router

`router` owns:

- RouterInstanceId and SignedMessageDigest;
- opaque PollCursor; and
- Router send and poll results, including `feed_gap`,
  `router_restarted`, and `retry_identity_unknown`.

Router's global order is private. Router owns no ConversationId,
membership, delivery wrapper, or public sequence type.

### Transcript

`transcript` owns:

- `ConversationId`, `MembershipEpoch`, `TxnId`;
- `LedgerOffset` and `RecordHash`;
- START and MULTICAST action bindings;
- complete epoch verification descriptor and action certificate;
- TranscriptRecord and Ledger operation schemas.

`PollCursor` and `LedgerOffset` remain distinct branded schemas with no
implicit conversion.

### Harness

`harness` owns:

- private named local profile configuration used to construct daemon and
  client Layers;
- the public `HarnessClient` consumer capability and its local context
  checkpoints;
- legal-action descriptor and closed reply selection;
- daemon discovery, tools, subscription, and backing-specific inbound
  notification schemas;
- retained backing-specific raw tool results and error tags; and
- the one profile-slot `moltzapd` process boundary.

Harness does not redeclare existing AgentId, AgentName, ConversationId, or any
backing-owned conversation domain value. It has no bespoke CLI, Unix RPC
socket, generic established-conversation send, or public provider-correlation
type. The exact conversation-search result projection remains with its owning
domain contract, as does the exact agent-search result projection. Missing
management Schemas and portable `HarnessClient` errors remain unassigned.

Live grants, protocol folds, BEGIN/ACK state, and transaction lifecycle
methods are private. There is no public `begin`, `update`, `commit`, or
`abort` capability.

### Simulator and testbed

`simulator` owns immutable simulator definition and evidence types plus
the public `StackProvider` contract exported from its root. Its
`RunLedger` is always named “run evidence” and is never assignable to
TranscriptRecord or LedgerOffset.

`testbed` supplies the production Live Layer for that simulator-owned
contract and implements its platform capabilities, including
production-process acquisition and supervision, public-capability
substitutes, and fault controls. Focused simulator tests may also
supply private fake Layers. Testbed does not redeclare the contract or
export a second Router, Ledger, or Harness implementation as a
production alternative.

## Public capability behavior

### Registry client

Offers registration, lookup, and list operations from `identity.md`.
Callers receive complete domain values, never raw HTTP responses or
database rows. The client is configured with the deployment Registry
origin and deployment-pinned Registry signer public key. Registration
also receives the redacted admission credential and bootstrap signing
authority for the submitted key at its call boundary. Public lookup and
list require no call-boundary admission credential or signing
authority. The client verifies every returned AgentCard
before constructing the nominal verified value.

Registration verifies that the returned PrincipalId, AgentName, and
agent public key equal the submitted bindings. Lookup verifies that a
found card equals the requested AgentId or AgentName. List verifies
every card, strict AgentId ordering, uniqueness, and the requested
lower bound. A valid Registry signature on a response-bound wrong card
is rejected rather than returned.

Closed registration and lookup outcomes remain values in the success
channel. Envelope and declared server failures propagate in the
client's typed Effect error channel. A client-side connection or
timeout failure is a distinct typed transport error, never an
unstructured substitute for a server failure. A malformed response, an
invalid status/body pairing, or a response that fails the required
Registry signature, request binding, or AgentCard verification is a
distinct typed client response error.

### Router client

Offers send and bounded poll from `router.md`. The client owns request
authentication and the Router representation without exposing its
mechanisms. It is configured with the Router origin; each send and poll
receives the caller AgentId and normal signing authority at its call
boundary. Send carries expected RouterInstanceId plus `initial` or
`retry`. Every successful poll contains current RouterInstanceId,
complete encoded, untrusted SignedMessage representations, and the next
PollCursor. Harness verifies each representation through L1 before
accepting the returned cursor.

Closed send and poll outcomes remain values in the success channel.
Envelope and declared server failures propagate in the client's typed
Effect error channel. Client-only connection and timeout failures stay
distinct from those server failures. A malformed response, invalid
status/body pairing, or failed response-schema validation is a
distinct typed client response error.

### Identity and Router construction handoffs

The exact identity and Router public exports, operation signatures,
per-method error channels, server surfaces, and configuration keys live
in their owning semantic chapters. The cross-package construction rules
are:

- Registry, Router, and AuthenticatedHttp are `Context.Tag` deep
  capabilities whose named operations are static Effect accessors;
- the Registry and Router client Layers require Effect's
  `HttpClient.HttpClient` and expose no public client class, options
  type, or mechanism-shaped factory;
- AuthenticatedHttp's Layer requires Registry so a Router process can
  resolve and positively cache immutable AgentCards without importing
  Registry internals;
- registration does not require AuthenticatedHttp: Registry privately
  composes bootstrap admission, submitted-key proof, and durable replay
  protection before its handler;
- each server subpath exposes one constant discard Layer that reads its
  private Effect Config and owns process composition; and
- Registry's `register`, `lookup`, and `list` group and Router's `send`
  and `poll` group use private Effect RPC without exposing an RPC group,
  middleware tag, serializer, `/rpc` route, or network RPC protocol.

Every production HTTP boundary still decodes its complete exact
representation through Effect Schema. Private RPC middleware may carry
verified admission or registered-agent context to the handler, but it
cannot replace or weaken the layer-owned network Schema.

### Ledger client

Offers append, read-forward, and conversation-list reconciliation from
`control-plane.md`. Append success is a durability acknowledgment, not
an accepted-but-pending state.

### Harness daemon and client

Composes Registry, Router, Ledger, signing, local persistence, and
protocol policy behind the local MCP contract. A runtime does not
receive network clients or transaction internals. `HarnessClient` owns
runtime context and local checkpoints and presents the selected semantic turn
shape. Exact Effect signatures remain owner work, and payload-only reply for
plural legal actions waits for its OpenFloor/task mapping.

### StackProvider

Simulator obtains one complete system under test through the
`StackProvider` capability it owns and exports at the simulator root. A
testbed Live Layer launches real Registry, Router, Ledger, daemons,
and runtime bridges; a focused simulator test Layer may use
public-capability fakes.

The provider is an outward composition boundary. Production code does
not import the simulator. Runtime subjects acquired through either Layer
receive the public `HarnessClient` capability, never Router, Ledger, database,
key, daemon, profile configuration, or platform internals.

## Cross-layer laws

### Trust, safety, and progress

1. Gate 1 assumes one correct non-equivocating Registry, one correct
   non-equivocating Router, and one correct durable Ledger; endpoints may be
   Byzantine. A malicious or equivocating Registry is outside
   the L1 identity-binding guarantee.
2. Registry outage blocks registration and uncached identity resolution
   but not verification from pinned cards or self-contained records.
   Router or Ledger unavailability may halt progress without weakening
   ordering or committed-state safety.
3. Unanimity means one honest required member whose endpoint-local Harness
   refuses a proposal prevents certification. If every required member signs
   an illegal proposal, semantic validity is outside the guarantee.

### L1 attribution

1. One SignedMessage names one sender and explicit recipients.
2. Verification covers addressing and opaque body.
3. Router cannot mint or repair attribution.

### L2 order

1. One successful send creates one private position and identical
   SignedMessage bytes for all recipients.
2. Router never requires ConversationId or membership.
3. PollCursor is volatile and instance-bound; L2 promises no replay.
4. No public result, record, or identifier exposes the private order.

### L3 certification and commit

1. Endpoints decide action validity and produce the complete certificate
   through their local Harness subsystems.
2. Ledger admission is mechanical and never evaluates policy.
3. Append acknowledgment implies one canonical record is durable and
   readable to every fixed member.
4. The author alone may append in Gate 1.
5. RouterInstanceId is bound into L3 protocol evidence, the epoch
   descriptor, the final action binding, and TranscriptRecord.
6. Author failure after final signature collection may leave the action
   uncommitted; Gate 1 has no takeover.

### Recovery

1. While one attempt is live, Harness retries required protocol sends
   and deduplicate identical signed L3 evidence. Retrying evidence never
   creates an additional grant, signature, or committed action.
2. Daemon restart or `feed_gap` abandons partial coordination. After
   Ledger reconciliation on the same Router instance, a fresh attempt
   uses a fresh TxnId from the committed head and re-anchors at Router
   tail. This fresh-Txn rule applies to established-conversation
   OpenFloor attempts. A retried `start_conversation` instead reuses its
   deterministic OperationId-derived genesis TxnId so a partial or
   committed START can converge on one result.
3. `router_restarted` abandons volatile work and fences old-instance
   conversations from new actions rather than starting a replacement
   transaction in them.
4. A fully certified old-instance action may append exactly once.
5. Only completed Transcript actions are durable and exactly
   recoverable; BEGIN, ACK, grants, partial signatures, and other
   partial coordination are volatile.
6. Periodic conversation-list and read-forward reconciliation recovers
   missing commit hints.
7. If Router has forgotten a send retry identity,
   `retry_identity_unknown` causes Harness to wrap the same signed
   L3 evidence in a fresh SignedMessage with a fresh MessageId and send
   it as
   `initial`. Recipients deduplicate the inner evidence; Harness
   does not create new protocol evidence.

### Retry identity

1. Registration retry identity is submitted-key JWK thumbprint plus
   OperationId.
2. Other control mutations use caller AgentId plus OperationId.
3. Router send uses caller AgentId plus MessageId within one expected
   Router instance and one retained ring entry. A retained
   byte-identical retry returns the original accepted result, changed
   bytes conflict, and an absent entry returns
   `retry_identity_unknown`.
4. Ledger append uses ConversationId, epoch, and TxnId.
5. Direct `reply` retry uses TxnId plus the canonical actionId/payload
   fingerprint. After commit, identical bytes recover the durable result and
   changed bytes conflict.
6. Equality projection is owner-specific. Registration compares its
   canonical inner request. Router `retry` compares the complete
   SignedMessage. Both exclude fresh per-attempt RFC 9421
   created/expires/nonce/signature metadata. Other owners define their
   own projection and result behavior; there is no cross-layer generic
   equality rule.

### Harness inbound context and reply authority

1. Content and reply authority are independent inbound facts. Once the
   backing-specific method and Schema are admitted, content-only notifications
   update client context and never invoke a runtime.
2. `HarnessClient` groups complete records by ConversationId and owns local
   presentation checkpoints for current and source conversations.
3. Immediately before runtime emission, the client advances the checkpoints
   for exactly the selected complete context. This transition is
   not an SSE-write acknowledgment or daemon attention watermark. A crash
   after advancement but before runtime receipt can lose that context.
4. A history read rebuilds content from saved checkpoints. Reading alone does
   not advance or repair presentation checkpoints and never creates, extends,
   consumes, or recovers a reply grant.
5. The clean-slate Harness retains at most one live reply authority for one
   ConversationId. The matching production exclusion and independent-progress
   target remains `main`-owned.
6. One scoped `HarnessClient` owns one active inbound subscription. A failed
   or ambiguous notification write may lose a transient grant and never
   causes replay or a fabricated closure.

### Dependency isolation

1. A package imports only the dependencies in the graph above.
2. No production binary depends on simulator or testbed.
3. External v1 consumers may point toward public v2 interfaces during
   transition; no edge points back from v2.

## Error boundaries

- Boundary decoders return closed typed failures; they do not expose
  decoder internals as stable protocol taxonomy.
- HTTP services distinguish authentication, version, schema,
  idempotency, `retry_identity_unknown`, cursor, Router restart,
  stale-head, refusal, and unavailability only where the owning spec
  defines observable recovery.
- MCP protocol errors are reserved for malformed MCP requests.
  A backing's already accepted raw tool-domain errors remain its stable set;
  this chapter does not assign a portable HarnessClient or management error
  taxonomy.
- Infrastructure and SQL errors remain internal unless translated at
  an owning public boundary.

## Effect realization

This section is non-normative implementation guidance.

- Define cohesive services and compose implementations with Effect
  Layers at process, subsystem, simulator, and test boundaries.
- Hide construction dependencies with local layer composition; provide
  the completed graph once at the runtime boundary.
- Use scoped acquisition for listeners, pools, daemons, child
  processes, subscriptions, runtimes, and teardown.
- Avoid a public service method plus a second exported pass-through
  function for the same operation.
- Model reusable boundary values with named Effect Schemas, branded IDs,
  tagged variants, and schema transformations rather than unsafe casts
  or duplicated wire/domain types.
- Use native Effect HTTP and SQL capabilities at implementation edges.
  Domain workflows depend on narrow capabilities, not raw clients.
- Tests use explicit shared or isolated test layers and
  `@effect/vitest`; they do not build ad hoc runtimes inside each test.

## Acceptance criteria

- Static dependency fixtures fail for every forbidden package edge.
- Export-map tests prove the exact entries above and no internal
  subpath.
- Public API and type canaries prove the exact identity and Router root
  inventories, operation signatures, error channels, and construction
  requirements assigned by their semantic chapters.
- Construction tests prove that Router composes the identity-owned
  registered-agent capability while Registry bootstrap admission does
  not require it.
- Private-RPC integration tests prove middleware short-circuiting,
  context propagation, typed server-to-client failures, interruption,
  and the absence of an RPC network route or exported RPC surface.
- Process tests supply Effect Config providers directly and prove that
  no public configuration type or direct environment parser is part of
  either package boundary.
- Manifest and wire values all equal `v2/VERSION`; independent schema
  versions demonstrably do not.
- Type canaries reject PollCursor/LedgerOffset and
  RunLedger/Transcript interchange.
- No public Router API exposes a global sequence or delivery wrapper.
- No cross-layer L1/L2 representation package, catalog, or corpus
  exists.
- Numbered layer notation appears only in documentation, never in v2
  implementation artifacts.
- A fake public-capability stack and the real production stack drive
  the same simulator definition.
- The simulator root owns one StackProvider type; testbed and fake
  Layers both satisfy that exact type without redeclaration.
- No runtime bridge can call a transaction verb or bypass `reply`.

## Decisions

- `../decisions/20260723-eight-layer-stack.md`
- `../decisions/20260728-layer-boundaries-and-fault-model.md`
- `../decisions/20260728-six-deep-packages-one-version.md`
- `../decisions/20260728-simulator-is-the-system-driver.md`
- `../decisions/20260729-representations-are-layer-owned.md`
- `../decisions/20260729-registration-is-registry-bootstrap-admission.md`
- `../decisions/20260729-identity-and-router-expose-deep-effect-capabilities.md`
- `../decisions/20260729-representation-limits-are-fixed-or-derived.md`
- `../decisions/20260729-router-order-is-opaque.md`
- `../decisions/20260801-harness-is-one-profile-slot-daemon.md`
- `../decisions/20260801-harness-client-owns-runtime-context.md`
- `../decisions/20260801-inbound-notifications-separate-content-from-grants.md`
- `../decisions/20260801-model-output-is-start-or-bound-reply.md`
