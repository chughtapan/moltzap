---
status: superseded
date: 2026-07-27
decision-makers: Tapan Chugh
superseded-by: 20260729-identity-uses-jcs-jose-authenticated-http.md
---

# Registration is out of band; the plane knows one caller

Decision provenance: [compacted trajectory](../decision-evidence/20260720-20260727-v2-design-origins-trajectory.md#20260727-registration-is-out-of-band) and [replacement decision trajectory](../decision-evidence/20260729-l1-l2-implementation-trajectory.md#identity-uses-jcs-jose-and-authenticatedhttp).

## Supersession

This record is fully superseded. Registration is a concrete L1
Registry HTTP control operation, not an out-of-band library call. It is
authenticated by the `AuthenticatedHttp` bootstrap profile using a
deployment admission credential and proof of possession of the
submitted key. It remains absent from Router, Ledger, daemon MCP, and
runtime events. The current outcome is
`20260729-identity-uses-jcs-jose-authenticated-http.md`; exact behavior
and representation live in `docs/spec/identity.md` and
`docs/spec/identity-representation.md`.

## Context and Problem Statement

The spec called the CLI "the operator surface" and gave the plane two
caller classes, identities and the operator. The architecture it
described disagreed. `components.md` carried the contradiction in a
single sentence — "the operator's interface, part of the endpoint" —
where an endpoint is one agent's local stack. Of six control-plane op
families exactly one was operator-gated; the other five are the
agent's, and they include the two the system runs on: `lookup`, without
which no recipient can verify a sender, and `append`, which is how a
record lands at all now that the router records nothing. The
single-credential decision already had an agent's own card key signing
its plane requests.

So nothing decided served an operator — no layer, no guarantee, no
configuration surface — yet a caller class, a second key, and a CLI
chapter were shaped around one.

## Considered Options

- Reframe the CLI as the agent's client, keeping the operator arm to
  gate registration.
- Dissolve the arm by folding admission into L7's institutional facts,
  so registration is called by an identity whose attached facts permit
  admitting another.
- Take registration off the plane entirely: it is out of band, and the
  plane knows one caller.

## Decision Outcome

Chosen: **registration is out of band, and every control-plane request
authenticates as exactly one registered identity.**

- **The CLI is the agent's client.** A plain HTTP client plus a signer,
  using the same card key the agent signs its messages with. An agent
  drives it to resolve a peer's card, list the conversations it belongs
  to, read a transcript window after a miss, and append a committing
  message; automation drives the same requests. The invariant that the
  CLI holds no capability an ordinary signing HTTP client lacks is
  unchanged — what changes is whose client it is.
- **Registration leaves the plane.** How a deployment admits an
  identity — who submits a key, what vouching or approval precedes it —
  is deployment business the spec does not bind. The registry still
  mints and serves cards; only the minting request stops being a
  network op. This is the move the lifecycle decision already made for
  conversations (`20260723-lifecycle-rides-l3.md`): no create op, and
  genesis needs no provisioning path of its own.
- **One caller, so no `Caller`.** With no operator-gated op left, a
  two-arm caller value has nothing to distinguish: every request
  authenticates as an `AgentId`. Law L7.1 and the two-caller-class
  invariant dissolve rather than being restated, and the monitor-access
  question loses its "via the operator" option — a monitor reads as an
  identity or not at all.
- **No admission-fact machinery.** Folding admission into the attached
  facts was the near miss. It would have kept a privileged act inside
  the architecture and grown the fact vocabulary to carry it, buying
  nothing: the plane does not need to know how an identity came to
  exist, only that it does and that its card verifies. Out of band
  costs nothing and binds nothing.

Consequences: the register op family and its wire item leave the
control-plane catalog; the `Registry` port serves `lookup` and `list`,
and minting is a library call a deployment makes out of band; `cli.md`
becomes the agent's client chapter; and constitution clause 3 reads as
two surfaces of one agent — the control plane through a signing client,
the data plane through a harness channel — rather than two kinds of
user.

Supersedes in part: `20260721-single-credential.md`'s operator-key
provisioning, together with the operator-key clauses
`20260723-interim-signature-profile.md` and
`20260726-attribution-binds-to-the-message.md` carried forward with it.
The card key remains the single credential; there is simply no second
key to provision.
