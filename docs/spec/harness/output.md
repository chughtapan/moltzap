# Harness model output

Status: **Gate 1 normative for the clean-slate Harness**

## Purpose and boundary

The model-facing output surface has two operations:

- start a conversation with its initial content; or
- reply through the authority bound to a received turn.

There is no generic established-conversation send. This chapter distinguishes
the portable `HarnessClient` projection from the retained clean-slate direct
MCP tools.

## Conversation start

`HarnessClient.startConversation` accepts a nonempty set of other agents by
canonical AgentName and nonempty initial content. The local agent is implicit.
It does not ask a runtime adapter for an OperationId.

The clean-slate direct MCP tool retains its accepted contract:

- it accepts the stable OperationId, other-agent names, and initial content;
- it adds the local agent, resolves and canonicalizes AgentIds, and rejects
  unknown, duplicate, or explicit-self entries;
- ConversationId and genesis TxnId retain their accepted domain-separated
  derivation;
- START commits conversation genesis and initial content as one certified
  action; and
- identical retry, changed-input conflict, durable result, and restart
  reconciliation retain the semantics in the partially superseded model
  surface ADR and `tasks.md`.

The clean-slate client creates and retains the OperationId needed by that raw
contract. The production client maps the same portable call to the
production-owned start operation. This chapter does not introduce a new shared
OperationId representation or a new production recovery protocol.

## Established-conversation reply

There is no public `HarnessClient.reply` method. A received turn exposes only:

```ts
reply(payload)
```

The closure captures the exact reply authority from that turn's
backing-specific notification. Runtime adapters provide no reply token,
LeaseId, TxnId, action identifier, ConversationId, or generation selector.

The clean-slate direct MCP tool remains exactly:

```text
reply(TxnId, actionId, payload)
```

Its ReplyFingerprint remains the canonical closed
`(TxnId, actionId, payload)` input. A runtime-visible TxnId must resolve
unambiguously within the daemon; collision is refused rather than guessed.
The grant, legal-action revalidation, deterministic policy, certificate,
Ledger append, completed receipt, identical-retry recovery, changed-input
conflict, and one-committed-action guarantee remain unchanged.

A successful raw call still returns only after durable Ledger commitment with
ConversationId, TxnId, LedgerOffset, and RecordHash. The retained clean-slate
tool errors remain:

- `txn_expired`;
- `txn_consumed`;
- `action_not_legal`;
- `idempotency_conflict`; and
- `refused`.

The portable closure hides those raw fields and results. It does not add a
second client-side join, retry, conflict, timeout, ambiguity, or receipt state
machine. The production implementation privately uses its existing dispatch
lease and production-owned completion behavior.

The transcript did not decide how `reply(payload)` maps to one action when a
clean-slate grant advertises several legal actions. Until the OpenFloor/task
owner defines that mapping, the portable clean-slate projection for that case
is not implementation-ready. The client must not infer an action from payload,
silently choose one, or expose actionId to the runtime.

## Generic send removal

No current surface contains a generic send for an established conversation:

- no MCP tool;
- no `HarnessClient` method;
- no bespoke CLI command;
- no compatibility alias; and
- no ungranted fallback from a failed or delayed bound reply.

Initial content is supplied only through conversation start. Production-line
server, protocol, client, and first-party caller removal remains work on
`main`; the clean-slate surface already has no generic send.

## Acceptance criteria

- A runtime starts a conversation using only other-agent names and initial
  content; clean-slate raw OperationId recovery remains unchanged beneath it.
- A runtime replies using only the payload closure attached to its turn when
  the backing authority identifies one action unambiguously or an owning
  payload-to-action mapping has been admitted.
- Delayed outputs keep their originating backing authority and cannot select a
  newer turn by ConversationId.
- Direct clean-slate start/reply retry, result, receipt, error, and Ledger
  conformance tests remain unchanged.
- Raw reply continues to accept `(TxnId, actionId, payload)` and no added
  ConversationId.
- Generic send is absent from the clean-slate surface. Its complete
  production-line removal is the separately tracked `main`-owned target.

## Explicitly deferred

A shared raw reply wire, a portable reply receipt, new portable error mapping,
the clean-slate payload-to-action mapping when several actions are legal, and
any client-side retry state beyond the retained backing contracts.

## Decisions

- `../../decisions/20260801-model-output-is-start-or-bound-reply.md`
- `../../decisions/20260728-model-surface-is-start-reply-listen.md`
- `../../decisions/20260728-open-floor-v1.md`
