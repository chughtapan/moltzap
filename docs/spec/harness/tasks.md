# Tasks, norms, and OpenFloorV1

Status: **Gate 1 normative for OpenFloorV1**

## Purpose and boundary

The communication layer supplies attributed opaque delivery, fixed
conversation membership, certified history, durability, catch-up, and Router
re-anchor. The task/norm layer decides which action is legal and which member
may contend. Router never interprets that decision, and durability votes never
substitute for it.

Gate 1 ships one built-in versioned group-chat norm, `OpenFloorV1`. It does not
pre-empt a future general collective-action vocabulary.

## Fixed conversation profile

OpenFloorV1 uses:

- one immutable fixed membership epoch with at most 32 total members,
  including the sender as an explicit recipient;
- actions `START` and `MULTICAST` only;
- one action signature from every fixed member;
- a protocol-fixed 90-second contention TTL; and
- contention resolved by shared volatile Router order.

There is no ADD, LEAVE, addressed-turn rule, configurable action quorum, or
membership transition in Gate 1. The non-unanimous threshold in
`conversation-history.md` is storage durability only.

## Content

START and MULTICAST content is a nonempty immutable array of a closed union.
Each part is exactly one of:

- `{ type: "text", text: string }`; or
- `{ type: "data", value: JsonValue }`.

Canonical JSON semantics apply to `JsonValue`. Raw bytes, URLs, files,
filenames, media types, metadata, images, and audio are outside this profile.

The RFC 8785 canonical JSON encoding of the complete `Content` value is at
most 32,768 bytes for one START or MULTICAST. Client rejects oversized content
before protocol traffic and never fragments it. Derived-size conformance tests
must also prove that every maximum complete protocol artifact fits Identity's
existing 128-recipient and 262,144-body limits.

## START

`start_conversation` supplies a caller-minted `ConversationId`, the complete
fixed member set, and initial content. START has no BEGIN/ACK round. The same
identifier and byte-identical canonical peers/content resume the existing
attempt; changed canonical peers or content under that identifier conflict.

Every named member performs deterministic structural and cryptographic
validation and signs an acceptable proposal that includes its own AgentId. The
complete member signer set is the action certificate and consent evidence.

The resulting action-certified START record is conversation genesis and the
first content action. There is no committed empty conversation followed by a
separate send. Durability voting begins only after the unanimous action
certificate and `RecordHash` exist.

## Contention and automatic activation

After every certified START or MULTICAST, OpenFloorV1 marks every fixed member
protocol-eligible. The built-in daemon's automatic initiation policy is
narrower. At one endpoint it emits BEGIN only when the certified head is
durably stored locally, was authored by another fixed member, the endpoint
owns the sole active reply-capable subscription, and the private
`(ConversationId, RecordHash)` pair is not durably consumed.

The action author never automatically contends on its own START or MULTICAST.
Every subscribed non-author satisfying those conditions may emit one BEGIN.
With no listener the endpoint emits no BEGIN and persists no consumption.
Catch-up, history reads, staged evidence, certificate enrichment, and Router
re-anchor never initiate contention.

When no contention round is open:

1. any automatically active non-author may emit BEGIN against the current
   certified head;
2. the first valid BEGIN in the shared private Router order becomes the sole
   candidate;
3. later contenders remain unconsumed and wait;
4. every fixed member may ACK that exact candidate after local validation; and
5. unanimous ACK evidence creates one volatile 90-second reply grant for the
   candidate's author.

An unconsumed loser may contend again after the round expires if the activation
conditions still hold. A consumed head is never offered or bid again by that
endpoint.

The endpoint engine serializes this fold per conversation. The canonical
digest of the exact authenticated winning BEGIN message is the private
volatile key for its ACK set, grant, expiry, and reply attempt. No separate
transaction identifier exists. ACK authorizes that opportunity; it is not the
final content signature and is not durability evidence.

## Legal actions and bound reply

At grant time the task/norm layer returns the currently legal action
descriptors: stable action ID, description, and closed payload schema. The raw
endpoint protocol validates a selected descriptor again before compiling
MULTICAST.

The runtime-facing capability exposes a live bound reply rather than generic
send. The turn exposes only its conversation, verified peers, verified author,
content, and `reply(content)`. How that payload-only reply maps to a raw action
when more than one descriptor is legal remains deliberately unresolved. Client
must not guess an action, infer it from content, or expose private
action-selection machinery to work around that gap.

## Grant and action certification

After reply selection, the author sends the exact proposed MULTICAST binding
through Router. It binds:

- the conversation and immutable membership epoch;
- the current `previousRecordHash`;
- the applicable Router-epoch-anchor hash;
- the private canonical BEGIN-message digest and selected action identity
  required by the closed norm representation;
