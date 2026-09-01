---
status: partially-superseded
date: 2026-07-24
decision-makers: Tapan Chugh
superseded-by: 20260811-four-layer-endpoint-replicated-harness.md
---

# Collectives are ledger transactions, assembled by rounds over L2

Decision provenance: [compacted trajectory](../decision-evidence/20260720-20260727-v2-design-origins-trajectory.md#20260724-collectives-are-ledger-transactions).

## Supersession

One endpoint-certified action still becomes one canonical, hash-linked history
record, while proposal, acknowledgment, and vote traffic remains volatile.
OpenFloorV1, rather than storage, continues to own action eligibility and
validity.

`20260811-four-layer-endpoint-replicated-harness.md` replaces a Ledger
transaction, leader-only central commit, store-owned ordering or lock policy,
and the historical general collective profile with endpoint staging,
unanimous action certification, a separate durability certificate, and local
certified histories. The replacement record,
`docs/spec/conversation-history.md`, and `docs/spec/harness/tasks.md` own the
current action-to-history contract.

## Context and Problem Statement

Standardizing the layer interfaces forced the question the charter had
deferred: how does a collective actually execute? Two models were on
the table. In the escrow model the store opens a unit, accumulates
contributions under the turn discipline, and decides completion — a
central transaction coordinator. That model fails three ways:
contributions are turn-serialized where real collectives are
concurrent (and ordering leaks information, foreclosing sealed
exchanges); the store must know the op's participation rule to judge
completeness, making the router interpretive against clause 2; and
half-open units are exactly the cross-member coordination state the
sessionless decisions exclude.

## Considered Options

- Store-side escrow: the router brackets contributions into a unit.
- Peer certificate: contributions exchanged, one self-certifying
  record committed.
- Rounds over the multicast, ledger as a transaction chain — the
  certificate model with an explicit round structure and the ledger
  off the critical path.

## Decision Outcome

Chosen: **a collective is a transaction, assembled by rounds of
ordinary L2 multicasts and committed atomically to the ledger as one
multi-signed record.**

- **The rounds.** The leader — the current turn holder — proposes the
  collective; members acknowledge; the leader fixes the cut and opens
  the contribution round; participants contribute **concurrently**;
  each member computes the result locally (same total order, same
  pinned norm version, same deterministic function — so no message
  carries the result); members sign the transaction; the leader
  commits it. One ack round suffices — no echo or gossip — because
  L2's equivocation-infeasible total order lets every member compute
  the agreement point identically from the shared sequence, which is
  the payoff of putting ordered multicast at L2.
- **The ledger.** The transcript's canonical tier is an ordered chain
  of atomically committed, attributable transactions; the signature
  set makes each transaction self-certifying, and chained references
  make the order tamper-evident (hash chaining is the recorded
  technique). The ledger commits once per collective, so it sits off
  the rounds' critical path — "centralized DB now, blockchain later"
  becomes a substrate swap that touches no round.
- **Storage is atomic commit** (constitution clause 13, amended). The
  guarantee durable-then-deliver was carrying is atomicity: a record
  is committed for every member or for none, and an acknowledgment
  implies commitment — durable, in the conversation's total order.
  A protocol's messages are ordered and attributed but effect-free and
  never recorded: L2 delivers them and participants fold them live, so
  recovery converges on committed records without them. Whether any
  delivery precedes durability is realization — durable-then-deliver
  remains a valid v0 posture, no longer a law.
- **Leadership.** The turn holder initiates. Next-leader selection is
  open — there may be multiple eligible next leaders contending; in
  v0 the PCC turn instrument arbitrates, and a task's norms may
  define election or rotation.
- **The transcript is a pessimistic database** (refinement,
  2026-07-24). PCC and transaction semantics are one interface, and
  the lock comes first: `begin` **acquires the conversation's write
  lock** — it resolves only when the group's write discipline grants
  this writer the next turn, so observe-before-generate is holding an
  open transaction before generating; `update` stages the parts within
  it (a collective's contributions); `commit` lands the unit
  atomically at one place in the order and releases the lock;
  `abort` releases without effect. An ordinary message is the
  autocommit case. The store supplies atomicity, isolation, and the
  lock discipline; it **never judges completeness** — when to commit,
  and whether the quorum suffices, is the committer's call under the
  task's norms, which is what keeps this the opposite of the rejected
  escrow model. The rounds are this interface realized among
  distrusting parties: propose/ack realize `begin`, the contribution
  round realizes `update`s, the signature round and committing message
  realize `commit`. Lock TTLs, abort authority, participant-update
  carriage, and overlapping open transactions are the charter's.
- **The correctness skeleton** (refinement, 2026-07-24). Locks and
  effects are folds over the shared order; that order is the only
  reality. The transaction id is the hash of its BEGIN message —
  client-minted, content-bound. The grant is the fold "the ack rule
  is met by the signed ack messages following BEGIN"; the acks in the
  order are its certificate — nothing separate is minted. An update
  binds the txn id and a grant reference under its contributor's
  signature, killing replay and misbinding. The signature round signs
  the digest of (txn id, cut, update references, result): a signer
  attests exactly what it saw and computed. The store admits a commit
  without judging it; validity — quorum per the pinned norm,
  signatures verifying, result recomputing — is a deterministic fold
  every same-pinned party computes identically, so an invalid commit
  is admitted, ineffective, and evidence. Timeouts are local
  observations whose consequence — a superseding BEGIN or an abort —
  is resolved by the order: whichever grant completes first wins, and
  a late commit against a superseded grant is deterministically
  ineffective. Restart abandons the in-flight transaction and re-syncs
  from committed state — the live fold is gone with the process, and
  nothing recorded it. One effective commit per txn id — retries are
  harmless — which is also the norm compile step's idempotency key.
  Round messages are ordered and attributed but effect-free and never
  recorded: participants fold them live off L2's shared order, so
  there is nothing to prune and no retention policy to write. The
  committing message carries everything post-hoc verification needs —
  contributions, signature set, ack certificate — so no verifier ever
  re-folds the acks.
  Recorded consequences of the skeleton, settled with it: contributions
  are embedded in the committing message (references bind in the digest,
  bodies persist); one transaction is open per conversation, and
  concurrency is more conversations, never nested locks; abort is
  holder-only, the group's remedy being a superseding grant, since the
  acks are already its evidence; participants contribute as unlocked
  round messages the leader embeds; the cut is the position of the
  deciding ack, with no separate GO minted — reopened only if a norm
  needs stragglers past quorum; sealed rounds need no new mechanism
  (commit-reveal is two update waves in bodies the plane cannot read);
  and any commit or abort from the holder resolves the transaction and
  releases the lock whatever its validity, which only decides whether
  the transaction enters the canonical chain.
  The ack round is the load-bearing instrument: it is the grant fold,
  the consensus-on-the-next-speaker that dispatch discipline requires,
  and the starvation lever — honest members withhold acks from a
  monopolist — which is why unanimity cannot be a default (one faulty
  member would hold a veto) and why a norm's rule must be monotone and
  evaluated against membership at the BEGIN's offset.

The ledger is a chain of agreements, not a write-ahead log of
coordination.

**Scope consequence (2026-07-26).** The MULTICAST-only v0 scope
(`20260722-data-plane-layering.md`) existed because collective
execution was unknown. It is known now — every action is performed by
a protocol of messages and recorded once — and the machinery is
general, so v0 builds the protocol engine rather than a single
hardcoded operation. A plain utterance is the degenerate protocol; a
collective is a longer one; the same engine runs both. What the
charter still owns is the vocabulary of actions and the norm-level
parameters, not the mechanism.

Still chartered (#765): quorum rules, liveness and safety machinery,
abort and timeout semantics, sealed rounds (commit-reveal), whether
the cut is an explicit GO or the position of the deciding ack,
embedding vs referencing contributions in the transaction,
overlapping collectives, and the encryption interaction. Retention of
round traffic is no longer among them: nothing records it.

Consequences: the member write surface is `send` (autocommit) plus
the transaction verbs; the committed log advances one unit per
transaction; no completeness judgment exists anywhere in the store;
a member that missed the rounds needs only the committed chain, not
the votes; L6 evidence strengthens, since committed transactions
self-certify.
Supersedes in part: the durable-then-deliver wording of constitution
clause 13 and the storage guarantees that repeated it.

## Record changelog

Point corrections that leave the historical Decision Outcome intact.

| Date | Change |
|---|---|
| 2026-08-11 | Recorded the four-layer replacement and the exact scope this record still retains. The historical Decision Outcome is untouched; the visible Supersession section owns current applicability. |
