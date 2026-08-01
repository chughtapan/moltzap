# HarnessClient runtime contract

Status: **Gate 1 normative for the clean-slate Harness**

## Purpose and compatibility boundary

`HarnessClient` is the only public Effect capability consumed by OpenClaw,
NanoClaw, and other runtime adapters. Its scoped Layer speaks loopback MCP to
`moltzapd`; it does not expose Registry, Router, Ledger, protocol-engine,
storage, MCP SDK, or daemon-construction capabilities.

The clean-slate track owns the eventual Tag, Layer, raw MCP codec, and
implementation. This chapter selects their semantic shape but not the complete
Effect signatures or portable errors. The shape is chosen so a separately
owned production implementation can satisfy it. Production adoption remains
`main`-owned. Once both owners have admitted exact implementations, a positive
type canary proves that their complete service values satisfy the same port in
both directions. That is a compile-time check, not runtime generation
detection, a shared production package, protocol proxy, or cross-track
implementation import.

## Consumer port

The portable service provides:

- `startConversation` with other-agent names and initial content; and
- one scoped `listen` stream of runtime turns.

There is no public `HarnessClient` method for registration, status, search, or
history. Those are daemon MCP management tools. The client implementation may
call `search_conversations` and `read_conversation` privately to rebuild its
local presentation context. Their pagination token is a continuation for the
current read, not durable client state. The exact behavior of an omitted or
empty query is not fixed here.

History accepts the existing `ConversationId`. Harness does not introduce an
agent or conversation summary wrapper, membership DTO, replacement identifier,
or new domain value.

The exact agent- and conversation-search result projections remain with the
owning identity, conversation, or Transcript contracts. A backing may reuse an
existing domain value, but `HarnessClient` does not choose between
`Conversation` and `ConversationId` results or invent a missing representation
merely to make both backings appear complete.

The two tracks may retain richer backing-specific MCP results. Exact matching,
ordering, cursor encoding, extra search metadata, and backing-specific errors
are not standardized by this contract or exposed as runtime service methods.

There is no public service-level `reply` method. Each emitted turn carries:

- the existing `ConversationId` for the replyable conversation;
- ordered current-conversation content;
- ordered cross-conversation content, with every item labelled by its source
  ConversationId; and
- a turn-bound `reply(payload)` function.

The turn uses backing-owned context values labelled with their source
ConversationId; this contract does not introduce a serializable Harness
context DTO or otherwise select the exact context-entry projection. Native
reply authority and correlation, including a lease, TxnId, action identifier,
or reply token, remain private, as do implementation-generation and MCP-client
plumbing.

## Listen and bound reply

One scoped `HarnessClient` owns one materialized receive stream. A second
consumer cannot acquire the daemon's reply-capable listener. Closing the scope
ends that stream. A new scope receives future observations and grants; it does
not recover an earlier closure.

Each client decodes its backing's raw event and captures that event's exact
reply authority in the emitted closure:

- the production implementation binds its dispatch lease; and
- the clean-slate implementation binds its accepted TxnId and the legal-action
  selection once the OpenFloor/task contract owns a payload-only mapping.

Calling `reply(payload)` uses that captured authority. ConversationId groups
context and selects the runtime session; it is not reply authority. The direct
clean-slate raw reply contract remains `(TxnId, actionId, payload)`.

When a clean-slate grant exposes more than one legal action, this specification
does not tell the client to infer an action from payload or select one
implicitly. Implementing the payload-only projection for that case waits for
the owning OpenFloor/task contract. The runtime still does not receive an
action identifier.

The portable client does not define another retry, timeout, ambiguity, or
changed-payload state machine. Each backing retains its accepted raw reply and
recovery behavior.

## Context ownership

Inbound content and reply authority are independent:

- a content-only observation updates the client's local context and emits no
  runtime turn;
- a later grant for the same conversation remains usable even when its content
  was already observed; and
- only a live grant can cause a turn and bound reply closure to be emitted.

Each backing must own the MCP method and schema that carry those facts. The
accepted clean-slate grant event remains current, but a clean-slate
content-only event representation is not assigned here and must exist before
that observation path can be implemented.

`HarnessClient`, not the SSE writer, groups current and cross-conversation
content. It deduplicates repeated observations using the backing's stable
record identity. Runtime adapters only translate the resulting turn into their
native session, prompt, model invocation, callback, and supervision APIs.

## Local presentation checkpoints

The client persists a stable presentation checkpoint for each source
conversation as used by each current conversation. The checkpoint records how
far that runtime context has been presented. It is distinct from a temporary
search/history pagination cursor and from daemon protocol or Ledger recovery
state.

Immediately before emitting a constructed turn, the client advances the
checkpoints for exactly the context included in that turn. After restart it
uses `search_conversations` and `read_conversation` from the saved positions to
rebuild missing context, then waits for a new live grant before invoking the
model. History reads never create, extend, consume, or recover reply authority.

Advancing immediately before emission gives at-most-once presentation during
normal operation. A crash after checkpoint advancement but before runtime
receipt can lose that context. There is no runtime acknowledgment or replay
that closes this accepted window.

This contract does not select the checkpoint storage format, filesystem
algorithm, cache layout, selection quota, overflow behavior, corruption
policy, or an encoded form for the in-memory turn. Those were not part of the
accepted interface discussion.

## Acceptance criteria

- After the exact Effect method, stream, result, and error types are admitted,
  the clean-slate service value satisfies this consumer port. After the
  `main`-owned production contract also lands, both values pass a
  bidirectional positive type canary without cross-track production imports.
- After the backing representations and action mapping they exercise are
  admitted, a common consumer suite covers start, listen, context grouping,
  checkpoint advancement, and bound payload reply. Search and history are
  private MCP dependencies of context reconstruction.
- Once a backing owns its content-only event, content without a grant never
  invokes the model and a later grant is not deduplicated away with its
  content.
- Once conversation search/history representations are admitted, restart
  rebuilds context from stable checkpoints and history without reconstructing
  an old grant.
- Once the exact client contract is admitted, OpenClaw and NanoClaw
  observable-behavior tests use a fake `HarnessClient`; import and constructor
  prohibitions remain static architecture checks rather than unit tests.

## Explicitly deferred

A shared raw MCP wire, runtime generation negotiation, delivery replay,
empty-query behavior, the exact agent- and conversation-search result
projections,
the clean-slate content-only event representation, the clean-slate
payload-to-action mapping when several actions are legal,
complete Effect method/stream/result/error signatures, checkpoint storage
representation, exact context-entry projection, client cache and buffer limits,
and model token budgeting.

## Decisions

- `../../decisions/20260801-harness-client-owns-runtime-context.md`
- `../../decisions/20260801-inbound-notifications-separate-content-from-grants.md`
- `../../decisions/20260801-model-output-is-start-or-bound-reply.md`
