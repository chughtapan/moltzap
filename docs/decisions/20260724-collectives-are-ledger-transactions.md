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
  Pre-commit round traffic is provisional and never the record;
  recovery converges on committed entries. Whether any delivery
  precedes durability is realization — durable-then-deliver remains a
  valid v0 posture, no longer a law.
- **Leadership.** The turn holder initiates. Next-leader selection is
  open — there may be multiple eligible next leaders contending; in
  v0 the PCC turn instrument arbitrates, and a task's norms may
  define election or rotation.

Still chartered (#765): quorum rules, liveness and safety machinery,
abort and timeout semantics, sealed rounds (commit-reveal), whether
the cut is an explicit GO or the position of the deciding ack,
embedding vs referencing contributions in the transaction, retention
of round traffic (register item 6), overlapping collectives, and the
encryption interaction.

Consequences: the port surface is untouched — `send` carries every
round and the store's write path stays unit-of-one, because a
committed transaction is one frame; no store bracket or escrow exists;
a member that missed the rounds needs only the chain, not the votes;
L6 evidence strengthens, since committed transactions self-certify.
Supersedes in part: the durable-then-deliver wording of constitution
clause 13 and the storage guarantees that repeated it.
