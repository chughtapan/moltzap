---
status: accepted
date: 2026-08-13
decision-makers: Tapan Chugh
---

# Simulator link faults perturb post-Router delivery

Decision provenance: [Simulator link-fault ordering](../decision-evidence/20260813-simulator-link-fault-ordering-trajectory.md#simulator-link-fault-ordering).

## Context and Problem Statement

The production Router gives every recipient the restriction of one
non-equivocating global order. The retained Simulator fault API also permits a
directed link policy to hold `A→B` while `C→B` progresses. If Router accepted
A's message first, preserving that fault behavior means B may observe C's
message before A's message.

The final stack puts each endpoint Client behind an independent daemon, so an
in-process fault-policy closure cannot execute inside that daemon. The cutover
therefore needs an explicit semantic boundary for retained link faults and a
private place to apply them without weakening Router, widening Client, or
giving an application runtime network authority.

## Decision Outcome

Chosen: **an explicitly activated Simulator link-fault scope may perturb a
recipient's post-Router delivery to test endpoint recovery.**

### Guarantees

- With no active link-fault scope, Simulator delivery preserves each
  recipient's Router order and the exact `SignedMessage` bytes delivered by
  Router. This is the path used for Router-conformance evidence.
- An active directed fault scope selects deliveries by sender and recipient
  after Router has accepted and ordered them but before the recipient Client
  consumes them. It may drop, delay, hold, or reorder those
  deliveries. Reordering expressly permits a later Router delivery to reach
  that recipient before an earlier held delivery.
- Fault handling never changes a `SignedMessage`, forges one, changes Router's
  accepted order, or adds a Router callback or hook. Registry, Router, Client,
  and `moltzapd` retain their production contracts.
- A run that activates this path is fault-tolerance evidence. Recipient
  observations from that path neither prove nor disprove Router conformance.
  Router conformance runs with the fault path inactive.
- `RunLedger` may record closed Simulator fault lifecycle and public semantic
  effects. It never records or reconstructs a durable Router commit, private
  Router position, or authoritative Router order.

### Isolation

The interception and policy-evaluation mechanism is private, run-scoped
Simulator infrastructure at the recipient delivery boundary. It is not a
product service, public Router or Client extension, general compatibility
gateway, or MCP operation. A Simulator controller may operate that mechanism;
an application runtime receives no fault-control endpoint, credential,
configuration, signing material, raw Router authority, or endpoint store.

The inactive mechanism is a transparent pass-through. Tests separately prove
that inactive delivery preserves bytes and order, that each activated fault
has its declared effect, and that no runtime-facing surface can activate or
configure the mechanism.

## Consequences

- The retained directed-link fault capability can exercise Client gap,
  catch-up, retry, restart, and liveness behavior, including cross-sender
  progress past a held delivery.
- A fault test must state that it exercises endpoint tolerance and must not
  report the perturbed observation as a Router ordering failure.
- Simulator owns the extra private interposition and its run-scoped control;
  production packages and application runtimes do not gain that machinery.
- Dropped or held delivery may intentionally stop protocol progress. Existing
  safety claims continue to apply, while progress claims account for the
  activated fault.
- The five separately admitted Simulator removals remain unchanged: this
  decision restores no content-free open, generic send, message-only receive,
  runtime Router authority, or persisted Router-order event.
