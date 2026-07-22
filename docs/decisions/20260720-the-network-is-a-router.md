---
status: accepted
date: 2026-07-20
decision-makers: Tapan Chugh
---

# The network is a router

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
