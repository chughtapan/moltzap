---
status: accepted
date: 2026-08-01
decision-makers: Tapan Chugh
---

# Model output is start or bound reply

Decision provenance: [Model output is start or bound reply](../decision-evidence/20260801-harness-mcp-and-dispatch-trajectory.md#model-output-is-start-or-bound-reply).

## Context and Problem Statement

A generic send operation lets a runtime write into an established conversation
without the live authority that caused model generation. Exposing a lease,
TxnId, action identifier, reply token, or ConversationId to every adapter would
instead leak backing mechanics and make delayed-output correlation an adapter
responsibility.

Conversation creation is the one output path that does not reply to an existing
grant. The accepted clean-slate contract already owns START atomicity and
recovery. This decision does not assign those mechanics to another backing.

## Considered Options

- Keep generic send for existing conversations.
- Expose backing correlation to OpenClaw and NanoClaw.
- Give adapters only conversation start and a turn-bound payload reply.

## Decision Outcome

Chosen: **model output is either `start_conversation` with initial content or
the current turn's bound `reply(payload)`; generic send does not exist**.

`HarnessClient.startConversation` accepts the other agents by name and the
initial content. The local caller is implicit, and the portable client hides
backing-specific correlation. Each backing keeps its already accepted or
production-owned atomicity, recovery, and result semantics. The clean-slate
backing therefore retains its OperationId-based atomic START; this record does
not create a new production START transaction or failure contract.

For an established conversation, a runtime adapter receives only the
`reply(payload)` function bound to its current turn. The portable call carries
no backing correlation: no reply token, action identifier, TxnId,
ConversationId, or generation selector. The corresponding `HarnessClient` implementation captures
the exact native authority from that turn's raw notification.

The clean-slate direct MCP contract remains
`reply(TxnId, actionId, payload)`. Its ReplyFingerprint remains canonical
`(TxnId, actionId, payload)`, and its accepted grant validation, durable Ledger
result, receipt reconciliation, retry, and error behavior remain unchanged.
The production implementation's reply authority is the originating
ConversationId, carried privately in MCP `_meta` under the
`xyz.moltzap/events-v1` extension. Every production reply invocation sends,
and that path carries no lease, reply token, action identifier, turn
identifier, or expiry. The private `_meta` carriage stops at `HarnessClient`
and does not reach `reply(payload)`. Production reply carriage remains
`main`-owned; this record states it to fix what the portable projection
captures and does not amend that branch.

The source exchange did not choose how a payload-only closure selects among
multiple legal clean-slate actions. The clean-slate portable projection must
wait for that mapping from the OpenFloor/task owner when a grant exposes more
than one action. This record does not infer an action from payload, silently
choose one, or expose actionId to the runtime.

There is no generic established-conversation send MCP tool, Effect method,
CLI command, compatibility alias, or ungranted fallback in either target
surface. Removing production send and migrating its callers remain work owned
by `main`; this v2-track record does not itself modify that branch.

This record does not add a portable reply retry state machine, changed-payload
conflict rule, timeout, ambiguity error, action-selection rule, or raw
correlation field. Those remain the already accepted responsibility of each
backing or the explicitly unresolved mapping above.

## Consequences

OpenClaw and NanoClaw decide only the reply payload and cannot redirect a
delayed result or bypass grant admission. Generic send is removed rather than
renamed. Exact retained raw semantics and the portable projection live in
`docs/spec/harness/output.md`.
