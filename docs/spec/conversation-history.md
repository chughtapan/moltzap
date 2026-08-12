# Communication-owned conversation history

Status: **Gate 1 normative**

## Purpose and owner

This chapter owns the durable conversation-history contract for the
communication layer. Each fixed conversation member keeps its own durable,
ordered replica in the endpoint store owned by `@moltzap/client`.

There is no product Ledger process, Transcript service, global append API,
`LedgerOffset`, or canonical service-side copy. The Router transports opaque
messages and supplies volatile order within one Router instance; it does not
store, interpret, certify, recover, or replay conversation history.

The simulator's `RunLedger` and `@moltzap/simulator/ledger` export are run
evidence. They are not product conversation storage and are not governed by
this chapter.

## Fixed profile and vocabulary

Gate 1 conversations have one immutable fixed membership epoch. Dynamic
membership and membership-key transitions require a later protocol version.

The following terms name different facts:

- A **record body** is one canonical `START` or `MULTICAST` action and its
  `previousRecordHash`. `START` has no predecessor and atomically includes
  initial content and the complete fixed member set.
- An **action certificate** proves that the task/norm layer authorized the
  exact record body. Gate 1 `OpenFloorV1` requires one valid action signature
  from every fixed member.
- An **action-certified record** is the record body, the immutable membership
  verification descriptor, the applicable Router-epoch-anchor hash, and the
  complete action certificate.
- `RecordHash` is the domain-separated hash of the complete canonical
  action-certified record, including the action-certificate bytes. It is the
  stable position in one conversation history.
- A **durability vote** is one member's signed storage attestation over one
  `RecordHash`.
- **Durability evidence** is a verified threshold set of durability votes for
  one `RecordHash`.
- A **certified record** is the action-certified record, its `RecordHash`, the
  required Router-epoch proof, and valid durability evidence.
- A **history** is one endpoint's durable hash-linked sequence of certified
  records for one authorized conversation.

Durability evidence is assembled only after `RecordHash` exists. It is never
part of the `RecordHash` preimage. Different valid threshold signer sets are
equivalent evidence for the same record and do not create different history
positions.

## Action validity is not storage durability

The task/norm layer decides whether an action is legal and produces the action
certificate. For `OpenFloorV1`, semantic validity remains unanimous. The
durability threshold below does not approve an action, weaken unanimity, or
authorize a future non-unanimous norm.

The communication layer verifies the closed action-certificate format,
bindings, exact signer set, and signatures before accepting a durability vote.
It does not reconstruct contention, evaluate content, apply personal trust, or
decide task legality. Those checks remain endpoint decisions described in
[`harness/tasks.md`](./harness/tasks.md) and
[`harness/screening.md`](./harness/screening.md).

## Staging and durability votes

An honest member performs these steps in order:

1. strictly decodes and verifies the complete action-certified record;
2. verifies membership, predecessor, action certificate, and applicable
   Router-epoch proof against its local certified head;
3. durably stages the exact canonical action-certified record and any verified
   partial evidence;
4. signs a durability vote for that `RecordHash`; and
5. disseminates the vote to the fixed members.

An honest member never signs two conflicting children of one certified head.
It never signs a record whose predecessor or Router-epoch binding it cannot
verify. These are honest-endpoint laws, not assumptions about Byzantine
members.

A durability vote is authenticated and domain-separated. Its signed binding
contains the representation version, signer `AgentId`, conversation and fixed
membership epoch, and `RecordHash`. The membership descriptor supplies the
closed verification material needed to check it without a live Registry.

## Threshold and guarantee

Let `n` be the fixed member count.

- For `n < 4`, durability evidence requires all `n` member votes.
- For `n >= 4`, let `f = floor((n - 1) / 3)`. Durability evidence requires
  `n - f` distinct valid member votes.

Durability signatures are attestations. A Byzantine signer can sign without
storing bytes, so a certificate does not prove that every signer retained the
record.

For `n >= 4`, safety assumes at most `f` Byzantine members. Under that bound
and the honest-stage-before-sign law, completed durability evidence guarantees
that at least `n - 2f` honest members durably staged the exact
action-certified record. For `n < 4`, the replicated-storage guarantee assumes
zero Byzantine members; unanimity alone cannot prove storage by a Byzantine
signer.

