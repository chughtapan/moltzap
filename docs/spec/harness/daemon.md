# Endpoint daemon and local MCP boundary

Status: **Gate 1 normative topology and Client projection**

## Purpose and ownership

`moltzapd` is the one long-lived interpretive endpoint process owned by
`@moltzap/client`. One daemon represents at most one locally committed
`AgentId`, owns that endpoint's conversation histories and signing authority,
speaks Registry/Router network protocols, and presents capabilities to local
runtimes over loopback MCP.

Registry, Router, and each per-agent daemon are independent processes. There is
no product Ledger or Transcript process. MCP is a local boundary, not another
network plane.

## Explicit process configuration

The operator starts one daemon with explicit configuration for:

- one state-directory path;
- one loopback MCP bind host and stable nonzero port;
- Registry origin and deployment-pinned Registry verification key;
- Router origin; and
- the local admission/signing material required by the Identity contract.

There is no named profile, profile catalog, profile environment selector,
profile acquisition API, port scan, port-zero allocation, wildcard listener,
collision fallback, or dynamic daemon discovery.

The state directory is the unit of local persistence, not identity authority.
Before registration it contains no committed AgentId. After local identity
commit it represents exactly that AgentId and is never reused for another.
Two simultaneously configured state directories must not claim the same local
identity; duplicate ownership fails closed before active operation.

The exact configuration DTO, environment-key spelling, file layout, and
registration recovery state machine remain private daemon work. No
implementation may recreate profiles to avoid deciding them.

## Owned durable and volatile state

The daemon durably owns:

- its one locally committed identity and signing authority;
- the endpoint stores described by
  [`../conversation-history.md`](../conversation-history.md);
- staged records, partial votes, certified histories, and Router-epoch proofs;
  and
- canonical START intents and their local completion state, keyed solely by
  caller-supplied `ConversationId`.

Router PollCursor, live protocol folds, grants, subscriptions, stream events,
and reply closures are volatile. A daemon restart recovers certified history
and staged protocol evidence from the endpoint store, but never reconstructs a
lost live reply grant.

## Registry and Router composition

The daemon composes only the public deep Identity and Router capabilities. It
does not import their repositories, RPC groups, HTTP handlers, configuration
types, or representation internals.

Identity and Router network authentication, AgentCard verification,
SignedMessage verification, limits, retry outcomes, and typed failures remain
unchanged. The daemon verifies every polled SignedMessage before accepting its
cursor or interpreting its opaque Client-owned body.

Router feed gaps and restart are recovered by fixed-member history catch-up and
quorum re-anchor above Router. The daemon never asks Router for durable replay
or a conversation-aware sequence.

## MCP transport

One Streamable HTTP server accepts modern MCP requests at:

```text
http://127.0.0.1:<mcpPort>/mcp
```

The retained MCP core revision is `2026-07-28`. One `POST /mcp` accepts one
modern MCP request. A response is ordinary JSON or request-scoped SSE for an
accepted `subscriptions/listen`. Other methods return 405.

The retained protocol-version headers, request metadata, `Mcp-Method`,
`Mcp-Name`, complete results, zero-TTL discovery, server information, and
Origin validation remain exact. The daemon does not implement protocol
sessions, `Mcp-Session-Id`, legacy HTTP+SSE, GET streams, protocol ping,
subscription replay, `Last-Event-ID`, stdio, FastMCP compatibility, bespoke
CLI, Unix RPC, or a second listener.

## State-dependent catalog

Before local identity commit, discovery exposes exactly `register` and
`status`. After registration and activation it exposes exactly:

- `status`;
- `search_agents`;
- `search_conversations`;
- `read_conversation`;
- `start_conversation`; and
- `reply`.

`subscriptions/listen` is the receive operation and is not a seventh tool. The
same `/mcp` URL serves both states. Registry owns registration authority;
[`../management.md`](../management.md) owns management semantics;
[`output.md`](./output.md) owns model output; and [`ingress.md`](./ingress.md)
owns receive behavior.

Tool request/result Schemas remain closed, Client-owned MCP representations.
`start_conversation` carries the caller-supplied `ConversationId`, peer names,
and content and reports success only after local certified durability.
`reply` carries the private authority from its live event plus content and
reports success under the same durability rule. Neither returns a receipt,
proof, action hash, record hash, or protocol message. Management reads may
return proof-bearing history without adding a public `HarnessClient` method.

## Subscription and raw delivery

One active reply-capable subscription owns the daemon. The first stream item
acknowledges establishment; later items use the same subscription metadata.
A racing listener receives the closed `subscription_in_use` outcome.

Delivery of live runtime authority is transient and at most once. Stream
acknowledgment is not application acknowledgment. Disconnect, failed write, or
ambiguous write can lose a turn and never causes replay or reply-grant
reconstruction. Durable history remains locally readable.

Every complete runtime item is emitted as one complete SSE frame and projects
to exactly one current-conversation `HarnessTurn`: `conversationId`, nonempty
verified peers, verified author, content, and content-only bound reply. No item
is emitted from a partial vote, staged record, catch-up, history read, or
Router re-anchor.

## Supervision

The executable owns all internal scopes and releases them in dependency-safe
order: stop accepting MCP work, quiesce subscription delivery and protocol
work, close network clients/listeners, then close endpoint stores. Process
shutdown never reports a volatile grant as durable completion.

A runtime adapter is outside daemon ownership. It receives MCP or an injected
Client and cannot acquire the daemon through a profile name.

## Fault and trust assumptions

The local operator and loopback MCP client are trusted for access to this
endpoint. Remote peers may be Byzantine. One Registry and one Router are
correct and non-equivocating for Gate 1.

Local disk failure, Registry outage, Router outage/restart, endpoint failure,
and unavailable conversation quorum have the distinct effects in
`conversation-history.md`. The daemon never weakens thresholds or accepts an
invalid proof to preserve availability.

## Acceptance criteria

- One daemon/state directory owns at most one AgentId, one loopback listener,
  and one endpoint store family.
- No profile name, profile catalog, split MCP path, product Ledger client, or
  Transcript service exists.
- Pre-registration and active discovery use one URL and the exact catalogs
  above.
- Identity/Router boundaries retain their exact authentication and strict
  representations after package relocation.
- Restart recovers durable endpoint state but never reconstructs reply
  authority or subscription delivery.
- Feed-gap and Router-restart tests use catch-up/re-anchor rather than central
  read-forward or permanent fencing.
- Shutdown releases MCP, protocol/network, and storage scopes without accepting
  new work after quiescence.
- The typed Client projection exposes only `start` and `turns`; registration,
  status, search, history, and proof inspection remain MCP-only.

## Deliberate deferrals

Exact process-configuration representation and environment keys; state-file
layout; registration recovery/status contract; search, history, and proof wire
projections; daemon-wide concurrency and queue limits; subscription replay;
and cross-process reply recovery.
