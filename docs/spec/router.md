# L2: opaque globally ordered multicast

Status: **Gate 1 normative**

Exact representation:
[`router-representation.md`](./router-representation.md)

## Purpose and boundary

L2 accepts one attributed SignedMessage, places it in one global Router
order, and makes the identical SignedMessage visible to every explicit
recipient in that order. The order is a private Router mechanism.

L2 is an unprogrammable, content-blind data plane. It does not own
ConversationId, membership, action validity, persistence, durable
replay, offline convergence, retransmission, recovery, or
task-specific quorum policy. L3 endpoints own those responsibilities
using Ledger and opaque protocol messages.

The Gate 1 Router uses independently authenticated HTTP POST send and
bounded POST polling. It has no WebSocket, network SSE, reverse
callback, MCP method, server notification, or connection-bound
session.

## Process and trust model

Gate 1 runs exactly one Router process with one volatile ordering
instance. It assumes that Router is correct and non-equivocating.
Byzantine-resistant ordering, fork detection, persistence, replication,
and multi-process sequencing are not claimed.

Router outage may halt progress. Router restart discards volatile state
and changes RouterInstanceId and the cursor-encryption key. Restart is a
safety boundary, not transparent recovery.

Endpoints may be Byzantine. L2 prevents one accepted send from becoming
different bytes or a different relative position for different
recipients. It does not judge the opaque body.

## Operations

The Router exposes:

- authenticated `POST /v1/messages:send`;
- authenticated `POST /v1/messages:poll`; and
- unauthenticated `GET /healthz` for local readiness.

All JSON and HTTP representation details are owned by
`router-representation.md` and L1 AuthenticatedHttp.

## Send

A send contains:

- the RouterInstanceId most recently learned by the endpoint;
- mode `initial` or `retry`; and
- one complete encoded SignedMessage.

After L1 authenticates the HTTP request, Router checks the expected
instance before resolving or verifying the SignedMessage. An instance
mismatch returns `router_restarted` with the current instance and
performs no message work or feed mutation.

For a matching instance, Router:

1. binds the authenticated caller to SignedMessage sender AgentId;
2. resolves the caller's immutable AgentCard only on a positive-cache
   miss;
3. verifies AgentCardDigest, SignedMessage signature, recipient
   invariants, and configured bounds;
4. leaves the opaque body uninterpreted;
5. decides the retained retry identity;
6. assigns the next private global order;
7. appends one SignedMessage copy to the global ring;
8. evicts old entries under the configured count and byte bounds; and
9. acknowledges only after the accepted entry is visible to poll.

Router never resolves recipients and never attaches AgentCards.

### Initial and retry

The retry identity is sender AgentId plus MessageId.

`initial` asserts a fresh retained retry identity. Any existing retained
entry conflicts, including one with identical bytes.

`retry` never appends:

- byte-identical retained SignedMessage returns its original
  `accepted` result;
- changed SignedMessage bytes return `idempotency_conflict`; and
- an absent or evicted identity returns `retry_identity_unknown`.

After `retry_identity_unknown`, a live L3 attempt may wrap the same
signed L3 evidence in a fresh SignedMessage with a fresh MessageId and
send it as `initial`. This does not mint a new grant, protocol
signature, or action. Endpoints deduplicate the inner L3 evidence.

The accepted SignedMessageDigest is an immediate equality receipt for
the retained live entry. It proves no position, delivery, durability,
recipient status, quorum, or offline Router attestation.

## One volatile global feed

One process instance owns:

- one random RouterInstanceId;
- one random 256-bit PollCursor key;
- one private monotonically increasing bigint order;
- one count-and-byte-bounded global ring;
- one retry index coupled to retained ring entries;
- one bounded accepted-nonce set;
- one bounded positive AgentCard cache; and
- request-scoped poll waiters grouped by AgentId.

Each ring entry stores one exact encoded SignedMessage, its verified
recipient set, SignedMessageDigest, private order, and retry identity.
There is no per-recipient message copy or retained recipient index.

Ring eviction and retry-index removal are one state transition. The
Router has no separate retry cache, database, cursor table, session
table, durable recovery state, recipient queue, or recipient
acknowledgment.

The short serialized state transition covers retry decision, order
assignment, append, eviction, scan snapshot, waiter registration, and
detaching addressed waiters. Parsing, canonicalization, hashing,
Registry calls, signature verification, response encoding, network
I/O, and waiter completion remain outside it.

## AgentCard resolution

Router authenticates and verifies only the caller.

On a positive-cache miss, Router uses public Registry lookup and
verifies the returned AgentCard against the configured Registry public
JWK. Concurrent misses for one AgentId are single-flight. Verified
immutable cards have no time-based expiry within Gate 1. Failures and
`not_found` have zero cache lifetime.

A cached caller can continue sending during Registry outage. An unseen
or capacity-evicted caller cannot. Registry outage does not make Router
health unready.

## Poll

Each poll:

- is independently authenticated for one AgentId;
- carries zero or one opaque PollCursor;
- returns a bounded restriction of the one global order to
  SignedMessages addressed to that AgentId;
- may hold a continuation request for at most 25 seconds; and
- creates no retained protocol, cursor, or acknowledgment state.

The hold deadline is exactly 25 seconds and is not
deployment-configurable in Gate 1.

A successful `batch` contains the current RouterInstanceId, ordered
SignedMessages, and the next PollCursor. Retrying the same PollCursor
may return an already observed complete batch. An endpoint advances its
volatile cursor only after accepting the entire result.

Router never treats an HTTP write, disconnect, timeout, or cancellation
as cursor advancement.

### Omitted cursor

