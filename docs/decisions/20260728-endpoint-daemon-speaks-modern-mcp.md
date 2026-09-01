---
status: partially-superseded
date: 2026-07-28
decision-makers: Tapan Chugh
superseded-by: 20260827-addressed-messaging-replaces-openfloor.md
---

# The endpoint daemon exposes modern MCP over loopback HTTP

Decision provenance: [compacted trajectory](../decision-evidence/20260728-gate-1-engineering-review-trajectory.md#20260728-endpoint-daemon-speaks-modern-mcp) and [replacement decision trajectory](../decision-evidence/20260801-harness-mcp-and-dispatch-trajectory.md#harness-vocabulary-and-one-profile-slot-daemon).

## Supersession

The pinned MCP core and official SDK boundary, modern Streamable HTTP framing,
one loopback listener, discovery, local subscription ownership, local trust,
acknowledgment ordering, and daemon-specific supervision remain current where
they do not depend on profiles or Ledger.

`20260827-addressed-messaging-replaces-openfloor.md` retains the one
state-dependent `/mcp` endpoint and endpoint-owned certified history but
replaces current-conversation projection, reply grants, turn readiness, and
events-v1 with `HarnessEndpoint`, durable addressed delivery, and events-v2.
The current framing and daemon contract lives in that replacement record and
the normative harness specifications.

## Context and Problem Statement

The endpoint requires one runtime-facing push surface. Earlier drafts
used stdio bridges, generic MCP middleware, or experimental Events WG
methods that no longer match the pinned July 2026 MCP core.

## Decision Outcome

Chosen: **one authoritative daemon per AgentId, serving a pinned
request-scoped MCP subscription surface on loopback**.

Each named local profile has one nonzero stable `mcpPort`. Daemon and
adapter construct `http://127.0.0.1:<mcpPort>/mcp`; host and path are
fixed. Duplicate AgentId profiles, port-zero allocation, and bind
fallback are rejected. Local processes are trusted in Gate 1; the
daemon validates Origin but adds no local token.

The MCP contract pins core `2026-07-28` at commit
`5f5440bb26a62e2cf3440b92da5a667efa03b267`. It implements POST
`/mcp`, server/discover, tools/list, tools/call, and
subscriptions/listen. It does not implement initialize, protocol
sessions, GET streams, legacy SSE, cursors, replay, protocol ping, or
events/list and events/stream.

Discovery advertises
`extensions["xyz.moltzap/events-v1"]={agentId}`. A listener declares
that capability and opts into
`{"xyz.moltzap/turnReady":true}`. The daemon emits
`notifications/subscriptions/acknowledged` before
`notifications/xyz.moltzap/turn_ready`, with the core subscriptionId
metadata. Exactly one turn-ready listener owns the daemon. A racing
listener receives HTTP 409, JSON-RPC -32000, and
`data.kind="subscription_in_use"` before SSE opens; missing capability
uses -32021.

A turn snapshot records the expected old value/version of every current
and cross-conversation watermark it includes. Immediately before one
turn-ready write, one SQLite transaction compare-and-swaps all of them
or advances none. A conflict rebuilds from current watermarks while the
grant remains live; expiry during rebuild commits and writes nothing.
One short-lived dispatch writer serializes reservation and complete
frame bytes, without serializing cross-conversation protocol or model
work. After a successful reservation, failure or ambiguous delivery may
lose the turn permanently. There is no acknowledgement or replay.
Applied Ledger offsets and attention watermarks persist, together with
completed `reply` receipts needed to recover a lost reply success
response. START instead recovers from its OperationId-derived
ConversationId and TxnId. Live transactions, folds, buffers,
subscriptions, and Router cursor do not.

The signed MULTICAST action binds the ReplyFingerprint of canonical
`(TxnId, actionId, payload)`. If the HTTP response is lost after commit,
an identical retry returns the original durable result from the receipt
or after Ledger reconciliation recreates it. Changed reply bytes under
the committed TxnId conflict and cannot append again.

## Consequences

The daemon is HTTP MCP, not a stdio MCP server. Harnesses own
supervision and translation into native model input. Local
authorization, hostile-host defense, dynamic discovery, and a universal
service manager are deferred.

## Record changelog

Point corrections that leave the historical Decision Outcome intact.

| Date | Change |
|---|---|
| 2026-08-14 | Corrected the visible retained scope to match the accepted reduced `HarnessClient`: current-conversation projection remains, while presentation checkpoints do not. The historical Decision Outcome is untouched. |
| 2026-08-11 | Recorded the four-layer replacement and the exact scope this record still retains. The historical Decision Outcome is untouched; the visible Supersession section owns current applicability. |
| 2026-08-27 | Recorded events-v2 addressed delivery and transport acknowledgment in the visible supersession while retaining loopback HTTP MCP ownership. The historical Decision Outcome is untouched. |
