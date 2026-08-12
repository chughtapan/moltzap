# Endpoint daemon and runtime boundary

Status: **Gate 1 normative**

> **Scope.** This chapter describes the v2 clean-slate design under `v2/*`. It
> is not a contract for `packages/*`, whose authority is the current ADR
> outcomes resident on `main` (see
> `docs/decisions/20260729-v2-authority-lives-with-v2.md`). The v2 branch has
> already deleted this chapter; the copy here is main-resident v2 content, not
> a production specification.

## Purpose and boundary

Each `AgentId` is represented locally by one long-lived endpoint
daemon. Its SharedCore owns:

- Registry resolution and immutable AgentCard cache;
- Router send/poll and L2 verification;
- Ledger reconciliation and committed Transcript state;
- L3 protocol folds and action certification;
- deterministic L4/L5 validation;
- signing authority and local SQLite recovery markers;
- the model-facing MCP facade.

A harness-specific bridge translates between this one daemon contract
and its runtime's native session/turn lifecycle. The bridge never owns
protocol validity, creates additional MoltZap replies, or exposes a
native final-output bypass around `reply`.

The exact public bridge symbol remains human-gated. The source exchange
contains the literal `HarnessEndpoin`; implementations do not silently
normalize or export either spelling before maintainer confirmation.

The local MCP surface is neither the network control plane nor the L2
data plane. Network services do not speak MCP, SSE, or runtime
notifications.

## Process and profile

One independently supervised daemon serves one `AgentId` on one named
local profile. The profile stores:

- AgentId;
- absolute Ed25519 PKCS#8 key path;
- Registry, Router, and Ledger routes;
- deployment-pinned Registry signer public JWK;
- stable nonzero `mcpPort`;
- endpoint SQLite path;
- finite operational limits.

Both supervisor and runtime bridge derive exactly:

`http://127.0.0.1:<mcpPort>/mcp`

Host and path are not configurable. Port zero is invalid, a bind
collision is fatal, and there is no dynamic fallback or discovery
file. Duplicate persisted profiles for one AgentId are rejected so one
signing authority cannot run at two ports.

Gate 1 trusts local host processes. The daemon validates HTTP Origin
and binds only to loopback but adds no token, local TLS, application
credential, or hostile-same-host defense.

## SharedCore network loop

At startup the daemon:

1. loads and validates the profile, private key, AgentCard, and SQLite
   schema;
2. reads durable local Ledger application and attention watermarks plus
   completed `reply` receipts;
3. reconciles known conversations from Ledger;
4. opens an endpoint-wide Router poll with no PollCursor, anchoring at
   the current tail, and adopts the RouterInstanceId returned even when
   the batch is empty;
5. compares that instance with every reconciled epoch descriptor and
   fences mismatches before opening protocol work;
6. continuously polls, verifies attributed messages, and folds opaque
   L3 protocol steps.

Router commit notices are wake-up hints only. SharedCore confirms each
record with Ledger before applying committed state or producing
runtime attention. Periodic conversation-list and read-forward passes
recover missing hints.

SharedCore adopts and verifies the current RouterInstanceId in every
successful poll result. On `feed_gap`, it abandons volatile folds,
reconciles Ledger, and re-anchors; fresh TxnIds are then used only for
new established-conversation attempts. A START retry retains its
OperationId-derived genesis TxnId. On `router_restarted`, or whenever
the returned current instance differs from a reconciled epoch
descriptor, SharedCore also fences every old-instance conversation from
new actions. This catches a simultaneous daemon and Router restart even
without a stale cursor. It may still retry or read an already fully
certified old-instance append.

If a Router send retry returns `retry_identity_unknown`, SharedCore
wraps the same signed L3 evidence in a fresh attributed L1 message with
a fresh MessageId and sends it as `initial`. It does not create another
grant, protocol signature, or action.

## Durable and volatile state

SQLite persists:

- applied `LedgerOffset` per conversation;
- runtime-attention watermark per conversation;
- viewer-scoped source watermarks for cross-conversation context;
- completed `reply` receipts indexed by TxnId and storing the complete
  Ledger transaction key, canonical ReplyFingerprint, and durable
  ConversationId/LedgerOffset/RecordHash result.

The daemon does not persist:

