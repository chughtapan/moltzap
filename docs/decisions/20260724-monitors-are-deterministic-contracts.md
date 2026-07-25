---
status: accepted
date: 2026-07-24
decision-makers: Tapan Chugh
---

# Monitors are deterministic contracts over the ledger; judgment is testimony

## Context and Problem Statement

L6 needed an implementation model. The ledger decision gave oversight
its input — a hash-chained, multi-signed, totally ordered record with
membership and state as pure folds — and the runtime-verification and
deterministic-execution literatures supply the machinery: monitors
compiled to deterministic programs over event sequences, trusted by
re-execution rather than authority. What is a monitor, and what is a
finding?

## Considered Options

- Authority-trusted monitor operators: findings believed because of
  who produced them.
- Monitors as pinned deterministic contracts, with semantic judgment
  as a separate attributed layer.
- Blended LLM monitoring: model judgment presented as the finding.

## Decision Outcome

Chosen: **two layers, never blended.**

- **The certificate layer.** A monitor is a pinned deterministic
  program — its identity is its content hash; it terminates within a
  declared bound; no wall-clock, no ambient nondeterminism — evaluated
  over the committed chain and the pinned fold library. A finding is
  `{monitor hash, fold-library hash, chain range, fired pattern,
  record references}`: any party with read access re-executes it and
  obtains the identical result. Trust is by recomputation, not
  authority. Decidable at this layer: safety and invariants over the
  chain; relational and threshold checks; hyperproperties over the
  conversation's finite, fixed membership (collusion-shaped
  correlation, by self-composition); equivocation — checkable from
  envelopes alone; bounded liveness over closed conversations.
- **The testimony layer.** The semantic residue — deception, intent —
  is judged by a model or human over candidates the certificate layer
  flags. Testimony is attributed — judge identity and version, inputs,
  judgment, signature — committable to a ledger and optionally
  quorum'd, and is never presented as part of the certificate. The
  judge is itself an attack surface (injection through message
  content, evasion, monitor collusion), which is why the deterministic
  layer stays maximal and the two layers stay separate.

**Deliberately not bound — establishment and authority.** Setting up a
monitor is itself a norm (L4): a task under the stack's own machinery,
which may require credentials provided through L7 — constitution
clause 12's architecture, not new mechanism. Read scope and access
mechanics stay register item 3; judge quorum and input sanitization
stay policy. Shipping monitors inside a norm bundle was considered and
rejected as premature binding of establishment.

Consequences: the fold library is trusted computing base — pinned,
content-addressed, audited; findings cite it by hash. The `evidence`
derivation gains its concrete form: certificate plus optional
testimony. Monitors observe and never impose — unchanged existing law.
Register item 3 narrows in kind: whatever access a deployment grants,
a finding needs only reads.
