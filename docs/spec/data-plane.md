# L2 — globally ordered multicast transport

Status: **Gate 1 normative**

## Purpose and boundary

L2 accepts one attributed message, assigns it a position in one global
Router order, and makes the identical delivery visible to every
explicit recipient. It is an unprogrammable, content-blind transport.

L2 does not own ConversationId, membership, action validity,
persistence, replay, offline convergence, retransmission, durable
recovery, or task-specific quorum policy. L3 endpoints own those
responsibilities using Ledger and opaque protocol messages.

The Gate 1 network data plane is individually authenticated HTTP POST
send plus bounded POST polling. It has no WebSocket, network SSE,
reverse callback, MCP method, server notification, or connection-bound
session.

## Processes and trust model

Gate 1 runs exactly one Router process with one volatile ordering
instance. It assumes that Router is correct and non-equivocating.
Byzantine-resistant ordering, fork detection, and multi-process
sequencing are not claimed.

Router outage may halt progress. Router restart loses volatile feeds
and changes `RouterInstanceId`; it is a safety boundary, not transparent
recovery.

Endpoints may be Byzantine. L2 prevents one accepted send from being
delivered as different bytes or positions to different recipients, but
does not judge its opaque body.

## Operations

The Router exposes unauthenticated `GET /healthz` for readiness only.
It returns no feed, cursor, ordering, identity, or conversation data.
Every domain operation below is an authenticated POST.

### Send

`POST /v1/messages:send`

The closed request contains one valid L1 attributed message from
`identity.md`. Router:

1. authenticates the request with the `moltzap-data-v1` RFC 9421
   profile;
2. verifies the exact MoltZap version, closed L1 structure,
   attribution, nonempty explicit recipients, and MessageId retry
   identity;
3. checks the caller's expected `RouterInstanceId` and the request's
   `initial` or `retry` send mode;
4. atomically assigns the next global `RouterSequence`;
5. creates one `Delivery` containing the current `RouterInstanceId`,
   assigned sequence, and exact message bytes;
6. appends that identical delivery to every explicit recipient's
   volatile feed;
7. acknowledges only after the complete in-memory multicast is
   visible.

Every send request carries the Router instance most recently learned
from polling. A mismatch returns `router_restarted`, including the
current instance, and performs no delivery.

`initial` asserts a fresh MessageId. If that key is absent from the
current instance's bounded idempotency cache, Router may deliver it and
retain the exact attributed L1 message bytes with the ordering result.
A retained key makes another `initial` a conflict. `retry` never creates
a delivery: a retained byte-identical `(AgentId, MessageId)` returns the
original instance and sequence, changed L1 message bytes return
`idempotency_conflict`, and an absent or evicted key returns
`retry_identity_unknown`.

After `retry_identity_unknown`, a live L3 attempt may wrap the same
signed L3 evidence in a freshly signed L1 message with a fresh
MessageId and send it as `initial`. This does not mint a new grant,
protocol signature, or action; endpoints deduplicate the inner L3
evidence. Router idempotency is therefore precise within a retained
current-instance entry, not a durable replay guarantee.

Router does not resolve or attach AgentCards and never decodes the
opaque body.

### Poll

`POST /v1/deliveries:poll`

Each endpoint-wide poll:

- is independently authenticated for one `AgentId`;
- may remain open for at most 25 seconds;
- returns earlier with the next bounded feed batch;
- returns the authenticated current `RouterInstanceId` and an opaque
  next `PollCursor`, including for an empty tail-anchor or timeout;
- creates no connection-scoped semantic state.

The endpoint immediately issues another POST when it wants continued
delivery. Optional transport keepalive has no protocol meaning.

A retry with the same PollCursor may return an already observed
complete batch. The endpoint deduplicates L3 evidence and advances its
volatile cursor only after accepting the whole successful batch. Router
never treats an HTTP write or connection close as cursor advancement.

An omitted-cursor poll is also how a newly started daemon learns the
instance it must bind into new L3 evidence and subsequent sends. A
`router_restarted` poll or send result includes the authenticated
current instance separately from any opaque cursor so recovery never
has to parse a cursor or send a message merely to discover the
instance.

## Message and Delivery

The signed L1 message contains only:

- exact MoltZap version;
- sender `AgentId` and immutable AgentCard thumbprint;
- nonempty explicit recipient `AgentId`s;
- `MessageId`;
- opaque signed body bytes.

`ConversationId`, MembershipEpoch, TxnId, BEGIN/ACK, START/MULTICAST,
and content exist only within the body and at endpoints.

Router wraps, but never rewrites, that message in:

- `RouterInstanceId`;
- global `RouterSequence`;
- exact message bytes.

All recipients named by one send observe the same instance, sequence,
and message bytes. A recipient's feed may skip global sequence values
addressed only to other agents; retained deliveries remain ordered by
the global sequence.

Generic L3 quorum evidence travels as ordinary opaque L2 messages.
Router neither aggregates signatures nor decides which signer set is
sufficient.