- author and deterministic content; and
- the canonical reply-input fingerprint required by OpenFloorV1.

Every fixed member independently rechecks the proposal against its winning
candidate, advertised legal action, certified base, Router epoch, and local
personal-trust decision. A member that accepts signs the complete action
binding. Exactly one valid action signature from every fixed member forms the
action certificate. Private `ActionHash` identifies the complete canonical
action certificate. It is never a runtime-facing value.

The action certificate is part of the canonical action-certified record and
therefore part of the `RecordHash` preimage. ACK evidence is not. Durability
votes sign the resulting `RecordHash` afterward and are not part of that
preimage.

## Durability completion

Durability follows [`../conversation-history.md`](../conversation-history.md):

- an honest member durably stages before voting;
- all members vote for `n < 4`, otherwise `n - f` vote where
  `f = floor((n - 1) / 3)`;
- any member may assemble and disseminate completed evidence; and
- local success requires the complete certified record durably stored at the
  returning endpoint.

The action author has no exclusive completion role. Once the action
certificate exists, author failure does not prevent another available member
from completing durability when the required votes are obtainable.

Certificate completion, duplicate vote delivery, catch-up, and signer-map
enrichment create no additional action and no runtime attention.

## TTL and no-reply behavior

Every open contention round expires 90 seconds after each member's local
observation. The value is part of the OpenFloorV1 version and is not daemon-
configuration data.

Expiry:

- abandons only volatile contention and grant state;
- creates no action-certified or certified record;
- permits fresh contention against the same certified head only for an
  unconsumed subscribed non-author; and
- rejects a late reply.

Immediately before the daemon writes the complete turn SSE frame, it durably
and atomically stores the endpoint-private `(ConversationId, RecordHash)`
consumed marker. The marker remains after a successful, failed, partial, or
ambiguous write and after restart. It prevents another offer or BEGIN for that
head at that endpoint; it is not cleared by TTL expiry. No listener means no
write attempt and no consumed marker.

There is no explicit pass, abort, renewal, adapter completion signal, or
dispute operation. A runtime turn that produces no reply releases solely
through TTL. Clock and delivery skew can reduce the effective signing window
but cannot weaken verification.

## Validity responsibility

Before signing START, ACKing BEGIN, signing a proposed action, casting a
durability vote, or producing attention, an endpoint performs the checks
applicable to that stage:

- closed structure, version, cryptographic attribution, and membership;
- current certified predecessor and Router-epoch binding;
- OpenFloorV1 eligibility and candidate precedence;
- legal action, live grant, and reply-input binding;
- deterministic lower-layer and local personal-trust checks; and
- for a durability vote, the staging law in `conversation-history.md`.

If one honest required member rejects a proposed action, the unanimous action
certificate cannot form. If every required member signs an illegal proposal,
semantic validity is outside the guarantee. Durability verification never
repairs that failure.

## Conditional liveness

OpenFloorV1 makes no fairness or starvation-freedom claim. New action progress
requires:

- the fixed members' verification material pinned or resolvable;
- one correct non-equivocating Router;
- every fixed member available for unanimous action certification within the
  effective TTL; and
- after action certification, the durability threshold available.

Because action validity is unanimous, a withholding member can halt a new
OpenFloorV1 action even though durability completion for `n >= 4` uses `n - f`.
The durability threshold improves completion after certification; it does not
change action liveness.

Router or endpoint outage can halt progress without changing already certified
history. After Router restart, no new action begins until the fixed members
complete the re-anchor protocol in `conversation-history.md`.

## Acceptance criteria

- START signs and certifies initial content as one genesis record without
  BEGIN/ACK.
- Simultaneous BEGINs select the earliest valid Router position for all honest
  members.
- A member never automatically contends on its own action, and an endpoint
  without the sole active listener neither bids nor consumes the head.
- Missing, extra, invalid, or content-mismatched action signatures cannot form
  an action certificate.
- Durability votes cannot authorize an action, and action signatures cannot
  satisfy the durability threshold.
- One honest member's action refusal prevents action certification without
  requiring Router or a storage service to understand policy.
- After certification, a non-author member can assemble and disseminate the
  complete durability evidence.
- TTL expiry creates no record and allows fresh contention only while the head
  remains unconsumed.
- A consumed head is not offered or bid again after stream failure or restart.
- Late, duplicate, and second-use replies are rejected without generic send.
- Withholding tests distinguish unanimous action-liveness failure from
  post-certification durability-threshold behavior.

## Deliberate deferrals

Dynamic membership, non-unanimous action certificates, addressed turns,
fairness, pass/abort/renewal, disputes and remedies, witness/observer
authorization, signature compression, per-action runtime tools, distributed
norm bundles, a portable executable norm-pin contract, and payload-only reply
selection when several actions are legal.