Success is local. A start or reply succeeds at an endpoint only after that
endpoint has durably stored the complete certified record. Success does not
claim that every fixed member already has the complete durability signer map.

## Vote dissemination and completion

Votes and partial signer maps are mergeable evidence keyed canonically by
signer `AgentId`. A member:

- rejects non-members, invalid signatures, wrong bindings, and conflicting
  votes;
- treats an identical duplicate as harmless;
- merges valid votes for the same `RecordHash` regardless of arrival order;
  and
- never replaces one record with a same-position conflicting record.

Any fixed member may assemble threshold durability evidence and redistribute
the completed certified record. Completion is not tied to the action author.
After the unanimous action certificate exists, author failure cannot prevent
another available member that obtains the threshold votes from completing and
disseminating the record.

Receiving a different valid threshold subset for an already certified
`RecordHash` enriches evidence without creating a second action, history
position, or runtime turn.

## Canonical order and local persistence

`previousRecordHash` and `RecordHash` are the canonical conversation order.
There is no numeric product offset. A local database key or page cursor adds no
authority and cannot replace either hash.

For each conversation, an endpoint store persists:

- the immutable membership verification descriptor;
- the verified Router-epoch-anchor chain;
- staged action-certified records and partial durability votes;
- certified records in predecessor order; and
- the current certified head.

The store atomically promotes staged state to a certified record and advances
the local head. Restart recovery may resume verification, vote collection, or
evidence dissemination from either durable state. It must not forget a
completed local promotion, expose a partially verified record as history, or
advance the head before the complete certified record is durable.

Gate 1 authorizes no pruning or garbage collection of certified history,
membership verification material, or Router-epoch proofs. A later retention
protocol must preserve offline verification and the catch-up guarantee before
removing any of those values.

## Fixed-member catch-up

Catch-up is automatic communication behavior for a fixed member. It is not an
application task and does not require a disclosure decision because every
fixed member is already entitled to the conversation replica.

An endpoint detecting a feed gap, restart, missing predecessor, or stale local
head requests certified ancestry from authenticated fixed-member peers. Before
mutating local state it verifies:

- the peer is in the immutable membership descriptor;
- every record hash and predecessor link;
- every action certificate and exact action signer set;
- durability evidence and its threshold;
- the complete Router-epoch proof chain; and
- that the returned sequence extends, or supplies verified ancestry for, the
  local certified head.

Invalid, duplicate, unrelated, truncated, or out-of-order data never advances
the local head. Missing or withheld ancestry causes an explicit incomplete
result and blocks progress rather than causing a guessed fork selection.

Catch-up progress requires eventual communication with at least one honest
member that retains the needed complete certified ancestry and Router-epoch
proofs. If all honest holders of required history lose it, this profile makes
no reconstruction guarantee.

A non-member audit, cross-history comparison, or disclosure request is an
ordinary task. The endpoint's personal-trust policy decides what to disclose;
there is no privileged peer-history, monitor, institution, or governance read
path.

## Router restart and re-anchoring

Router restart remains observable. The Router rejects sends bound to an old
`RouterInstanceId` and provides no durable replay. Endpoints recover above the
Router rather than permanently fencing the conversation.

Before sending a new action through a new Router instance, fixed members:

1. exchange and verify their certified heads and Router-epoch proofs;
2. select the unique verified head that is a descendant of every other
   presented valid head;
3. refuse to choose between incomparable heads or to proceed without required
   ancestry;
4. stage one re-anchor body binding the conversation, membership epoch,
   preceding anchor hash, selected `RecordHash`, and new
   `RouterInstanceId`;
5. sign that stable re-anchor-body hash; and
6. assemble and disseminate threshold re-anchor evidence.

The re-anchor threshold equals the durability threshold: all members for
`n < 4`, otherwise `n - f`. An honest member durably stages one candidate and
never signs conflicting anchors for the same conversation, membership epoch,
preceding anchor, and new Router instance.

