# Data plane

Status: DRAFT (deepening doc; feeds the spec set)

## Purpose & scope

The data plane is the delivery half of the network, split out of the control
plane. It delivers messages in ordered multicast (L2) and records the actions
those messages perform (L3), addressing everything through a
conversation. It is the shared
substrate under every agent's harness; everything interpretive lives at
endpoints.

The plane realizes the stack's L2 and L3
(`docs/decisions/20260723-eight-layer-stack.md`,
`docs/decisions/20260722-data-plane-layering.md`): **L2, ordered multicast
delivery** — a message delivered all-or-none, in single total order, to the
recipients it names; the conversation handle carries who each message goes
to, and the layer owns no membership — and **L3, transactional messaging**,
where conversations address and collective operations are transactions over
the per-conversation transcript. Tasks (L4) sit above the plane entirely;
endpoint firewalls (L5) act at the delivery edge, programmed from above.
Conversation lifecycle rides in-band as L3 action types: a conversation
begins as its transcript's genesis entry, membership changes and
departures are subsequent entries, and half-open state expires by bounded
timeout (`docs/decisions/20260723-lifecycle-rides-l3.md`). Lifecycle actions are membership
mechanics; like every action they are performed by a protocol and
recorded once.

Goals: state the plane's duties as guarantees, independent of realization;
record the dissolution of the v1 app layer, power by power; state the
recorded eval seam — no centralized middleware exists; testing and evals run
against an alternative, testbed-owned implementation of this same interface
(`docs/decisions/20260723-eval-plane-is-testbed.md`). Non-goals: the action vocabulary, call shape, and the completion /
failure / concurrency / initiation / witness / ordering clusters (owned by the
collective-semantics charter; this doc scopes the protocol machinery, not the vocabulary of actions built on it);
control-plane duties (identity, membership administration, the record substrate
itself); endpoint concerns (L5 screening, L4 task norms, which action a well-behaved
participant performs next).

## Duties (guarantee level)

- **Delivery.** The plane accepts a signed L1 message naming a collective
  action from a conversation member and delivers it to the members the
  envelope addresses. Prompt push is best-effort; convergence is guaranteed
  (timeliness and delivery-status semantics are chartered): a member that
  misses a push recovers the history and reaches the same observed sequence as
  one that never disconnected.
- **Ordering.** Deliveries within a conversation are totally ordered: every
  member observes the same messages in the same order, including members
  transiently unavailable at send time.
- **Actions and protocols.** An action is performed by a protocol — an
  exchange of ordinary messages the plane delivers without
  understanding — and recorded once, atomically, carrying the
  participants' signatures. A single-message action (an ordinary
  utterance) is the degenerate protocol; a collective is a longer one.
  The plane contributes delivery and the recording, never a judgment
  about whether a protocol completed.
- **Turn admission.** At most one transaction is open per conversation, and
  the plane admits no *effective* entry whose grant does not precede it in the
  shared order — an endpoint holds the grant before it generates, so agreement
  precedes generation, not merely delivery. The discipline is at collective
  granularity: protocol messages are admitted without a grant and carry no effect.
  At most one transaction is open per conversation: two open
  transactions would mean two writers generating concurrently, which
  is what PCC exists to deny. Concurrency is expressed as more
  conversations — ids are client-minted — never as nested locks.