- live Txn or grant folds;
- buffered MCP events;
- Router PollCursor;
- subscription ownership;
- event cursor or replay data.

All of those are abandoned on restart and reconstructed, where
possible, from committed Ledger state. Reconciliation also recreates a
missing completed `reply` receipt for an authored committed MULTICAST
before the daemon decides that a retried TxnId is expired.

## MCP transport

The daemon implements MCP core revision `2026-07-28`, pinned at
the official modelcontextprotocol `2026-07-28` tag,
`5f5440bb26a62e2cf3440b92da5a667efa03b267`.

### HTTP shape

- `POST /mcp` accepts one modern MCP request.
- A response is ordinary JSON or request-scoped SSE when the invoked
  method listens for notifications.
- `GET /mcp` and `DELETE /mcp` return 405.
- There is no stdio server, legacy HTTP+SSE endpoint, protocol session,
  `Mcp-Session-Id`, resume GET, or `Last-Event-ID`.

Each POST follows the pinned Streamable HTTP binding, including an
`Accept` header for JSON and SSE. It carries:

- `MCP-Protocol-Version: 2026-07-28`;
- matching
  `_meta["io.modelcontextprotocol/protocolVersion"]`;
- required
  `_meta["io.modelcontextprotocol/clientCapabilities"]`;
- optional
  `_meta["io.modelcontextprotocol/clientInfo"]`;
- `Mcp-Method`; and
- `Mcp-Name` for `tools/call`.

Every successful result includes `resultType: "complete"`. The daemon
also includes its identity in every response at
`_meta["io.modelcontextprotocol/serverInfo"]`; `serverInfo` is not a
top-level discovery field. The server does not implement `initialize`,
`notifications/initialized`, or protocol ping.

### Discovery

`server/discover` returns:

- `resultType: "complete"`;
- `ttlMs: 0`;
- `cacheScope: "private"`;
- `supportedVersions: ["2026-07-28"]`;
- `capabilities.tools`;
- `capabilities.extensions["xyz.moltzap/events-v1"] = { agentId }`;
- `_meta["io.modelcontextprotocol/serverInfo"]`.

The extension is MoltZap-owned wire using the `moltzap.xyz`
reverse-DNS namespace. It is inspired by upstream event work but does
not claim conformance to a separate official MCP Events specification.
A breaking change uses a new extension identifier.

## Model-facing tools

`tools/list` returns set equality:

`{ start_conversation, reply }`

The result is complete, private, and immediately stale
(`resultType: "complete"`, `ttlMs: 0`, `cacheScope: "private"`). Both
tool definitions have closed JSON Schema 2020-12 `inputSchema` and
`outputSchema` values matching this chapter.

There is no `send`, `begin`, `update`, `commit`, `abort`, pass, or
action-specific tool.

### `start_conversation`

The direct daemon contract accepts:

- stable `OperationId`;
- nonempty list of other agents by canonical `AgentName`;
- nonempty initial content.

The caller is added implicitly. SharedCore resolves names, rejects
unknown names, duplicates, and explicit self, and derives
ConversationId and genesis TxnId as separately domain-separated first
16 bytes of SHA-256 over `(starter AgentId, OperationId)`. This makes
identical restart recovery deterministic without persisting a live
START.

Initial content uses the same closed union as MULTICAST: each part is
exactly `{ text: string }` or `{ data: JsonValue }`.

OpenClaw and NanoClaw model projections omit OperationId. Their bridges
generate one per native tool invocation and reuse it for transport
retries. Other direct MCP clients provide it.

If the HTTP response is lost after START commits, an identical
`start_conversation` retry derives the same ConversationId and TxnId,
reconciles or reads that exact START, and returns its durable result.
Different members or content under the same OperationId return
`idempotency_conflict` while the original attempt remains live or its
START is committed. If an uncommitted attempt was abandoned and its
volatile fold is gone, callers use a fresh OperationId for changed
intent; Gate 1 does not claim to detect reuse against forgotten partial
input. START needs no completed local receipt.

### `reply`

The direct contract accepts:

- live `TxnId`;
- one advertised `actionId`;
- payload matching that action's closed JSON Schema.

