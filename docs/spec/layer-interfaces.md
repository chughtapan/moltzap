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
| `identity` | none | L1 IDs, AgentCard, attribution/authentication schemas, Registry client and production server |
| `transport` | `identity` | L2 Message, Delivery, PollCursor, Router client and production server |
| `transcript` | `identity`, public transport contracts | L3 ConversationId, TxnId, MembershipEpoch, action certificate, TranscriptRecord, Ledger client and production server |
| `endpoint` | `identity`, `transport`, `transcript` | protocol engine, OpenFloorV1 composition, local recovery state, MCP schemas/server/client, CLI |
| `simulator` | public identity and endpoint capabilities | portable run kernel, runtime roster, EventCatalog, run-evidence RunLedger, public StackProvider contract |
| `testbed` | all five | StackProvider Live Layer, platform/resource acquisition and process supervision, public-capability substitutes, fault layers, external-process runtime constructors, black-box subjects |

Production packages never depend on `simulator` or `testbed`.
`simulator` and `testbed` never become alternate production services.
Nothing under `v2/*` imports `packages/*`.

There are no separate `wire`, `protocol`, `endpoint-core`,
`daemon-api`, CLI, harness-adapter, or conformance packages. Those
concerns are private implementation details or tests of the owning
abstraction.

## Public exports and binaries

| Package | Export map | Production executables |
|---|---|---|
| `identity` | `.`, `./server` | `moltzap-directory` |
| `transport` | `.`, `./server` | `moltzap-router` |
| `transcript` | `.`, `./server` | `moltzap-ledger` |
| `endpoint` | `.`, `./server` | `moltzap-agentd`, `moltzap` |
| `simulator` | `.`, `./adapter`, `./ledger` | none |
| `testbed` | `.` | none |

The root export contains the package's stable contracts and client
capabilities. `./server` exposes production composition and the
executable boundary, not repositories, database rows, HTTP handlers,
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

## Type ownership

### Identity

`identity` owns:

- `AgentId`, `PrincipalId`, `AgentName`, `OperationId`, and
  `MessageId`;
- AgentCard and thumbprint;
- deterministic L1 message and COSE profile;
- normal and bootstrap RFC 9421 profiles;
- Registry operation schemas.

Other packages import these types; they do not redeclare same-shaped
aliases.

### Transport

`transport` owns:

- explicit-recipient attributed Message;
- `RouterInstanceId`, global `RouterSequence`, and Delivery;
- opaque `PollCursor`;
- Router send/poll results, including `feed_gap` and
  `router_restarted`.

Transport owns no ConversationId or membership type.

### Transcript

`transcript` owns:

- `ConversationId`, `MembershipEpoch`, `TxnId`;
- `LedgerOffset` and `RecordHash`;
- START and MULTICAST action bindings;
- complete epoch verification descriptor and action certificate;
- TranscriptRecord and Ledger operation schemas.

`PollCursor` and `LedgerOffset` remain distinct branded schemas with no
implicit conversion.

### Endpoint

`endpoint` owns:

- named local profile and `EndpointProfileRef`;
- legal-action descriptor and closed reply selection;
- daemon discovery, tools, subscription, and turn-notification schemas;
- facade tool results and error tags;
- public runnable daemon and CLI boundaries.

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
export a second Router, Ledger, or endpoint implementation as a
production alternative.

## Public capability behavior

### Registry client

Offers register, lookup, and list operations from `identity.md`.
Callers receive complete domain values, never raw HTTP responses or
database rows.

### Router client

Offers send and bounded poll from `data-plane.md`. The client owns
request authentication and deterministic encoding. Send carries an
expected RouterInstanceId plus `initial` or `retry` semantics. Every
successful poll contains the current RouterInstanceId, a complete
batch, and the next PollCursor; a closed cursor failure that reports
`router_restarted` also exposes the current instance.

### Ledger client

Offers append, read-forward, and conversation-list reconciliation from
`control-plane.md`. Append success is a durability acknowledgment, not
an accepted-but-pending state.

### Endpoint daemon

Composes Registry, Router, Ledger, signing, local persistence, and
protocol policy behind the local MCP contract. A runtime does not
receive network clients or transaction internals.

### StackProvider

Simulator obtains one complete system under test through the
`StackProvider` capability it owns and exports at the simulator root. A
testbed Live Layer launches real Directory, Router, Ledger, daemons,
and runtime bridges; a focused simulator test Layer may use
public-capability fakes.

The provider is an outward composition boundary. Production code does
not import the simulator. Runtime subjects acquired through either
Layer receive only an `EndpointProfileRef`, never Router, Ledger,
database, key, daemon, or platform internals.

### Distributed society execution