- **Transactional collectives.** A collective action is one transactional
  unit over the conversation's ledger: the record represents one
  ALL_GATHER — MPI-style, every member contributes and every member
  receives — as that operation, never as a sequence of independent messages.
  The unit is a multi-signed transaction assembled by rounds of ordinary
  multicasts (`docs/decisions/20260724-collectives-are-ledger-transactions.md`;
  diagrams below): endpoints drive the exchange using the delivery
  primitive; the plane contributes the primitive and the representation,
  nothing more — it never judges a collective's completeness. The
  vocabulary and its semantics are chartered (#765).
- **Attribution in transit.** Frames arrive carrying the L1 attribution they
  were emitted with, verifiable by the recipient; the plane never mints,
  alters, or strips it.
- **Admission.** At admission the plane verifies, at minimum, that the
  message's attribution verifies per L1, its sender identity exists
  and its directory entry says active (the one institutional fact v0
  reads — `docs/decisions/20260724-l7-is-policy-attached-to-identity.md`), and the sender is a member of the conversation the
  envelope addresses — or the message is a start entry to a fresh id
  (law L3.5), which needs no grant because there is no conversation
  to lock yet; failing messages are refused before commitment.
  Recorded decision: admission checks nothing relationship-shaped
  beyond membership — the router has no reachability role.
- **Content-blindness.** Routing and admission read envelope fields only, never
  bodies. End-to-end encryption stays a preserved possibility.
- **Evidence retention.** The store keeps, beside each message, whatever
  the binding in effect needs to re-verify it — under the interim
  binding the request-signature material and the sender's card — so a
  recorded message stays verifiable with no live sender and after the
  registry ceases to vouch.
- **Records handoff.** Atomic commit: an action is committed for every
  member or for none, an acknowledgment implies commitment, and only
  committed actions are the record (control-plane-side; the record L6
  reads). A protocol's messages are delivered in L2's shared order and
  folded live; they are not recorded; whether delivery precedes
  durability is realization
  (`docs/decisions/20260724-collectives-are-ledger-transactions.md`).
- **Addressing (L3).** A conversation id is the routing handle — an opaque
  group handle. Membership changes are delivered in-band, ordered against
  message flow. Read-back is scoped by membership and envelope fields; the
  exact fields are chartered.

## The collective transaction (recorded)

The recorded direction
(`docs/decisions/20260724-collectives-are-ledger-transactions.md`): a
collective is a transaction on the transcript's pessimistic-database
interface — `begin` locks the turn, `update`s stage contributions,
`commit` lands one multi-signed unit — realized among distrusting
parties as rounds of ordinary L2 multicasts. Every round message is an
ordinary attributed message the plane admits and fans out without
understanding it; one ack round replaces gossip because the
equivocation-infeasible shared order lets every member compute the
agreement point identically.

```mermaid
sequenceDiagram
  participant L as Leader - lock holder
  participant A as Member A
  participant B as Member B
  participant R as Router - L2 over the ledger
  L->>R: BEGIN - propose. txn id is the hash of this message
  R-->>A: fan out
  R-->>B: fan out
  A->>R: ACK txn
  B->>R: ACK txn
  Note over L,B: ack rule met in the shared order - the GRANT is this fold, the acks are its certificate
  L->>R: UPDATE txn with xL
  A->>R: UPDATE txn with xA
  B->>R: UPDATE txn with xB
  Note over L,B: one update round - contributions are concurrent, order among them irrelevant
  Note over L,B: each update binds txn id + grant ref under its signature - replay and misbinding dead
  L->>R: SIGN the digest of txn id, cut, update refs, result
  A->>R: SIGN the same digest
  B->>R: SIGN the same digest
  L->>R: COMMIT txn with the signature set
  Note over R: one atomic unit in the order - admitted, never judged
```

**The correctness skeleton.** Locks and effects are folds over the
shared order; entries are the only reality. The grant is the fold
"the ack rule is met by the signed acks following BEGIN" — no router
utterance, no lock table. A commit's validity — quorum per the pinned
norm, signatures verifying, result recomputing — is a deterministic
fold too: the plane admits the commit entry without judging it, and
every same-pinned party computes the identical effective/ineffective
verdict, so an invalid commit is admitted, ineffective, and L6
evidence. Resolution and effect are separate folds over the same
entries: any commit or abort from the holder **resolves** the
transaction and releases the lock whatever its validity — otherwise a
holder emitting garbage would hold the conversation hostage to its
TTL — while validity decides only whether the transaction enters the
canonical chain. Failure handling follows: timeouts are local observations
whose consequence — a superseding BEGIN or an abort — is resolved by
the order, so whichever grant completes first wins and a late commit
against a superseded grant is deterministically ineffective; restart
recovers lock and transaction state by re-folding (this doc's open
question 5, closed below); one effective commit per txn id, so
retries are harmless — which is also the norm compile step's
idempotency key (`endpoints/tasks.md`).

**Two orders, and only one of them is kept.** L2 delivers every
message — protocol messages included — in one shared order, and that
ordering is L2's own guarantee, not a consequence of storage: the
delivery layer sequences what it delivers whether or not anything
records it. Participants fold that live stream to compute the grant,
so the ack rule is met at a position everyone observes identically.
The ledger is L3 and records **actions**. Protocol messages are
delivered, never recorded; nothing is stored, so nothing is pruned,
and post-hoc verification never re-folds the acks — the committing
message carries the participants' signature set, so a reader verifies
from that record alone. The ledger is a chain of agreements, not a
write-ahead log of coordination.

Two consequences an implementer needs. **Recovery converges on
recorded actions**: a member that reconnects mid-protocol abandons the
in-flight fold and re-syncs from committed state — the protocol's
messages are gone, and there is nothing to replay (this is what
question 5's closure means, and the same reason a router restart has
nothing to re-fold). And anything the protocol keys on a **position**
keys it on the last committed offset preceding the protocol's opening
message, never on an offset of an unrecorded message: membership for
the ack rule is `membersAt` that offset, and the cut is a position in
the delivered stream that every participant observes identically.

```mermaid
flowchart LR
  subgraph Rounds["L2 delivery - protocol messages, ordered and folded live, never stored"]
    P[begin] --> K[acks] --> X[updates] --> S[signatures]
  end
  subgraph Ledger["L3 ledger - recorded actions, durable, hash-chained"]
    T1[T1] --> T2[T2] --> T3[T3]
  end
  S -- "one atomic multi-signed commit" --> T3
```

What the skeleton already settles is recorded with it: contributions
are embedded in the commit message (references bind in the digest,
bodies persist), one open transaction per conversation, holder-only
abort with a superseding grant as the group's remedy, participants
contributing as unlocked protocol messages the leader embeds, the cut
derived from the deciding ack, and the retention floor above. What
stays the charter's: the action vocabulary, the shape
constraints on a norm's ack rule, and TTL magnitudes.

## Wire surface

**Not defined yet** (this doc's open question 10). By recorded decision an interim
realization keeps v1's WebSocket machinery, replaceable without spec change
(`docs/decisions/20260722-data-plane-layering.md`; details and the known
deviation: Implementation notes). What is decided bounds any future
definition (`docs/decisions/20260721-physical-plane-split.md`,
`docs/decisions/20260721-sessionless-network.md`,
`docs/decisions/20260721-single-credential.md`,
`docs/decisions/20260722-data-plane-layering.md`): data-plane traffic rides
its own surface, never the control endpoint; delivery is one-way — no
response rides the delivery path, and an endpoint's responses,
acknowledgments included, are first-class send calls; the plane keeps no per-endpoint
connection or session state, so whatever shape delivery takes must be
resumable from an offset the endpoint owns; every call is signed with the
caller's card key and carries the protocol version; and messages cross the
surface byte-exact (`identity.md`). Turn-signal carriage is the charter's
ground (#765); whatever its shape, turn state is per-conversation
coordination state that expires by a bounded timeout, never by disconnect —
no connection state exists to observe.

## The testbed data plane (recorded)

By recorded decision (`docs/decisions/20260723-eval-plane-is-testbed.md`)
no centralized middleware exists — constitution clause 2 carries no
exception. Testing and evals run against an alternative implementation of
this plane's interface, owned by the testbed (the runtimes-to-testbed
extraction, #779): same guarantees, plus envelope-level observation and
bounded fault injection. Its rules:

- **May observe:** envelope-level delivery events and action lifecycle (accepted,
  ordered, delivered), with timing; terminal-state vocabulary is deferred to
  the charter's completion / failure clusters; body observation follows the
  deployment's encryption posture (open, below).
- **May inject:** only faults inside the failure envelope the L2/L3 semantics
  already tolerate — delay, missed push (recoverable by catch-up), disconnect,
  partition, an unresponsive counterparty. Injected faults are
  indistinguishable, to production semantics, from natural ones.
- **May never:** mint or alter attribution, rewrite or reorder committed order,
  mutate membership, author policy verdicts, or carry standing policies.
- **Production never depends on it:** no guarantee here is conditioned on its
  presence; it is absent by default, and when present its configuration is part
  of the experiment's recorded run configuration (the run artifact the
  experiment publishes).

## Reuse (where directed; non-normative)

Recorded (maintainer comment on #765, 2026-07-21 — labeled architecture
guidance, not normative interface text): the v1 dispatch-lease turn discipline
is reused as the PCC instrument inside delivery semantics — an instrument, not
an interface: no lease concept appears on the wire surface or in normative
guarantees (sketch in Implementation notes). Proposed, pending a recorded
decision: the v1 conversation machinery (participant sets, subscription-scoped
delivery) as the L3 addressing primitive. Decided: the v1 conformance
pattern — adversity as a suite-invocation parameter, plus
scripted-counterparty faults — is the testbed data plane's injection surface
(`docs/decisions/20260723-eval-plane-is-testbed.md`).

## Dissolution notes

The app layer dissolves: no app principals, no manifests, no hooks, no reverse
callbacks. Destinations, power by power:

| v1 power | Destination |
|---|---|
| Message-authorize hook (per-message forward/block verdict) | Abolished. The plane delivers; inbound screening is endpoint L5. |
| Verdict-derived recipient sets (per-message visibility filter) | Membership and envelope-level addressing; exact fields chartered (open). |
| Dispatch-authorize hook (moderator grants/denies/holds a turn) | Dissolved into the transaction's grant; which action and speaker come next is an L4/skill concern. |
| Admission deny ejecting the participant | Abolished. Admission outcomes never mutate membership; membership changes are their own in-band ordered events. |
| Task-create hook, TaskMasters, network-side task records | Tasks are endpoint conventions with no network representation; conversations stand alone, bound to no task or app. |
| App manifests, app principals, reverse-callback extension surface | Gone entirely; no centralized seam exists — evals run against the testbed data plane (`docs/decisions/20260723-eval-plane-is-testbed.md`). |
| Moderator lease notifications and moderator-scoped lease reads | Die with the moderator principal; member-facing delivery-status semantics chartered (open). |
| Lease-derived presence ("working") | Presence semantics chartered (open). |
| Fail-closed blocking when an app is unreachable | Gone; no network-side gatekeeper exists to be unreachable. |

## Implementation notes (non-normative)

Interim wire: the v1 WebSocket machinery carries the plane for now — send as
a JSON-RPC request; delivery is a fire-and-forget call on the connection's
reverse RPC channel (v1 labels it a notification, but the message carries an id
and its void acknowledgment is discarded). That carriage deviates from the
one-way delivery bound: the fix restores a strict id-less notification, any
acknowledgment becoming a separate send call. The interim socket also binds
identity at connect with a bearer key and carries mixed traffic. The v1
machinery is a migration baseline, not a compliant realization: the
sessionless, single-credential, and plane-split bounds stay normative, and
these gaps are what the migration closes. Transitional mechanism, not
interface: the sessionless guarantees govern (recovery is offset-resumable;
the connection is never semantic state), and replacement needs no spec change.

Maintainer sketch: the plane's realization is a per-conversation ordered
transcript plus dispatch leases implementing the PCC discipline. Frames are
transcript entries; the lease is the turn instrument, bracketing the durable
append (claim, append, finalize; rollback on failure), with a TTL that never
expires a claim mid-append and disconnect cleanup that never rolls back a
committed entry. Gaps observed in the v1 realization, recorded for salvage:
sequence assigned at insert start breaks gap-free catch-up under concurrent
commits; no per-conversation exclusivity invariant on active leases; lease
state in-memory and single-node (whether this is a gap is contingent on open
question 5); grant coalescing lets one lease consume several messages, while
consensus ops need exact accounting. Under the sessionless decision the
sketch's disconnect cleanup has no signal to key on: lease expiry is TTL-only.
Testbed-plane precedent: the v1
conformance suite's toxic-profile DSL (transport faults) and scripted app
(verdict / hold / silence — semantic faults).

## Invariants

1. Routing and admission read envelope fields only, never bodies.
2. The plane never mints, alters, or strips L1 attribution.
3. Per-conversation total order: all members observe the same messages in the same order; an unavailable member converges to it on recovery.
4. Atomic commit: an action is committed for every member or for none; an acknowledgment implies commitment; a protocol's messages are delivered and folded live, never recorded.
5. Turn-disciplined effect: no action is recorded unless its grant preceded it in L2's shared order, and at most one transaction is open per conversation; endpoints hold the grant before generating. A protocol's messages need no grant and are never recorded.
6. Starvation protection, established per task (L4): no coalition of faulty members can indefinitely deny an honest member its turn under the task's protocol.
7. Equivocation robustness: a sender cannot present different members with different versions of the same message.
8. Membership changes are in-band events, ordered against message flow.
9. No network-side principal, hook, or policy vetoes, rewrites, redirects, or reorders delivery; admission outcomes never mutate membership.
10. No data-plane interface names or carries a task.
11. Implementation-swap equivalence: replacing the production data plane with the testbed data plane changes no production semantics; every testbed injection stays inside the tolerated failure envelope.
12. The plane keeps no per-endpoint connection or session state.
13. Only data-plane traffic rides the data surface, and messages within it are carried byte-exact, never re-encoded.
14. Delivery is one-way: no response channel rides the delivery path; an endpoint's responses, acknowledgments included, are first-class sends.

## Acceptance criteria

- Every normative statement in the plane's spec chapter is a guarantee or interface; mechanisms appear only in non-normative notes.
- Each of the four paper-required constraints maps to at least one invariant testable over the protocol machinery.
- The dissolution table is total: every v1 hook/manifest power has a recorded destination (endpoint layer, envelope, charter, or abolished).
- Message visibility is fully determined by membership and envelope fields; no per-message principal verdict exists anywhere in the spec set.
- The v1 scripted-fault conformance tier is reproducible through the testbed data plane with no production hook path, and swapping implementations changes no production conformance outcome.
- Both case studies' scheduling flows are expressible as action sequences with no testbed dependency — verified under the collective-semantics charter's acceptance.

## Open questions

1. Visibility scoping: which envelope fields (participants, witnesses, membership epoch) scope delivery and history read-back — the collective-semantics charter, jointly with register Q4/Q6 (witness read-back; records retention and history-read scope).
2. The seven charter clusters (op set, completion, failure, concurrency, initiation authority, witnesses, ordering) — deferred to the charter. Lifecycle's carriage is recorded (in-band L3 entry types — `docs/decisions/20260723-lifecycle-rides-l3.md`), and the collective's execution shape is recorded (rounds over L2, one multi-signed transaction — `docs/decisions/20260724-collectives-are-ledger-transactions.md`); the charter owes what remains: the action vocabulary, the shape constraints a norm's ack rule must satisfy, TTL magnitudes, and ARCHIVE's meaning. Embed-vs-reference, abort authority, participant carriage, the cut, overlapping transactions, and the retention floor are recorded consequences of the skeleton (`docs/decisions/20260724-collectives-are-ledger-transactions.md`).
3. Presence and delivery-status semantics, including what replaces lease-derived presence — charter.
4. Does the plane owe per-recipient delivery status, or is recovery-convergence the whole guarantee beyond the commit acknowledgment?
5. Closed: lock and transaction state are live coordination folded from L2's delivered order, never stored — so a restart or reconnect does not re-fold, it abandons the in-flight transaction and re-syncs from committed state (`docs/decisions/20260724-collectives-are-ledger-transactions.md`). No durable lease table, no wire-visible restart semantics. Number retained.
6. Testbed-plane observation under a content-blind deployment: envelope-only, or a key-holding observer (the constitution's monitor question)?
7. Experiment observation surface: record-substrate reads, a testbed-plane event stream, or both — and where that boundary sits.
8. Wire discipline for action envelopes (closed-struct / excess-key rejection) — `v2/VISION.md` register item 9.
9. Closed by recorded decision (`docs/decisions/20260723-eval-plane-is-testbed.md`): no centralized middleware exists — the eval seam is the testbed data plane, and clause 2 carries no exception. Number retained so question 10's external citations stay valid.
10. The wire surface: the send call shape; the delivery model (endpoint-initiated reads, held-open responses, or another shape); the feed's scope (per-conversation vs endpoint-wide) and its resume semantics — bounded by the sessionless, plane-split, and single-credential decisions.

## References

- `v2/VISION.md` (constitution: clauses 1–3, 5–7, 13; open-question
  register); `docs/architecture/layers.md` (layer model, layering rules).
- `docs/decisions/20260721-physical-plane-split.md`,
  `docs/decisions/20260721-sessionless-network.md` — the wire-surface
  decisions; `docs/decisions/20260722-data-plane-layering.md` — plane
  layering and the interim wire.
- #765 — the collective-semantics charter: action clusters, four
  paper-required constraints, the superseded MULTICAST-only scope, maintainer
  transcript-plus-leases sketch. #755 — v2 epic.
- `v2/inputs/v1-code-audit-20260717.md` (delivery-path and hook-machinery map);
  `v2/inputs/case-study-audits-20260718.md` (arena/bench evidence for the eval
  seam); `v2/inputs/debt-inventory-20260718.md` (eval-harness rebuild verdict).
