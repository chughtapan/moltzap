---
status: superseded
date: 2026-07-28
decision-makers: Tapan Chugh
superseded-by: 20260827-addressed-messaging-replaces-openfloor.md
---

# The model surface is start_conversation, reply, and listen

Decision provenance: [compacted trajectory](../decision-evidence/20260728-gate-1-engineering-review-trajectory.md#20260728-model-surface-is-start-reply-listen) and [replacement decision trajectory](../decision-evidence/20260801-harness-mcp-and-dispatch-trajectory.md#model-output-is-start-or-bound-reply).

## Supersession

No portion of this model surface remains current.

`20260827-addressed-messaging-replaces-openfloor.md` replaces start and bound
reply with explicit addressed messaging through each host's native messaging
mechanism. `20260828-channel-adapters-use-stock-host-apis.md` assigns session
topology to the stock host; inbound direct and group messages retain explicit
addresses and carry no reply grant. Closed typed failures and
endpoint-certified durability are restated by the replacements and their
normative specifications.

## Context and Problem Statement

A generic send verb exposes protocol mechanics and allows generation
outside a grant. Generating one tool per action would prematurely bind
the MCP surface to a future L4 vocabulary.

## Decision Outcome

Chosen: **the model-facing tools are exactly `start_conversation` and
`reply`, delivered through one turn-ready listen subscription**.

`start_conversation` initiates the one Gate 1 genesis action. Its direct
daemon contract includes a stable OperationId. OpenClaw and NanoClaw
projections omit that plumbing, generate one OperationId per native
tool invocation, and reuse it for retries.

An identical retry after a lost START success response derives the same
ConversationId and TxnId, reads the exact committed START, and returns
the durable result. Changed members or content under the same
OperationId conflict against a live or committed START. Changed intent
after an abandoned and forgotten partial fold uses a fresh OperationId;
no local START receipt is needed.

A turn-ready notification is emitted only after SharedCore has acquired
a live reply grant. It contains the TxnId, expiry, ordered unseen
current-conversation records, deterministically grouped unseen records
from other conversations, and the currently legal actions. Each action
has a stable id, description, and closed JSON Schema.

A runtime adapter acquires the daemon's sole turn-ready
`subscriptions/listen` stream and translates each notification into
native model input.

`reply` consumes the TxnId, selects one advertised action, and supplies
its payload. SharedCore revalidates the action and local deterministic
policy before compiling protocol messages. Harness queue and steer
settings may change presentation within the granted batch but cannot
create additional replies or bypass `reply`.

Tool success is a durability acknowledgement returned only after
Ledger commit, with ConversationId, TxnId, LedgerOffset, and RecordHash.
SharedCore fingerprints the closed reply input before consuming the
grant, binds the ReplyFingerprint into the signed action, and retains a
completed receipt. If the HTTP result is lost, an identical retry
recovers the committed result, including after restart and Ledger
reconciliation. Changed action or payload bytes under the same TxnId
return `idempotency_conflict` and never create a second action.
Tool execution failures use only `txn_expired`, `txn_consumed`,
`action_not_legal`, `idempotency_conflict`, and `refused`.

## Consequences

There is no generic send, participant-side protocol verb, asynchronous
task handle, or action-specific tool generation in Gate 1. Semantic L5
screening across the local MCP boundary remains a future contract;
deterministic SharedCore validation is load-bearing now.

## Record changelog

Point corrections that leave the historical Decision Outcome intact.

| Date | Change |
|---|---|
| 2026-08-11 | Recorded the four-layer replacement and the exact scope this record still retains. The historical Decision Outcome is untouched; the visible Supersession section owns current applicability. |
| 2026-08-28 | Updated the visible Supersession lineage after `20260828-channel-adapters-use-stock-host-apis.md` assigned session topology to stock hosts. The historical Decision Outcome is untouched. |
