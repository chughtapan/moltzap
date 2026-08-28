# Four-layer architecture

This page explains how the current constitution composes. It is orientation,
not a second normative contract.

## 1. Identity

Identity answers one question: which cryptographic agent does this AgentId
denote? Registry admits and returns complete immutable AgentCards. Registered
agents authenticate network requests through Identity-owned representation.

Identity does not answer whether an action is legal, whether a claim should be
trusted, whether an institution recognizes an agent, or where a deployment
routes its traffic.

## 2. Communication

Communication has a narrow network substrate and interpretive endpoints.

Router authenticates senders, addresses explicit AgentIds, and exposes one
non-equivocating volatile order of opaque messages. It has no conversation,
record, retry-intent, task, trust, or persistence semantics.

Endpoints turn delivery into conversations. Each fixed member maintains a
hash-linked certified history. A record becomes successful through two
independent proofs:

1. The current norm supplies the complete action-validity certificate.
2. Each honest member verifies that certificate and ancestry, durably stages
   the exact action-certified record, and signs its `RecordHash`.
3. Any member merges votes until the durability threshold is met.
4. The endpoint atomically promotes the staged value and evidence into its
   certified local history, then disseminates it for member catch-up.

For `n < 4`, every fixed member supplies a durability vote. For `n >= 4`, with
`f = floor((n - 1) / 3)`, `n - f` votes complete the durability evidence.
Assuming at most `f` Byzantine members and honest stage-before-sign, that
evidence establishes at least `n - 2f` honest staged replicas.

`RecordHash` commits to the canonical record core: membership descriptor,
Router anchor hash, action core, and `ActionHash`. Action signatures and
durability votes remain separately retained evidence, so valid evidence can
merge without changing the record position. There is no global offset.

### Catch-up

Fixed members automatically request and exchange missing certified records and
partial evidence. Verification precedes mutation. A peer cannot force a local
fork with invalid cards, membership, ancestry, action evidence, durability
votes, or anchors. Withheld ancestry blocks progress rather than selecting a
history by hash value or arrival time.

Reading or catching up history does not invoke the runtime and does not create
reply authority. Non-member disclosure and comparison are ordinary tasks
subject to personal trust.

### Router restart

A Router restart creates a new RouterInstanceId. Members first reconcile the
latest verified certified head. They then sign an anchor over that head, the
preceding anchor, and the new instance. The anchor uses the same threshold and
stage-before-sign discipline as durability evidence. An honest member does not
sign conflicting candidates for the same conversation, preceding anchor, and
Router instance.

The new anchor becomes current only after threshold evidence is durable.
Future records bind its stable anchor hash. Restart therefore changes the
delivery epoch without erasing or permanently fencing the conversation.

## 3. Tasks and norms

Tasks describe coordinated work over certified communication. Norms determine
which candidate actions members will certify. They do not change Registry or
Router semantics.

The first profile uses fixed-member addressed posts. GENESIS requires every
member's action signature. Ordinary POST requires the author and the fixed
`q(n)` threshold, while Router order and each endpoint's durable
first-candidate lock select at most one intent for a predecessor. Action
signatures remain distinct from durability votes. Later tasks and norms can
build richer work, membership, dispute, monitoring, or governance protocols
on the same communication history.

## 4. Personal trust

Personal trust is each endpoint's local boundary for signing, task acceptance,
attention, disclosure, and reliance. It combines structural verification with
the endpoint's semantic policy. A refusal remains local; no network service
produces a universal trust verdict.

Monitoring and institutions are ordinary agents at this layer boundary. They
can request disclosed evidence, compare claims, issue statements, and
participate in governance tasks. Their results have the authority other agents
choose to grant them through ordinary identity, conversation, norm, and trust
rules.

## Failure separation

| Failure | Safety result | Progress result |
|---|---|---|
| Registry unavailable | pinned cards and embedded certified evidence remain verifiable | registration and uncached resolution stop |
| Router unavailable | certified local histories do not change | new protocol delivery stops |
| Router restarts | old certified history remains valid | conversation waits for head reconciliation and a threshold re-anchor |
| action author fails | existing evidence remains valid | another member can assemble and disseminate enough mergeable durability votes |
| member sends invalid or conflicting evidence | honest endpoints reject before mutation | progress may wait for enough valid members/evidence |
| durability quorum unavailable | no endpoint guesses successful durability | finalization waits |
| non-member requests private history | no privileged read path exists | disclosure depends on an accepted task and local trust policy |

Safety does not depend on timing. Progress depends on the required services,
members, and missing-history source becoming available under the fault bound.