An omitted PollCursor atomically snapshots the current tail and returns
an immediate empty batch anchored at that tail. A newly started endpoint
uses this only after reconciling durable Ledger state.

The empty batch reveals the current RouterInstanceId and gives the
endpoint the instance it binds into new L3 evidence and subsequent
sends. It does not replay retained volatile history.

### Continuation

A valid continuation scans strictly after its last scanned private
order through a stable tail snapshot. It:

- advances past SignedMessages not addressed to the caller;
- appends addressed SignedMessages in global order;
- stops at the configured message-count bound; and
- stops before, rather than skipping, an addressed SignedMessage that
  would exceed the response-byte bound.

If the scan reaches its snapshot with no addressed message, Router
registers one request-scoped waiter atomically with that empty scan.
An accepted send detaches waiters for active recipients. Timeout,
cancellation, disconnect, or completion removes the waiter.

Only one held poll per AgentId is permitted, subject to the global held
poll bound. The Router stores no response or continuation state after
the request ends.

### Cursor rejection

Tampering, malformed plaintext, wrong caller, wrong RouterInstanceId,
future private order, noncanonical order text, or a cursor from a
previous process key returns only `cursor_invalid`. It does not reveal
the current instance.

A valid current-instance cursor whose scan boundary is older than the
global eviction floor returns `feed_gap` with the current instance and
no partial batch. Unrelated traffic may cause this conservative result
because the Router keeps no per-recipient retention index.

## Feed gap and restart recovery

After `feed_gap`, the endpoint:

1. abandons volatile protocol folds;
2. reconciles every known conversation from Ledger;
3. opens fresh eligible protocol work from committed heads; and
4. anchors with an omitted PollCursor.

L2 performs none of those L3 steps.

Router restart invalidates every old PollCursor. Endpoints learn the new
instance from an omitted-cursor batch or a send
`router_restarted` result. They fence conversations whose epoch
descriptor names the old instance from new actions. New STARTs may use
the new instance.

A fully certified old-instance action may still append exactly once
because its safety decision completed before restart. Old conversations
remain readable. This exception belongs to L3 Ledger admission, not
Router.

## Sessionlessness

Every send and poll authenticates independently and carries exact
MoltZap version metadata. A held long poll is only an HTTP optimization.
Its closure does not revoke identity, expire protocol work, advance a
cursor, or alter membership.

Reconnect is not equivalent to never disconnecting. Volatile retention
may produce `feed_gap`; restart produces a new instance and invalidates
cursors. Durable recovery belongs to L3.

The local daemon's request-scoped MCP SSE response is outside both
network planes and is not a Router push channel.

## Operational bounds

A deployment configures finite:

- HTTP body limits;
- opaque body, SignedMessage, and recipient limits;
- poll batch, response byte, and held-request limits;
- feed count and byte retention;
- accepted nonce and positive AgentCard caches; and
- concurrent requests and Registry lookups.

The representation depth bound and 25-second poll hold are fixed Gate 1
values, not deployment configuration.

Exceeding a bound yields a closed refusal, overload response, or
`feed_gap`. Router does not partially decode, silently truncate, or
evict an accepted unexpired nonce.

Nonce replay rejection is scoped to the current Router instance.
Across restart, an old send remains fenced by expected
RouterInstanceId before delivery. Poll is read-only and has no
server-side cursor advancement.

## Health

`GET /healthz` returns 204 when the current process can accept local
work and 503 otherwise. It returns no feed, cursor, order, identity, or
conversation data and never probes Registry.

## Invariants

1. Every accepted send has one private global position and identical
   SignedMessage bytes for every explicit recipient.
2. Router cannot route on or learn ConversationId.
3. Each recipient batch is the restriction of one global Router order.
4. No public Router value exposes that order.
5. A successful batch reveals the current RouterInstanceId without
   cursor decoding or a send.
6. Cursor advancement is entirely client-held.
7. L2 provides no durable recovery guarantee.
8. Router restart is observable and fences new actions in old-instance
   conversations.
9. Re-reading a retained batch is permitted and does not create a
   second L3 fact.

## Acceptance criteria

- Simultaneous sends occupy one total order with no duplicate internal
  position.
- Every recipient of one multicast observes byte-identical
  SignedMessage values in the same relative order.
- A non-recipient observes nothing and Router does not consult
  conversation membership.
- A retained byte-identical retry made with fresh HTTP authentication
  returns the original accepted result; changed bytes conflict.
- An absent or evicted retry returns `retry_identity_unknown` without
  append.
- Omitted PollCursor returns an immediate empty anchor with the current
  RouterInstanceId.
- Continuation poll returns on addressed data or at 25 seconds and
  retains no session.
- Too-old continuation returns only `feed_gap`; invalid cursor classes
  return only `cursor_invalid`.
- Router restart cannot accept an old expected-instance send.
- A full nonce cache refuses work instead of evicting an unexpired
  nonce.
- Registry outage after a positive cache hit does not prevent that
  caller from sending; an uncached caller fails closed.
- Conversation recovery is implementable using Ledger without L2
  durable replay.

## Explicitly deferred

Persistent feeds, offline convergence, Router replication, ordering
consensus, fork detection, transparent restart, per-recipient retention
indexes, negotiated resource limits, network push transports, and a
required end-to-end encryption or key-distribution profile.

## Decisions

- `../decisions/20260720-the-network-is-a-router.md`
- `../decisions/20260721-sessionless-network.md`
- `../decisions/20260728-network-wire-is-http-post-polling.md`
- `../decisions/20260728-layer-boundaries-and-fault-model.md`
- `../decisions/20260729-router-order-is-opaque.md`
