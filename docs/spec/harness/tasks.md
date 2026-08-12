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

- one immutable fixed membership epoch;
- actions `START` and `MULTICAST` only;
- one action signature from every fixed member;
- a protocol-fixed 90-second transaction TTL; and
- contention resolved by shared volatile Router order.

There is no ADD, LEAVE, addressed-turn rule, configurable action quorum, or
membership transition in Gate 1. The non-unanimous threshold in
`conversation-history.md` is storage durability only.

## Content

START and MULTICAST content is a nonempty array of a closed union. Each part is
exactly one of:

- `{ text: string }`; or
- `{ data: JsonValue }`.

Canonical JSON semantics apply to `JsonValue`. Raw bytes, URLs, files,
filenames, media types, metadata, images, and audio are outside this profile.

## START

`start_conversation` supplies the complete fixed member set and initial
content. START has no BEGIN/ACK round.

Every named member performs deterministic structural and cryptographic
validation and signs an acceptable proposal that includes its own AgentId. The
complete member signer set is the action certificate and consent evidence.

The resulting action-certified START record is conversation genesis and the
first content action. There is no committed empty conversation followed by a
separate send. Durability voting begins only after the unanimous action
certificate and `RecordHash` exist.

## MULTICAST eligibility and contention

After every certified START or MULTICAST, OpenFloorV1 marks every fixed member
eligible. When no transaction is open:

1. any eligible member may emit BEGIN against the current certified head;
2. the first valid BEGIN in the shared private Router order becomes the sole
   candidate;
3. later contenders wait;
4. every fixed member may ACK that exact candidate after local validation; and
5. unanimous ACK evidence creates one volatile reply grant for the candidate's
   author.

The endpoint engine serializes this fold per conversation. A grant reserves
one response opportunity and produces one private transaction identity. ACK
authorizes that opportunity; it is not the final content signature and is not
durability evidence.

## Legal actions and bound reply

At grant time the task/norm layer returns the currently legal action
descriptors: stable action ID, description, and closed payload schema. The raw
endpoint protocol validates a selected descriptor again before compiling
MULTICAST.

The runtime-facing capability exposes a live bound reply rather than generic
send. How payload-only `reply(content)` maps to a raw action when more than one
descriptor is legal remains deliberately unresolved. Client must not guess an
action, infer it from content, or expose private action-selection machinery to
work around that gap.

## Action proposal and certification

After reply selection, the author sends the exact proposed MULTICAST binding
through Router. It binds:

- the conversation and immutable membership epoch;
- the current `previousRecordHash`;
- the applicable Router-epoch-anchor hash;
- the private transaction and action identity required by the closed norm
  representation;
- author and deterministic content; and
- the canonical reply-input fingerprint required by OpenFloorV1.

Every fixed member independently rechecks the proposal against its winning
candidate, advertised legal action, certified base, Router epoch, and local
personal-trust decision. A member that accepts signs the complete action
binding. Exactly one valid action signature from every fixed member forms the
action certificate.

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

Every open transaction expires 90 seconds after each member's local
observation. The value is part of the OpenFloorV1 version and is not daemon-
configuration data.

Expiry:

- abandons only volatile contention and grant state;
- creates no action-certified or certified record;
- permits fresh contention against the same certified head; and
- rejects a late reply.

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
- Missing, extra, invalid, or content-mismatched action signatures cannot form
  an action certificate.
- Durability votes cannot authorize an action, and action signatures cannot
  satisfy the durability threshold.
- One honest member's action refusal prevents action certification without
  requiring Router or a storage service to understand policy.
- After certification, a non-author member can assemble and disseminate the
  complete durability evidence.
- TTL expiry creates no record and allows fresh contention.
- Late, duplicate, and second-use replies are rejected without generic send.
- Withholding tests distinguish unanimous action-liveness failure from
  post-certification durability-threshold behavior.

## Deliberate deferrals

Dynamic membership, non-unanimous action certificates, addressed turns,
fairness, exact public attempt recovery, pass/abort/renewal, disputes and
remedies, witness/observer authorization, signature compression, per-action
runtime tools, distributed norm bundles, a portable executable norm-pin
contract, and payload-only reply selection when several actions are legal.
