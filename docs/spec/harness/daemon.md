# Harness daemon and local MCP boundary

Status: **Gate 1 normative for the clean-slate Harness**

## Purpose and ownership

Harness is the per-agent interpretive subsystem and the `v2/harness` deep
package. It is not a public Effect service. `moltzapd` is its one long-lived
process.

One `moltzapd` owns one named local profile slot. Before Registry commit the
slot has no AgentId. After commit it represents exactly that AgentId. The
daemon composes the existing Registry, Router, Ledger, protocol, signing, and
local-recovery capabilities for the selected backing and presents them over
loopback MCP.

Each build selects one backing through imports and Effect Layers. No process
discovers, negotiates, loads, or proxies between implementation generations at
runtime. Registry, Router, Ledger, and `moltzapd` remain independent processes;
the local MCP boundary is not another network plane.

## Profile and process

The named slot retains the accepted clean-slate profile inputs needed for its
fixed loopback port, Registry bootstrap and signer verification, agent signing
key, Router and Ledger clients, provider storage, and recovery state. This
chapter does not assign environment-variable names, a public configuration DTO,
new timeouts, new limits, or a storage algorithm.

The listener binds only `127.0.0.1` on the profile's stable nonzero MCP port.
Port zero, wildcard bind, collision fallback, and dynamic discovery remain
rejected. The fixed URLs are:

- `http://127.0.0.1:<mcpPort>/register/mcp`; and
- `http://127.0.0.1:<mcpPort>/mcp`.

The daemon owns registration presentation and active operation presentation on
that one listener. Registry still owns registration authority. Identity commit
is irreversible for the slot; a registered slot is not reused for another
AgentId. Two local profiles may not claim the same committed AgentId; duplicate
AgentId profiles are rejected. Exact Registry request, verification,
idempotency, and recovery semantics remain in `identity.md` and are not
redesigned here.

## Retained clean-slate engine mechanics

After registration, the clean-slate backing retains the previously accepted
SharedCore behavior:

- Registry resolution and immutable AgentCard caching;
- Router poll/send, instance fencing, `feed_gap` recovery, and L2 verification;
- Ledger reconciliation and committed Transcript state;
- OpenFloor protocol folds, grant acquisition, certification, and policy;
- signing authority and completed raw reply receipts; and
- durable START and reply recovery under the existing identifiers.

Router commit notices remain wake-up hints. Ledger remains authoritative for
committed conversation state. The existing RouterInstanceId fencing,
fresh-L1 retry re-envelopment, TxnId, certificate, and Ledger append contracts
are unchanged.

The daemon persists the provider-owned committed-state and completed-reply
evidence already required by those contracts. Live folds, grants,
subscriptions, buffered events, and Router PollCursor remain volatile. Client
presentation checkpoints are not daemon recovery state. The accepted raw
attention watermarks remain the at-most-once delivery boundary around the SSE
write; they no longer represent runtime presentation state. `HarnessClient`
owns that separate checkpoint boundary in `client.md`. No other engine
persistence changes follow from the separation.

The exact retained MCP behavior remains in
`../../decisions/20260728-endpoint-daemon-speaks-modern-mcp.md` under Decision
Outcome, as limited by that record's Supersession: transport and discovery,
subscription acknowledgment and ownership, raw turn-ready notification,
at-most-once attention reservation, per-conversation grant serialization, raw
frame writing, tool completion, and consumer-specific supervision. The
runtime-host queue and steer behavior retained by
`../../decisions/20260728-model-surface-is-start-reply-listen.md` remains
presentation within one granted batch. Client context presentation is governed
by the replacement decisions, not this retained list.

## MCP transport

`moltzapd` uses the accepted official MCP TypeScript SDK boundary and pinned
core revision `2026-07-28` at commit
`5f5440bb26a62e2cf3440b92da5a667efa03b267`.

One Streamable HTTP server accepts one modern MCP request per `POST` on either
fixed path. A response is ordinary JSON or request-scoped SSE for an accepted
`subscriptions/listen`. Other HTTP methods return 405. The retained protocol
version headers, request metadata, `Mcp-Method`, `Mcp-Name`, complete results,
private zero-TTL discovery, server-info metadata, and Origin validation remain
exact.

