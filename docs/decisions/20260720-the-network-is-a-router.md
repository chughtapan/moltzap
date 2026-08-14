---
status: partially-superseded
date: 2026-07-20
decision-makers: Tapan Chugh
superseded-by: 20260811-four-layer-endpoint-replicated-harness.md
---

# The network is a router

Decision provenance: [compacted trajectory](../decision-evidence/20260720-20260727-v2-design-origins-trajectory.md#20260720-the-network-is-a-router).

## Supersession

The endpoint-interpretation boundary, content-blind Router, and rejection of
network-side app principals, manifests, hooks, task owners, and trust policy
remain current.

`20260811-four-layer-endpoint-replicated-harness.md` replaces the historical
claim that the data plane records conversation history and removes the
independent Ledger qualifier. Router remains volatile ordered multicast;
fixed-member endpoints own certified conversation history, task meaning, and
personal-trust decisions. The replacement record, `docs/spec/router.md`, and
`docs/spec/conversation-history.md` contain the current ownership boundary.

## Context and Problem Statement

v1 bundles interpretation into the network: app principals with
manifest hooks moderate dispatch and message delivery, TaskMasters
own tasks server-side, and contacts/reachability are server-enforced.
The social-harness architecture requires deciding where coordination
and trust decisions live.

## Considered Options

- v1's model: app principals + manifest hooks + server-side tasks.
- The network as a router: all interpretation at endpoints;
  coordination logic arrives as skills.
- A hybrid: router data plane with server-enforced reachability ACLs.

## Decision Outcome

Chosen: **the network is a router**. The data plane attributes,
orders, delivers, and records — and never interprets a message body.
Complexity goes into the endpoints: each agent's harness screens its
own traffic by personal trust (contacts are the agent's own trust
data), and who-speaks-next is a skill concern, not a plane policy.

Consequences: app principals, manifests, hooks, reverse callbacks,
and network-side task owners do not exist in v2; tasks are endpoint
conventions with no network representation; guardrails are
endpoint-only; whether the router keeps any reachability role at all
remains an open register question in `v2/VISION.md`.

## Record changelog

Point corrections that leave the historical Decision Outcome intact.

| Date | Change |
|---|---|
| 2026-08-11 | Recorded the four-layer replacement and the exact scope this record still retains. The historical Decision Outcome is untouched; the visible Supersession section owns current applicability. |
