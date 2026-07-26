---
status: accepted
date: 2026-07-24
decision-makers: Tapan Chugh
---

# Collectives are ledger transactions, assembled by rounds over L2

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
  entry committed.
- Rounds over the multicast, ledger as a transaction chain — the
  certificate model with an explicit round structure and the ledger
  off the critical path.

## Decision Outcome

Chosen: **a collective is a transaction, assembled by rounds of
ordinary L2 multicasts and committed atomically to the ledger as one
multi-signed entry.**

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
  guarantee durable-then-deliver was carrying is atomicity: an entry
  is committed for every member or for none, and an acknowledgment
  implies commitment — durable, in the conversation's total order.
  Pre-commit round entries are ordered and attributed but effect-free,
  prunable once their transaction resolves; recovery converges on
  committed entries. Whether any delivery precedes durability is
  realization — durable-then-deliver remains a valid v0 posture, no
  longer a law.
- **Leadership.** The turn holder initiates. Next-leader selection is
  open — there may be multiple eligible next leaders contending; in
  v0 the PCC turn instrument arbitrates, and a task's norms may
  define election or rotation.
- **The transcript is a pessimistic database** (refinement,
  2026-07-24). PCC and transaction semantics are one interface, and
  the lock comes first: `begin` **acquires the conversation's write
  lock** — it resolves only when the group's write discipline grants
  this writer the next turn, so observe-before-generate is holding an
  open transaction before generating; `update` stages entries within
  it (a collective's contributions); `commit` lands the unit
  atomically at one place in the order and releases the lock;
  `abort` releases without effect. An ordinary message is the
  autocommit case. The store supplies atomicity, isolation, and the
  lock discipline; it **never judges completeness** — when to commit,
  and whether the quorum suffices, is the committer's call under the
  task's norms, which is what keeps this the opposite of the rejected
  escrow model. The rounds are this interface realized among
  distrusting parties: propose/ack realize `begin`, the contribution
  round realizes `update`s, the signature round and commit frame
  realize `commit`. Lock TTLs, abort authority, participant-update
  carriage, and overlapping open transactions are the charter's.
- **The correctness skeleton** (refinement, 2026-07-24). Locks and
  effects are folds over the shared order; entries are the only
  reality. The transaction id is the hash of its BEGIN frame —
  client-minted, content-bound. The grant is the fold "the ack rule
  is met by the signed ack entries following BEGIN"; the acks in the
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
  ineffective. Restart recovers lock and transaction state by
  re-folding. One effective commit per txn id — retries are
  harmless — which is also the norm compile step's idempotency key.
  Round entries are ordered, attributed, and committed like any other
  entry (the folds need them) but effect-free; once a transaction
  resolves their bodies may be dropped under the retention policy,
  while offsets and frame hashes are permanent so density and the
  chain survive. The commit frame carries everything post-hoc
  verification needs — contributions, signature set, ack
  certificate — so no verifier depends on an unpruned round entry.
  Recorded consequences of the skeleton, settled with it: contributions
  are embedded in the commit frame (references bind in the digest,
  bodies persist); one transaction is open per conversation, and
  concurrency is more conversations, never nested locks; abort is
  holder-only, the group's remedy being a superseding grant, since the
  acks are already its evidence; participants contribute as unlocked
  round entries the leader embeds; the cut is the position of the
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
embedding vs referencing contributions in the transaction, retention
of round traffic (register item 6), overlapping collectives, and the
encryption interaction.

Consequences: the member write surface is `send` (autocommit) plus
the transaction verbs; the committed log advances one unit per
transaction; no completeness judgment exists anywhere in the store;
a member that missed the rounds needs only the committed chain, not
the votes; L6 evidence strengthens, since committed transactions
self-certify.
Supersedes in part: the durable-then-deliver wording of constitution
clause 13 and the storage guarantees that repeated it.
