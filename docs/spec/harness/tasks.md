# L4 — tasks, norms, and OpenFloorV1

Status: **Gate 1 normative for OpenFloorV1**

## Purpose and boundary

L3 supplies the Harness protocol engine for certified actions.
L4 decides which action is legal and which member is eligible to
contend. Router and Ledger never interpret an L4 decision.

Gate 1 ships one built-in, versioned group-chat norm:
`OpenFloorV1`. It is intentionally degenerate and does not pre-empt the
general collective-action vocabulary chartered by #765.

## Fixed conversation profile

OpenFloorV1 operates on:

- immutable MembershipEpoch 0;
- actions `START` and `MULTICAST` only;
- exact fixed-member unanimity;
- protocol-fixed 90-second transaction TTL;
- contention resolved by shared L2 order.

There is no ADD, LEAVE, ALL_GATHER, ALL_TO_ALL, addressed-turn rule,
membership recovery, or configurable quorum in Gate 1.

## ContentPartV1

START and MULTICAST content is a nonempty array of a closed union. Each
part is exactly one of:

- `{ text: string }`;
- `{ data: JsonValue }`.

Canonical JSON semantics apply to `JsonValue`. Raw bytes, URLs, files,
filenames, media types, metadata, images, and audio are not Gate 1
content.

## START

`start_conversation` supplies the complete fixed member set and initial
content. START has no BEGIN/ACK round.

Every named member's Harness performs deterministic structural and
cryptographic validation and signs a valid proposal that includes its
own AgentId. The complete set of START signatures is the consent
evidence. There is no roster pin, invitation tool, contact allowlist,
or preconsent record.

The author appends the unanimous START certificate. Its committed
record is both conversation genesis and the first content action; no
empty conversation or synthetic first reply is created.

## MULTICAST eligibility

After every committed START or MULTICAST, OpenFloorV1 marks every fixed
member eligible. Each eligible member's Harness may ask the engine to
emit BEGIN against the current committed base.

Eligibility is an L4 policy output. It is not hardcoded into Router,
Ledger, MCP delivery, or the general L3 state machine.

## Contention and grant

When no transaction is open:

1. any eligible member may emit BEGIN;
2. the first valid BEGIN in the shared private L2 order after the
   current committed Ledger head becomes the sole candidate;
3. later contenders wait;
4. every fixed member may ACK that exact candidate after local
   validation;
5. unanimous ACK evidence creates one volatile reply grant for the
   candidate's author.

The engine serializes this process per conversation. A grant reserves
one response opportunity and produces one TxnId. Exactly one `reply`
selection may consume it. An ACK authorizes that reply opportunity; it
does not sign content that has not yet been produced and is not the
final action certificate.

## Legal actions

At grant time, L4 returns the currently legal actions as descriptors:

- stable action ID;
- human-facing description;
- closed JSON Schema for the payload.

Gate 1 exposes these descriptors in the backing-specific grant notification
and uses one generic `reply(txnId, actionId, payload)` tool. SharedCore
validates the selection again before compiling MULTICAST protocol messages.

The raw clean-slate tool remains available to generic MCP clients with its
accepted schema. `HarnessClient` keeps TxnId and action selection private and
exposes only `reply(payload)` to the runtime. The source exchange did not
choose the payload-to-action mapping when more than one descriptor is legal,
so that portable projection waits for an OpenFloor/task decision rather than
guessing or exposing actionId.

Per-action MCP tools and marketplace-distributed MCP norm bundles remain
future hypotheses. They are not Gate 1 conformance surfaces.

## Action proposal and certification

After `reply`, the author compiles the selected action and sends the
exact proposed `MULTICAST` binding through L2. The proposal binds the
winning TxnId, committed base, Router instance, author, selected action,
deterministic content, and `ReplyFingerprint`, the digest of the
canonical closed `(TxnId, actionId, payload)` input.

Every fixed member independently rechecks the proposal against its live
winning candidate, the advertised legal action, and its local Harness policy.
A member also recomputes the ReplyFingerprint from the selected Gate 1
action and payload. A member that accepts signs the complete action
binding. The author may append only after collecting exactly one final
action signature from every fixed member.