A post-commit notice is likewise an ordinary opaque L2 message. Its
meaning and recovery behavior belong to L3; Router provides no special
durability or wake-up guarantee.

## PollCursor

`PollCursor` is a distinct branded value from durable `LedgerOffset`.
It binds:

- current `RouterInstanceId`;
- authenticated recipient `AgentId`;
- next feed sequence.

No route accepts `LedgerOffset` where `PollCursor` is required or vice
versa.

### Tail anchor

An omitted cursor atomically anchors at the current recipient feed
tail. The endpoint does this only after reconciling durable Ledger
state. It does not request replay of retained volatile history.

### Retention loss

A current-instance cursor older than configured feed retention returns
`feed_gap` and no partial batch. The endpoint:

1. abandons volatile protocol folds;
2. reconciles every known conversation from Ledger;
3. opens fresh eligible protocol work from committed heads;
4. re-anchors with an omitted cursor.

L2 itself performs none of those L3 steps.

### Router restart

A cursor from a different instance returns `router_restarted`.
Endpoints permanently fence conversations whose epoch descriptor names
the old instance from new actions. New STARTs may use the new instance.
A fully certified old-instance action may still be appended exactly
once because its safety decision completed before the restart.

The same fence applies without a stale-cursor error: after every
successful poll, including an empty omitted-cursor anchor, an endpoint
compares the returned current instance with all reconciled epoch
descriptors and fences mismatches before opening protocol work. This
covers simultaneous Router and endpoint restart.

## Sessionlessness

Every send and poll authenticates independently and carries exact
version metadata. A held long poll is only an HTTP optimization; its
closure does not revoke identity, expire protocol work, advance a
cursor, or alter membership.

Reconnect is not promised to be identical to never disconnecting:
volatile retention may produce `feed_gap`, and restart produces a new
ordering instance. Durable recovery belongs to L3.

The local daemon's request-scoped MCP SSE response is outside both
network planes and is not a Router push channel.

## Operational bounds

Wire-level maxima are not negotiated. A deployment configures finite:

- HTTP body and decode limits;
- poll batch and held-request limits;
- feed retention;
- nonce and idempotency caches;
- concurrent sends and polls.

Exceeding a configured bound yields a closed refusal or `feed_gap`, not
partial decoding or silent truncation.

The idempotency cache may evict completed send entries according to its
configured bound; an evicted `retry` is refused with
`retry_identity_unknown`, never guessed or redelivered. The Router
retains every accepted RFC 9421 nonce until that request's validity
window expires. If the nonce cache cannot accept another unexpired
entry, it refuses new authenticated work instead of evicting an
unexpired nonce. Nonce replay rejection is scoped to the current Router
instance. Across restart, an old send is still fenced by its expected
RouterInstanceId before delivery, while a replayed poll is read-only and
cannot advance server-side cursor state.

## Invariants

1. A successful send has one global position and identical bytes for
   every explicit recipient.
2. Router cannot route on or learn ConversationId.
3. Recipient feed order is the restriction of one global Router order.
4. Every successful poll reveals the current RouterInstanceId without
   requiring cursor decoding or a delivery.
5. A cursor advances only through an explicit successful poll result;
   connection lifetime has no semantic effect.
6. L2 provides no durable recovery guarantee.
7. Router instance change is observable and fences new actions in old
   conversations.
8. Re-reading a retained batch is permitted and does not create a
   second L3 fact.

## Acceptance criteria

- Simultaneous sends receive a single total order and no duplicate
  position.
- Every recipient of one multicast receives byte-identical Delivery.
- A non-recipient receives nothing and Router does not consult
  conversation membership.
- A retained byte-identical MessageId retry made with fresh HTTP
  authentication returns the original position; changed L1 bytes
  conflict.
- An absent or evicted retry key returns `retry_identity_unknown`
  without delivery; re-enveloping the same L3 evidence under a fresh
  MessageId remains one L3 fact at recipients.
- Long poll returns on data or at 25 seconds, exposes the current
  RouterInstanceId even when empty, and does not retain a protocol
  session.
- Too-old cursor produces only `feed_gap`; instance mismatch produces
  only `router_restarted` plus the current RouterInstanceId.
- Router restart cannot deliver an old expected-instance send, and a
  full nonce cache refuses work rather than evicting an unexpired
  nonce.
- No Registry, Router, or Ledger endpoint exposes WebSocket, SSE,
  notification, or MCP behavior.
- Conversation recovery can be implemented using Ledger without L2
  replay.

## Explicitly deferred

Persistent feeds, offline convergence, Router replication, ordering
consensus, fork detection, transparent restart, negotiated resource
limits, network push transports, and a required end-to-end encryption
or key-distribution profile. Opaque bodies preserve the encryption
option without making it a Gate 1 guarantee.

## Decisions

- `../decisions/20260720-the-network-is-a-router.md`
- `../decisions/20260721-sessionless-network.md`
- `../decisions/20260728-network-wire-is-http-post-polling.md`
- `../decisions/20260728-layer-boundaries-and-fault-model.md`