The daemon still does not implement initialize, protocol sessions,
`Mcp-Session-Id`, legacy HTTP+SSE, GET streams, protocol ping, replay,
`Last-Event-ID`, or an application delivery acknowledgment. There is no stdio
server, handwritten compatibility layer, FastMCP dependency, bespoke CLI, Unix
RPC socket, or second MCP listener.

### Paths and tools

`/register/mcp` presents `register` while the slot has no committed identity.
After registration it does not create another identity. This contract does not
add a registration-state tool catalog or decide that `status` is also exposed
on the registration path.

Once the backing is active, `/mcp` presents observational `status` and:

- `search_agents`;
- `search_conversations`;
- `read_conversation`;
- `start_conversation`; and
- `reply`.

`subscriptions/listen` is the receive operation and is not a tool. Discovery
reflects the tools that the profile can currently use. This chapter does not
add a five-state lifecycle, activation deadline, readiness-category union,
server-busy result, request-concurrency rule, or exhaustive tool-error matrix.

Registration, status, search, and history are specified in
`../management.md`. Start and raw reply are specified in `output.md`. Receive
semantics are specified in `ingress.md`.

### Retained receive extension

The clean-slate `/mcp` discovery retains
`extensions["xyz.moltzap/events-v1"] = { agentId }`. A listener declares that
capability and opts into:

```json
{ "notifications": { "xyz.moltzap/turnReady": true } }
```

The accepted acknowledgment-first sequence,
`notifications/xyz.moltzap/turn_ready` method, subscriptionId metadata, one
active listener, HTTP 409 / JSON-RPC `-32000` `subscription_in_use` result, and
missing-capability `-32021` result remain current. Backing-specific
content-only observation details are deliberately not standardized into a new
shared extension by this change.
The clean-slate backing therefore cannot add content-only delivery until its
MCP owner defines that backing-specific method and schema.

### Retained raw model output

The registered model-output subset remains `start_conversation` and `reply`,
with no send or action-specific tool. The direct clean-slate start contract
retains OperationId. The direct clean-slate reply contract retains
`(TxnId, actionId, payload)`, the canonical ReplyFingerprint over those values,
and the existing durable completion and error behavior. `HarnessClient` hides
that plumbing from OpenClaw and NanoClaw without changing the raw tools.

## Supervision

Supervision remains consumer-specific. OpenClaw owns its AgentId-scoped child
and waits for matching MCP readiness before listening. NanoClaw owns one
persistent agent-wide container and supervises its conversation workers there.
Neither constructs the backing protocol services. Gate 1 still defines no
universal service manager, dynamic attach mode, or daemon-wide worker cap.

## Fault and trust assumptions

Gate 1 assumes one correct non-equivocating Registry, one correct
non-equivocating Router, one correct durable Ledger, trusted local MCP clients,
and potentially Byzantine remote members. Service outage or local crash may
halt progress or lose transient attention, but cannot weaken committed-state
safety or create reply authority. Hostile same-host defense remains deferred.

## Acceptance criteria

- One profile slot has one fixed listener and at most one committed AgentId.
- Once each backing-owned management representation is admitted, a generic MCP
  client uses registration and operator workflows without a MoltZap CLI, Unix
  socket, stdio bridge, or second process.
- OpenClaw and NanoClaw reach the daemon only through `HarnessClient` and MCP.
- The retained MCP framing, discovery, extension, acknowledgment, listener
  conflict, raw watermark, raw start/reply, receipt, Ledger, and supervision
  tests continue to pass unchanged; client-owned presentation checkpoints have
  separate tests.
- No runtime generation detection or cross-track production import is added.

## Explicitly deferred

Local-process authentication, hostile same-host defense, remote
administration, dynamic ports, universal service management, shared raw MCP
events, exact content-only event schema, daemon-wide concurrency limits,
bounded cross-conversation snapshots, and new overload behavior.

## Decisions

- `../../decisions/20260801-harness-is-one-profile-slot-daemon.md`
- `../../decisions/20260801-harness-client-owns-runtime-context.md`
- `../../decisions/20260801-inbound-notifications-separate-content-from-grants.md`
- `../../decisions/20260728-endpoint-daemon-speaks-modern-mcp.md`