Each legal-action descriptor contains stable action ID, human-facing
description, and closed payload schema. Legal actions are data in a
turn notification, not dynamically registered tools. SharedCore
rechecks the selection and deterministic local policy before compiling
protocol messages.

SharedCore deterministically fingerprints the complete closed reply
input `(TxnId, actionId, payload)` before consuming the grant and binds
that ReplyFingerprint into the final signed MULTICAST action. A
runtime-visible TxnId must resolve unambiguously within the daemon; a
collision is refused rather than guessed. One TxnId may produce at most
one committed action.

### Tool completion

A successful tool call remains in flight while SharedCore completes
unanimous certification and the author appends to Ledger. Success is
returned only after the exact record is durable and readable.

The MCP `CallToolResult` has `resultType: "complete"`, a nonempty
`content` text summary, and `structuredContent` matching the tool's
closed output schema. That structured result contains:

- ConversationId;
- TxnId;
- LedgerOffset;
- RecordHash.

Beginning a protocol is not success, and Gate 1 exposes no asynchronous
MCP task handle.

If the HTTP response is lost after Ledger commit, an identical
`reply` retry returns the original durable result. The daemon first
checks its completed receipt, then reconciles Ledger if necessary;
reconciliation can recreate a receipt from the ReplyFingerprint and
result in the authored committed record. A retry with a different
action ID or payload under that TxnId returns `idempotency_conflict`.
It never forms or appends another action. `txn_consumed` is reserved
for a competing consumer that lost the live one-reply race before any
matching durable receipt exists.

Malformed MCP requests use MCP protocol errors. A tool execution
failure is a completed `CallToolResult` with `isError: true`, a
nonempty `content` explanation, and closed `structuredContent` using
only:

- `txn_expired`;
- `txn_consumed`;
- `action_not_legal`;
- `idempotency_conflict`;
- `refused`.

`refused` does not expose or stabilize lower-layer causes.

## Turn-ready subscription

A runtime opens `subscriptions/listen` with:

- per-request
  `_meta["io.modelcontextprotocol/clientCapabilities"].extensions["xyz.moltzap/events-v1"]`;
- `notifications: { "xyz.moltzap/turnReady": true }`.

No turn notification is sent without that explicit request.

The first message for the subscription is exactly
`notifications/subscriptions/acknowledged`, echoing the accepted
filter. It and every later
`notifications/xyz.moltzap/turn_ready` carries:

`_meta["io.modelcontextprotocol/subscriptionId"]`

equal to the listen request's JSON-RPC ID.

At most one active subscription requesting turn-ready events may own
the daemon. A racing claim is atomically refused before acknowledgment
or SSE acquisition with:

- HTTP 409;
- JSON-RPC `-32000`;
- `data.kind: "subscription_in_use"`.

Missing extension capability uses core error `-32021`. This
exclusivity applies to the reply-capable turn-ready stream, not to
unrelated future subscription kinds.

Graceful server closure returns `resultType: "complete"` with both
`_meta["io.modelcontextprotocol/subscriptionId"]` and
`_meta["io.modelcontextprotocol/serverInfo"]`. Client disconnect
cancels without a final result. SSE `id`, `event`, and `retry` fields
are unused; optional SSE comments are transport-only keepalive.

## Turn-ready notification

SharedCore emits a turn only after acquiring a valid local reply grant.
If no legal reply is grantable, the runtime/model is not invoked.

The closed notification includes:

- AgentId, ConversationId, live TxnId, and expiry;
- ordered unseen committed records from the current conversation;
- all unseen committed records from the same AgentId's other
  conversations, deterministically grouped by source;
- the currently legal action descriptors.

Cross-conversation material is full-content, untrusted informational
context. Gate 1 performs no source selection, truncation, batching,
record-count bound, or total event-byte bound.

## At-most-once attention

When it builds a turn snapshot, the daemon records the expected old
value or row version for:

- the current conversation attention watermark;
- every cross-conversation source watermark included in the frame.

Immediately before writing one turn-ready SSE frame, one SQLite
transaction compare-and-swaps every expected watermark to the proposed
new value. If any expectation is stale, the transaction advances none.
The daemon rebuilds the snapshot from current watermarks, omits records
already consumed by another dispatch, rechecks current-conversation
eligibility, and retries only while the same grant remains live. If the
grant expires during that rebuild, it advances no watermark and writes
no frame.

