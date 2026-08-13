# Harness model output

Status: **Gate 1 normative public output boundary**

## Purpose and boundary

The runtime-facing output model has two capabilities:

- start a conversation with its initial content; or
- reply through authority bound to a live received turn.

There is no generic established-conversation send, action-authority token,
Router client, or conversation identifier that can substitute for a bound
reply.

## Conversation start

The caller creates and retains a `ConversationId`, names one or more other
agents, and supplies nonempty initial content. The local agent is implicit.
Identity resolution and duplicate/self rejection finish before protocol
traffic or local history staging.

START produces one unanimous action-certified genesis record whose body
contains the fixed membership and initial content. Durability then follows
[`../conversation-history.md`](../conversation-history.md). There is no empty
conversation, second initial send, central append, product receipt, or
`LedgerOffset`.

`ConversationId` is the sole public START and retry identity. Before protocol
work, the endpoint durably binds it to the closed canonical encoding of the
resolved peer set and initial content. An identical call resumes incomplete
work or observes the first locally completed outcome. Different canonical
peers or content under the same identifier fail with a typed intent conflict.
The Client never generates an inaccessible retry identity and exposes no
separate recovery call.

## Established-conversation reply

There is no unbound public `HarnessClient.reply` method. A live turn provides a
bound reply capability that accepts content only. The closure captures the
private BEGIN-message digest, live grant, legal-action selection, expiry, and
retry state required by its backing.

The runtime supplies no action ID, reply fingerprint, `ConversationId`, Router
identity, protocol hash, or generation selector. Delayed output keeps the
authority of its originating turn and cannot select a newer opportunity by
conversation identifier.

The exact raw MCP reply representation remains Client-owned. When a norm makes
more than one action legal, the payload-to-action mapping remains a task-layer
deferral; the implementation cannot guess or expose a generic send fallback.

Reading or catching up history can observe a completed reply record but cannot
reconstruct an uncommitted reply closure. Cross-process reply resumption is
absent. A daemon restart or lost stream loses the volatile opportunity while
leaving certified history intact.

## Completion and result semantics

`start` and bound `reply` return `void`. They succeed only when the returning
endpoint has durably stored the complete certified record required by
[`../conversation-history.md`](../conversation-history.md). Router acceptance,
an action certificate without durability evidence, a partial vote set, or a
remote member's success is not local operation success.

The Client returns no certified record, receipt, proof, action hash, record
hash, or protocol message. Proof and history inspection are explicit loopback
MCP management operations. Keeping them off the adapter-facing surface does
not weaken offline verification or local durability: the endpoint retains the
complete evidence and makes it available through its authorized management
boundary.

Private retry identity changes by protocol stage:

- before action certification, the canonical authenticated BEGIN-message
  digest identifies the volatile grant and reply attempt;
- `ActionHash` identifies the complete action certificate; and
- `RecordHash` identifies the durable record for vote collection, local
  history, catch-up, and Router re-anchor.

None is a public Client value or result. Changed bytes cannot reuse evidence
from an earlier private digest.

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

Start and reply use separate closed typed error unions. They distinguish at
least definite non-completion or refusal, changed START intent, invalid or
expired reply authority, identity or membership failure, local persistence
failure, quorum unavailability, Router restart/re-anchor requirement, and
incompatible representation wherever the caller has a different recovery
action.

Unknown `Error`, raw decoder failures, credentials, private grant keys,
partial signer maps, and network implementation causes are never stable public
errors.

## Acceptance criteria

- START atomically includes initial content and fixed membership.
- The caller retains `ConversationId` before work begins; an identical retry
  resumes, while changed peers or content conflict.
- A successful operation has one complete certified record durably stored at
  the returning endpoint and returns only `void`.
- A runtime can reply only through the closure on its live turn.
- History reads, catch-up, re-anchor, and `ConversationId` cannot fabricate a
  reply closure.
- Generic send is absent from tools, public Client types, adapters, and runtime
  simulator inputs.
- No public proof, receipt, protocol hash, or protocol message crosses the
  `HarnessClient` boundary.
- Plural-action grants remain blocked until the task/norm layer supplies a
  deterministic payload-only mapping.

## Deliberate deferrals

Cross-process reply resumption, plural-action payload mapping, and any future
public operation beyond the accepted `start` and bound-reply surface.