ACK evidence and final action signatures are distinct protocol
evidence. Ledger mechanically verifies the final signer set and action
binding, but never reconstructs or evaluates the preceding BEGIN/ACK
grant.

## Commit notification

After Ledger acknowledges the append, a live author schedules one
best-effort commit-notice attempt as an ordinary L2 message. Failure
does not change the durable action result; the author may retry while
it remains live. A notice is only a wake-up hint; every recipient reads
the canonical Ledger record before attention. Duplicate notices are
harmless, and a lost notice is recovered by periodic Ledger
reconciliation.

There is no transactional outbox. Author failure after append may lose
all notices without changing the committed action.

## TTL and no-reply behavior

Every open transaction expires 90 seconds after each member's local
observation. The value is part of the protocol version and is not
profile-configurable.

Expiry:

- abandons only the volatile fold;
- creates no Transcript record;
- permits a fresh BEGIN against the same committed head;
- rejects a late reply.

There is no explicit pass, abort, renewal, adapter completion signal,
or dispute operation. A delivered runtime turn that produces no reply
releases solely through TTL.

Clock and delivery skew can reduce the effective signing window but
cannot violate safety.

## Validity responsibility

Before signing START, ACKing BEGIN, signing a proposed action, or
surfacing attention, a member's Harness performs the checks applicable to that
stage:

- closed structure and cryptographic attribution;
- exact conversation, epoch, Router instance, base offset, and hash;
- OpenFloorV1 eligibility and candidate precedence;
- deterministic Harness policy currently in scope.

If one honest required member rejects a proposed action under those
checks, the final certificate cannot form. Ledger verifies only the
resulting certificate mechanics. If every required member signs an
illegal proposal, semantic validity is outside the guarantee.

## Conditional liveness

OpenFloorV1 makes no fairness or starvation-freedom claim.

Progress requires:

- every fixed member's card already pinned or resolvable through the
  correct Registry;
- one correct non-equivocating Router;
- one available correct Ledger;
- every fixed member available, receiving required messages, and
  signing within the effective TTL;
- the author remaining available through append acknowledgment.

Any unavailable or withholding member can halt progress. Author failure
after collecting signatures can leave an action uncommitted because
Gate 1 has no append takeover.

Every future L4 protocol must state its membership/fault model, quorum
rule, required correct/available participants, delivery/timing
assumption, and abort/retry condition separately from safety.

## Acceptance criteria

- START commits initial content only after every named member signs and
  never emits BEGIN/ACK.
- Simultaneous BEGINs deterministically select the earliest valid
  Router position.
- A missing or extra ACK cannot form a reply grant.
- A missing, extra, or content-mismatched final action signature cannot
  form an accepted certificate.
- One honest member's policy refusal prevents commit without requiring
  Ledger to understand the policy.
- TTL expiry creates no record and allows fresh contention.
- Late, duplicate, and second-use replies are rejected.
- Withholding and author-crash tests demonstrate the documented loss of
  liveness without weakening committed-state safety.
- The registered catalog's model-output subset remains exactly
  `start_conversation` and `reply`, with no send or action-specific tool,
  regardless of legal-action descriptors.

## Explicitly deferred

Dynamic membership and membership/key-epoch transitions,
non-unanimous quorums, addressed turns, fairness, append takeover,
exact-attempt recovery, append-only dispute protocols and remedies,
pass/abort/renewal, witness or monitor history authorization, FROST
compression, per-action tools, externally distributed norm bundles, a
deterministic executable `NormPin` contract, and the #765 action
vocabulary.

## Decisions

- `../../decisions/20260801-inbound-notifications-separate-content-from-grants.md`
- `../../decisions/20260801-model-output-is-start-or-bound-reply.md`
- `../../decisions/20260728-open-floor-v1.md`
- `../../decisions/20260723-lifecycle-rides-l3.md`

## Historical inputs

- `../../decisions/20260724-norms-are-mcp-skill-bundles.md`