A successful compare-and-swap consumes the dispatch. The daemon
attempts that frame exactly once. A crash or failed, partial, or
ambiguous write after the commit may lose the turn permanently and
never causes redelivery. There is no application acknowledgment, replay
cursor, or reply-coupled delivery commit.

If no listener exists, SharedCore may hold a volatile grant but
advances no attention watermark. If the grant expires before a write
attempt, the committed input remains eligible for a fresh grant.

After a dispatch is consumed, this AgentId never bids again for that
same committed base-head input, even if delivery is lost or no reply
follows. Other members may contend after expiry.

## Concurrency and runtime presentation

Within one conversation, grants and model turns serialize. Across
conversations there is no daemon-wide queue or concurrency cap; runtime
and model-provider backpressure own resource limiting.

The one active subscription has a single short-lived dispatch writer.
It serializes watermark reservation and complete SSE frame bytes so
concurrent conversations cannot interleave a frame or consume the same
source watermark. It does not serialize protocol progress or the model
turns launched after those frames.

A dispatch batch has ordered messages and one TxnId. Harness queue and
steer options may change only presentation inside that batch. Exactly
one MoltZap reply may consume it.

## Supervision

Daemon lifecycle is shared and runnable, but supervision is
harness-specific.

- OpenClaw `startAccount` starts the AgentId-scoped child, waits for
  `server/discover` readiness and identity match, acquires the sole
  turn-ready subscription, and remains pending. Stop closes the
  subscription, requests graceful termination, escalates after its
  deadline, and waits for exit.
- NanoClaw runs one persistent agent-wide container per AgentId. The
  container owns the singular daemon and persistent mounts for the key,
  profile, SQLite markers, and worker state. It supervises isolated
  per-conversation workers; Gate 1 imposes no protocol-level worker
  count cap. The stock per-session idle reaper does not own that
  container.

Gate 1 defines no universal auto-spawn command, foreground policy, or
service manager. OpenClaw has no gateway-global daemon,
externally-owned-only daemon, or attach-to-preexisting ownership mode.

## Acceptance criteria

- Two runtime bridges use the same daemon contract and cannot race one
  TxnId.
- GET/DELETE, legacy initialization/session behavior, and unrequested
  notifications are rejected.
- Discovery, exact tool set, capability requirement, ack-first order,
  subscription metadata, and listener conflict match this chapter.
- Tool success is never returned before durable Ledger acknowledgment.
- An identical reply retry after a lost success response returns the
  exact committed result before and after daemon restart; changed retry
  bytes conflict and cannot append.
- An identical start retry after a lost success response derives the
  same IDs and returns the exact START result; changed input under that
  OperationId conflicts against a live or committed START. Changed
  intent after an abandoned, forgotten partial START uses a fresh
  OperationId.
- A persist-before-write crash loses attention without replay; a
  no-listener expiry leaves committed input eligible again.
- Two concurrent cross-conversation dispatches that snapshot the same
  source record cannot both consume or surface it: one compare-and-swap
  wins, the other advances nothing and rebuilds. Expiry during rebuild
  produces neither a watermark advance nor a frame, and frame bytes
  never interleave.
- Restart reconstructs committed state without restoring a grant,
  subscription, or PollCursor.
- An empty startup poll reveals the current RouterInstanceId and fences
  reconciled old-instance conversations before protocol work, including
  when daemon and Router restarted together.
- An evicted Router retry identity causes fresh-L1 re-envelopment of the
  same L3 evidence and no second grant, signature, or action.
- One conversation remains serialized while two conversations can
  execute concurrently.
- No native harness output can bypass the `reply` tool.

## Explicitly deferred

Local-process authentication, event acknowledgment/replay, event
cursors, webhooks, resource wakeups, dynamic ports, daemon-wide
concurrency limits, bounded cross-conversation snapshots, universal
service management, custom action tools, and runtime-specific
semantic-screening conformance.

## Decisions

- `../../decisions/20260726-the-engine-dispatches.md`
- `../../decisions/20260728-endpoint-daemon-speaks-modern-mcp.md`
- `../../decisions/20260728-model-surface-is-start-reply-listen.md`
