# HarnessClient runtime contract

Status: **Gate 1 invariant set; exact public interface deliberately blocked**

## Purpose and ownership

`HarnessClient` is the sole adapter-facing capability name. OpenClaw,
NanoClaw, and simulator runtime subjects consume an injected or MCP-backed
client; they do not construct Registry, Router, endpoint stores, protocol
folds, signing authority, or daemon processes.

Client belongs to `@moltzap/client`. There is no profile-acquisition API,
generation selector, dual backing, protocol proxy, compatibility root, or
shared implementation imported from a retired package.

## Stable capability invariants

The exact TypeScript signatures remain gated, but every admissible final shape
must satisfy these invariants:

- one client represents exactly one registered local `AgentId`;
- conversation start atomically includes initial content;
- inbound turns derive from complete certified records and separately live
  reply authority;
- a turn's reply accepts content and keeps private transaction/action authority
  hidden;
- history facts and conversation identifiers never create reply authority;
- one scoped client owns one active inbound subscription;
- no method provides generic established-conversation send; and
- public values expose no Registry/Router client, endpoint key, store handle,
  raw MCP session, or protocol fold.

The daemon tool catalog and transport live in [`../management.md`](../management.md)
and [`daemon.md`](./daemon.md). Action and durability semantics live in
[`../conversation-history.md`](../conversation-history.md), not in a second
client-side protocol.

## Start and bound reply

The final capability includes a conversation-start operation and a stream of
runtime turns. A turn carries the certified conversation fact that created its
reply opportunity and one bound reply closure when that opportunity is live.

This chapter intentionally does not freeze the start input's operation
identity/recovery field or the start/reply result type. Those choices are
separate gates below. [`output.md`](./output.md) owns their stable semantics.

At most one live reply authority exists for one conversation at one endpoint.
Different conversations may progress independently. A closure remains bound to
its originating authority; it cannot fall forward to a newer turn.

## Receive and subscription

One scoped Client owns one `subscriptions/listen` stream. Establishment
acknowledgment confirms only stream ownership. Delivery of live reply authority
is transient and at most once: there is no application acknowledgment,
subscription replay, resume cursor, `Last-Event-ID`, or reconstruction after a
lost write.

Certified history remains readable after a lost turn, but that read produces
no closure. Catch-up and re-anchor likewise produce no runtime invocation.

The exact turn fields, Stream error union, and wire-to-domain projection remain
part of the final Client interface gate.

## Deliberate interface gates

Four choices must be admitted together before implementing the final Client,
rewriting adapters, or changing Client-dependent simulator behavior.

### Operation identity and recovery

Choose whether start exposes a stable operation identity or instead uses a
named durable Client-owned intent/recovery operation. Specify interruption,
process restart, changed-input conflict, and ambiguous completion. Do not hide
an inaccessible generated identity behind an unrecoverable call.

### Turn context and checkpoints

Choose either:

- current-conversation-only context; or
- universal cross-conversation context with explicit selection, personal-trust
  filtering, size bounds, `RecordHash` checkpoints, crash window, and recovery.

Existing cross-conversation checkpoint behavior remains compatible baseline
behavior until this choice is made. It is not silently removed or declared
final by this chapter. Runtime hosts may maintain their own session memory, but
that does not decide the shared Client contract.

### Operation result

Choose whether start/reply return the complete certified record or a compact
receipt plus a named public proof-retrieval operation. Both must preserve local
success, stable `RecordHash` identity, and complete verification. A receipt
without a retrieval path is not admissible.

### Search and history methods

Choose whether `search_agents`, `search_conversations`, and
`read_conversation` remain MCP management operations only or also appear as
typed public Client methods. Their existing MCP names do not decide the public
TypeScript surface.

## Compatible behavior during the gate

Until those choices land:

- keep existing compatible consumer behavior and type canaries as a migration
  baseline;
- do not add a compatibility facade or freeze transitional method details;
- do not delete current context/checkpoint behavior merely because a
  non-normative recommendation prefers less context;
- do not expose search/history methods merely because adapters can call MCP;
  and
- do not migrate adapters or simulator contracts whose correctness depends on
  one of the four answers.

Identity/Router relocation, endpoint-history semantic work behind private
boundaries, and deletion of obsolete empty Transcript/testbed scaffolds may
proceed without selecting these public signatures.

## Error boundary

The final Client exposes closed typed errors by operation. Connection,
incompatible representation, registration state, start, listen, reply, local
persistence, durability quorum, catch-up, and re-anchor failures remain
distinguishable where callers have different recovery actions.

The final unions cannot be frozen until operation identity/result choices are
made. Unknown `Error`, raw MCP/HTTP decoder details, credentials, private reply
authority, and internal protocol state never become public error payloads.

## Acceptance criteria

- Compile-time architecture rules allow adapters to import Client public values
  only.
- One scoped client owns one subscription and releases it with its scope.
- Every emitted turn is backed by a complete certified record and a distinct
  live authority; history alone emits nothing.
- Bound reply never exposes or accepts ConversationId, TxnId, action ID, or raw
  reply token as runtime authority.
- No generic send or network-client escape hatch exists.
- Final Client, adapter, and Client-dependent simulator changes remain blocked
  until all four exact interface choices have an admitted owner and positive
  type canaries.

## Deliberate deferrals

The four gates above; exact method names beyond the stable start/turn/bound-
reply concepts; exact turn fields; exact request/result and error types;
cross-process reply resumption; context size and crash policy; and acquisition
ergonomics for injected versus MCP-backed clients.
