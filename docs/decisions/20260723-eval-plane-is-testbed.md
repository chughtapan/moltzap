---
status: accepted
date: 2026-07-23
decision-makers: Tapan Chugh
---

# The eval seam is a testbed data-plane implementation

## Context and Problem Statement

Experiments and evals need fault injection and observation, and the
data-plane doc proposed the only centralized middleware v2 would
ever carry — a seam that is hook-shaped relative to constitution
clause 2 (no hooks, no reverse callbacks), so adopting it meant
carving an explicit exception. Does the seam exist, and where?

## Considered Options

- Adopt the middleware in the plane, with the carved exception.
- No seam: transcript-read observation plus deployment-level
  injection (toxic transports, scripted counterparties).
- An alternative data-plane implementation for testing and evals.

## Decision Outcome

Chosen: **an alternative data-plane implementation, living in the
testbed**. The spec binds guarantees, not mechanisms, so a second
implementation of the same interface is already legal; the eval
plane is that implementation — same guarantees, plus envelope-level
observation with timing and fault injection bounded to the failure
envelope the semantics already tolerate. It is a lab artifact: the
production server never carries it, no production guarantee is
conditioned on it, and an experiment's use of it is part of the
run artifact the experiment publishes. Observation outside the
testbed is L6's — monitors over transcript reads and store-assigned
timing. Semantic faults remain scripted endpoints, needing no plane
help.

No centralized middleware exists; constitution clause 2 stays
absolute, and no exception is carved. The bounds drafted for the
proposed middleware (may observe, may inject, may never) survive
as the testbed implementation's rules; the v1 conformance
pattern — adversity as a suite-invocation parameter plus
scripted-counterparty faults — is its injection surface.

The machinery migrates from core to the testbed as a parallel
effort (the runtimes-to-testbed extraction, #779; phase 1 landed
2026-07-23).

Consequences: data-plane.md's open question 9 closes and its
middleware section rewrites as the testbed plane; invariant 11
simplifies to implementation-swap equivalence — replacing the
production data plane with the testbed plane changes no production
conformance outcome; the bench's observation and injection needs
are met with zero production surface.
