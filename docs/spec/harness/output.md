# Harness model output

Status: **Gate 1 normative boundary; exact Client shape deferred**

## Purpose and boundary

The runtime-facing output model has two capabilities:

- start a conversation with its initial content; or
- reply through authority bound to a live received turn.

There is no generic established-conversation send, action-authority token,
Router client, or conversation identifier that can substitute for a bound
reply.

## Conversation start

Conversation start names one or more other agents and supplies nonempty initial
content. The local agent is implicit. Identity resolution and duplicate/self
rejection finish before protocol traffic or local history staging.

START produces one unanimous action-certified genesis record whose body
contains the fixed membership and initial content. Durability then follows
`conversation-history.md`. There is no empty conversation, second initial
send, central append, product receipt, or `LedgerOffset`.

The final public start-operation identity and interruption/recovery contract
are deliberately unresolved. The final Client must choose either:

- an explicit stable operation identity supplied or durably retained by the
  caller; or
- a named durable Client-owned intent and recovery operation that makes
  interruption unambiguous.

It must not generate an inaccessible identity and return an ambiguous failure.
Existing compatible backing-specific identities remain in place until the
choice is admitted; they are not automatically the final public contract.

## Established-conversation reply

There is no unbound public `HarnessClient.reply` method. A live turn provides a
bound reply capability that accepts content only. The closure captures the
private grant, transaction/action selection, expiry, and retry authority
required by its backing.

The runtime supplies no TxnId, action ID, ReplyFingerprint, ConversationId,
Router identity, or generation selector. Delayed output keeps the authority of
its originating turn and cannot select a newer opportunity by conversation
identifier.

The exact raw MCP reply representation remains Client-owned. When a norm makes
more than one action legal, the payload-to-action mapping remains a task-layer
deferral; the implementation cannot guess or expose a generic send fallback.

Reading or catching up history can observe a completed reply record but cannot
reconstruct an uncommitted reply closure. Cross-process reply resumption needs
a separately admitted durable public handle and named recovery operation.

## Completion and result semantics

Start or reply succeeds only when the returning endpoint has durably stored the
complete certified record required by
[`../conversation-history.md`](../conversation-history.md). Router acceptance,
an action certificate without durability evidence, a partial vote set, or a
remote member's success is not local operation success.

The final public result remains deliberately unresolved between:

- the complete certified record; or
- a compact receipt paired with a specifically named public operation that
  retrieves and verifies the complete proof.

No implementation may return only a central offset, silently hide proof with
no retrieval path, or infer that the current transitional result is final.
Whichever result is selected must preserve `ConversationId`, stable
`RecordHash` correlation, complete offline verification, and the same local
success meaning.

After an action-certified record exists, identical durability retry and proof
recovery use `RecordHash`; changed record bytes cannot reuse its votes. The
earlier public attempt identity remains the separate deferral above.

## Generic send removal

No final surface contains generic send:

- no MCP tool;
- no `HarnessClient` method;
- no adapter escape hatch;
- no simulator-to-runtime authority path;
- no bespoke CLI command; and
- no compatibility alias or fallback from an expired bound reply.

Initial content exists only in START. Established output exists only through a
live bound reply and its legal task/norm action.

## Failure boundary

The final closed Client error unions remain part of the exact interface gate.
They must distinguish at least definite non-commit/refusal, invalid or expired
reply authority, identity or membership failure, local persistence failure,
quorum unavailability, Router restart/re-anchor requirement, incompatible
representation, and an ambiguous/retryable result where the selected operation
identity protocol permits one.

Unknown `Error`, raw decoder failures, credentials, private reply tokens,
partial signer maps, and network implementation causes are never stable public
errors.

## Acceptance criteria

- START atomically includes initial content and fixed membership.
- A successful operation has one complete certified record durably stored at
  the returning endpoint and no `LedgerOffset`.
- A runtime can reply only through the closure on its live turn.
- History reads, catch-up, re-anchor, and ConversationId cannot fabricate a
  reply closure.
- Generic send is absent from tools, public Client types, adapters, and runtime
  simulator inputs.
- No final public API or compatibility shim is implemented before operation
  identity/recovery and result shape are admitted.
- Plural-action grants remain blocked until the task/norm layer supplies a
  deterministic payload-only mapping.

## Deliberate deferrals

Exact public start-operation identity and recovery, complete-record versus
receipt result, cross-process reply resumption, exact closed Client errors,
plural-action payload mapping, and any client-side operation state beyond the
selected final contract.
