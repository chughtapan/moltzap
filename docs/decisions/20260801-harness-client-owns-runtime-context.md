---
status: superseded
date: 2026-08-01
decision-makers: Tapan Chugh
superseded-by: 20260827-addressed-messaging-replaces-openfloor.md
---

# HarnessClient owns runtime context

Decision provenance: [HarnessClient owns runtime context](../decision-evidence/20260801-harness-mcp-and-dispatch-trajectory.md#harnessclient-owns-runtime-context).

## Supersession

No portion of the Client-owned runtime-context contract remains current.

`20260827-addressed-messaging-replaces-openfloor.md` keeps adapters dependent
only on `@moltzap/client` but replaces `HarnessClient` with
`HarnessEndpoint`. Client delivers addressed messages and does not construct
model context. `20260828-channel-adapters-use-stock-host-apis.md` further
assigns address-to-session routing and cross-address context entirely to each
stock host; MoltZap selects no native session topology.

## Context and Problem Statement

OpenClaw and NanoClaw need one stable consumer interface while the production
and clean-slate daemons retain different dispatch, transaction, action, and
recovery mechanics. Making adapters consume either backing's raw MCP messages
would move those differences into every runtime host.

Cross-conversation context is presentation state for the local runtime. It
must not be confused with daemon-side protocol state or an SSE write.

## Considered Options

- Let each adapter construct and call backing services directly.
- Standardize one raw MCP wire for both implementations.
- Let the daemon build and consume the runtime's cross-conversation context.
- Give both adapters one compile-time-compatible client capability, implemented
  independently for each backing.

## Decision Outcome

Chosen: **`HarnessClient` is the sole adapter-facing Effect capability and owns
the runtime's context projection, local checkpoints, and bound replies**.

The clean-slate track owns its `HarnessClient` Tag, Layer, raw MCP codec, and
implementation. The consumer shape is chosen so a separately owned production
implementation can satisfy it without a shared implementation package,
cross-track import, or runtime generation detection. Production adoption is
`main`-owned. Once both owners have admitted their contracts, their complete
service values are checked for structural compatibility in both directions at
compile time.

The two raw MCP surfaces may differ. Each client decodes its backing's existing
messages and exposes the same consumer behavior to OpenClaw and NanoClaw. No
backing-specific reply authority or correlation—such as a production lease or
clean-slate TxnId/action identifier—reaches those adapters. There is no reply
token or implementation-generation discriminator, and MCP client plumbing
stays private.

The portable runtime capability provides conversation start and one scoped
listen stream whose turns carry bound replies. Registration, status, agent and
conversation search, and conversation history remain MCP management
operations, not adapter-facing service methods. `HarnessClient` may call search
and history internally to rebuild its presentation context.

The MCP tools are named `search_agents` and `search_conversations`, not
`list_*`, and their results are paginated. Harness introduces no agent or
conversation summary wrapper, membership DTO, replacement identifier, or new
domain value.

The source exchange leaves empty-query behavior and the exact agent- and
conversation-search result projections unresolved. A backing may reuse an
already owned domain value, but a backing without one waits for its identity,
conversation, or Transcript owner. This decision does not choose between
existing `Conversation` and `ConversationId` projections, define missing
fields, or add persistence in Harness.

Every received content item identifies its source ConversationId. A backing
that does not yet own a content-only MCP method and schema must define that
representation in its owning contract before implementing this part of the
client; this decision does not invent one.
`HarnessClient` deduplicates observations, groups current and
cross-conversation context, and emits a runtime turn only when that
conversation also has live reply authority. The emitted turn carries a bound
`reply(payload)` function. A content-only observation updates local context but
does not invoke the model.

The client stores stable per-conversation presentation checkpoints locally.
After restart it uses search and history reads to rebuild context from those
positions. Pagination cursors are only continuations for the current read; they
are not the durable presentation checkpoint. Immediately before emitting a
constructed turn to the runtime, the client advances the checkpoints for the
context included in that turn. History reads rebuild context only and never
recreate reply authority.

This boundary presents context at most once during normal operation. If the
client crashes after advancing a checkpoint but before the runtime receives
the turn, that context can be lost to runtime presentation. The contract adds
no runtime acknowledgment or replay to close that accepted window.

This decision does not choose a checkpoint file format, cache algorithm,
buffer quota, overflow policy, retry matrix, portable error union, or second
serialization of an in-memory turn. Existing backing limits and failures remain
unchanged; any new choice in those areas requires a separate decision.

## Consequences

OpenClaw and NanoClaw can use either independently implemented client without
knowing the backing generation. Context presentation is client-owned, while
protocol validity, grants, durable history, and raw reply recovery remain owned
by each backing. The selected semantic consumer shape lives in
`docs/spec/harness/client.md`; its complete Effect signatures and portable
errors remain unassigned. Management semantics live in
`docs/spec/management.md`.

The production implementation work described by the non-normative slate and
issue remains under `main` authority; this v2 record does not admit its wire or
mechanics.

## Record changelog

| Date | Change |
|---|---|
| 2026-08-28 | Corrected the visible supersession lineage to include the stock-host replacement of the native-session rule. This record remains historical only. |