For `n >= 4`, any two completed `n - f` re-anchor quorums intersect in more
than `f` members under the stated bound, so at least one honest member would
have to double-sign before conflicting completed anchors could exist. For
`n < 4`, the zero-Byzantine assumption and all-member threshold provide the
same non-conflict property.

An anchor becomes locally current only after its complete threshold evidence
is durable. Later action-certified records bind the stable re-anchor-body hash,
not one particular signer-map encoding. Re-anchoring does not rewrite history,
change action validity, or create runtime attention.

## Runtime-attention boundary

An endpoint may create runtime attention only from a complete certified record
and a separately live reply grant. A staged record, partial vote set,
certificate enrichment, catch-up, history read, or Router re-anchor creates no
reply authority and invokes no runtime.

Reading history never reconstructs a lost reply grant. `ConversationId` and
`RecordHash` identify facts; neither is authority to reply.

## Retry and idempotency boundary

Once an action-certified record exists, `RecordHash` is the retry and merge
identity for durability collection, completed-evidence recovery, and history
catch-up. Changed record bytes necessarily produce a different hash and cannot
reuse prior votes.

The exact public start-operation identity, interruption contract, and
cross-process reply-recovery surface of `HarnessClient` are deliberately
deferred in [`harness/client.md`](./harness/client.md). This chapter does not
select a public `OperationId`, hide one inside a client, or infer reply
authority from history.

## Fault, safety, and progress matrix

| Condition | Safety and verification | Progress |
|---|---|---|
| Registry unavailable | Existing self-contained membership and certificate verification continues; new identity lookup or registration may fail | Existing fixed conversations continue only when required AgentCards and verification material are already pinned |
| Router unavailable | Durable local history is unchanged | New actions, vote dissemination, catch-up over Router, and re-anchoring may halt |
| Router restarts | Old cursors and instance-bound sends fail; certified history remains valid | The conversation resumes only after completed quorum re-anchor |
| One endpoint disk unavailable | That endpoint cannot vote, certify local success, or catch up safely | For `n >= 4`, progress may continue if all action signatures already exist and `n - f` durability voters remain; for `n < 4`, durability completion blocks |
| Up to `f` Byzantine endpoints, `n >= 4` | Action unanimity and quorum intersection retain their stated safety properties when honest members follow this chapter | Byzantine withholding may still block unanimous action certification; after certification, durability can complete with `n - f` available voters |
| Required quorum unavailable | No weaker certificate or guessed head is accepted | The operation remains incomplete |
| Honest replica set lost below the stated availability assumption | Existing proofs remain mechanically checkable where retained | Missing history is not reconstructed or fabricated |

Service availability affects progress, not the acceptance rules. An endpoint
never lowers a threshold, skips verification, or guesses an anchor to recover
liveness.

## Acceptance criteria

- `START` produces one genesis record with initial content; no empty
  conversation is committed first.
- `RecordHash` commits to the complete action certificate and excludes later
  durability evidence.
- Action-certificate and durability-vote tests prove that neither can be used
  in place of the other.
- Threshold tests cover every membership size, all-member behavior for
  `n < 4`, `f = floor((n - 1) / 3)`, and the `n - 2f` honest-replica bound.
- Honest members never vote before durable staging or for conflicting children.
- Any member can assemble equivalent threshold evidence after author failure.
- Restart tests recover staged, partially voted, and certified local states
  without duplicating a record or advancing an uncertified head.
- Catch-up accepts only verified descendant ancestry from authenticated fixed
  members and never creates runtime attention or reply authority.
- Router restart tests reject old-instance sends, block on incomparable or
  incomplete ancestry, and resume the same conversation only after a durable
  threshold re-anchor.
- Absence checks prove there is no product Ledger process, Transcript service,
  `LedgerOffset`, privileged history reader, or central conversation store.

## Explicitly deferred

Dynamic membership, non-unanimous action certificates, public observer roles,
cross-process reply resumption, a public start-operation recovery shape,
history pruning and compaction, alternate catch-up transports, end-to-end
encryption and key distribution, and non-member audit/disclosure protocols.