The accepted post-Gate-1 distributed execution contract is normative in
[`distributed-society-execution.md`](/spec/distributed-society-execution).
Portable definitions and the private run kernel remain in `simulator`.
Scheduler selection, cohort acquisition, workload attestation, external
runtime bootstrap, orchestration clients, and cleanup remain `testbed`
mechanisms supplied through Layers.

Distributed acquisition is phased behind the same `StackProvider` boundary:
testbed first acquires the Registry, Router, and Ledger core, then roster
resolution fixes the AgentIds, and cohort acquisition completes the stack with
one daemon and runtime bridge per AgentId. The portable simulator does not
receive Kubernetes or orchestration mechanisms from either phase.

No scheduler operation becomes a Router operation. No distributed controller
becomes an umbrella production server. The exact six-package, export, and
binary tables above remain unchanged.

## Cross-layer laws

### Trust, safety, and progress

1. Gate 1 assumes one correct non-equivocating Registry, one correct
   non-equivocating Router, and one correct durable Ledger; endpoints
   may be Byzantine. A malicious or equivocating Registry is outside
   the L1 identity-binding guarantee.
2. Registry outage blocks registration and uncached identity resolution
   but not verification from pinned cards or self-contained records.
   Router or Ledger unavailability may halt progress without weakening
   ordering or committed-state safety.
3. Unanimity means one honest required endpoint that refuses a proposal
   prevents certification. If every required member signs an illegal
   proposal, semantic validity is outside the guarantee.

### L1 attribution

1. One attributed message names one sender and explicit recipients.
2. Verification covers addressing and opaque body.
3. Router cannot mint or repair attribution.

### L2 order

1. One successful send produces one instance/sequence and identical
   bytes for all recipients.
2. Router never requires ConversationId or membership.
3. PollCursor is volatile and instance-bound; L2 promises no replay.

### L3 certification and commit

1. Endpoints decide action validity and produce the complete
   certificate.
2. Ledger admission is mechanical and never evaluates policy.
3. Append acknowledgment implies one canonical record is durable and
   readable to every fixed member.
4. The author alone may append in Gate 1.
5. RouterInstanceId is bound into L3 protocol evidence, the epoch
   descriptor, the final action binding, and TranscriptRecord.
6. Author failure after final signature collection may leave the action
   uncommitted; Gate 1 has no takeover.

### Recovery

1. While one attempt is live, endpoints retry required protocol sends
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
   `retry_identity_unknown` causes the endpoint to wrap the same signed
   L3 evidence in a fresh attributed L1 MessageId and send it as
   `initial`. Recipients deduplicate the inner evidence; the endpoint
   does not create new protocol evidence.

### Retry identity

1. Registration retry identity is submitted-SPKI thumbprint plus
   OperationId.
2. Other control mutations use caller AgentId plus OperationId.
3. Router send uses caller AgentId plus MessageId within one expected
   Router instance and one retained cache entry. `retry` with an absent
   entry returns `retry_identity_unknown` without delivery.
4. Ledger append uses ConversationId, epoch, and TxnId.
5. Direct `reply` retry uses TxnId plus the canonical actionId/payload
   fingerprint. After commit, identical bytes recover the durable
   result and changed bytes conflict.
6. Equality is over the owning operation's canonical domain bytes, not
   fresh per-attempt RFC 9421 created/expires/nonce/signature metadata.
   Within the owner's durability or retention scope, identical operation
   bytes recover the original result and changed bytes under one retry
   identity conflict.

### Endpoint attention

1. Runtime attention occurs only after a live local reply grant.
2. A snapshot carries the expected old value/version of every current
   and cross-conversation watermark it uses. Immediately before the SSE
   write, one SQLite transaction compare-and-swaps all of them or
   advances none.
3. A stale expectation rebuilds against current watermarks while the
   grant is live; expiry during rebuild advances nothing and writes
   nothing.
4. One dispatch writer serializes the reservation and complete frame
   bytes, but does not impose a daemon-wide model-turn or protocol cap.
5. A failed or ambiguous write after a successful reservation may lose
   attention and never causes
   replay.
6. Exactly one active turn-ready subscription may consume reply grants
   for an AgentId daemon.

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
  Tool-domain errors are the endpoint facade's minimal stable set.
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
- Manifest and wire values all equal `v2/VERSION`; independent schema
  versions demonstrably do not.
- Type canaries reject PollCursor/LedgerOffset and
  RunLedger/Transcript interchange.
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
- `../decisions/20260729-one-container-per-agent-gates-distributed-runs.md`
- `../decisions/20260729-kubernetes-kueue-admits-agent-cohorts.md`
- `../decisions/20260729-temporal-orchestrates-distributed-runs.md`
- `../decisions/20260729-openclaw-experiments-are-late-bound.md`
- `../decisions/20260729-kubernetes-secrets-bind-agent-slots.md`
