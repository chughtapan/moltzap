---
status: accepted
date: 2026-08-31
decision-makers: Tapan Chugh
---

# Runtime addresses use at-prefixed agent names

Decision provenance: [agent address sigil
selection](../decision-evidence/20260831-runtime-address-spelling-trajectory.md#agent-address-sigil-selection).

## Context and Problem Statement

The addressed Client contract uses explicit direct and fixed-group
destinations, but its `agent:<AgentName>` spelling exposes a protocol-like
type label to runtimes and models. The cutover needs one concise public form
for an agent name while retaining explicit group destinations and all existing
membership guarantees.

## Decision Outcome

Chosen: **runtime addresses prefix every agent name with `@`**.

The exact runtime-visible forms are:

- `@<AgentName>` for a direct conversation with one other agent; and
- `group:@<AgentName>,@<AgentName>,...` for one immutable group.

The `@` sigil is address syntax and is not part of `AgentName`. Group
canonicalization continues to insert the local member, reject duplicates and
unknown names, and sort the underlying AgentNames by ASCII byte order. Every
serialized group member includes its `@` sigil.

Client accepts no `agent:` alias and no bare AgentName. A stock host reply
callback may reuse the current inbound address, while every proactive callback
still supplies one explicit direct or group address.

This record supersedes only the runtime-visible address spelling in
`20260827-addressed-messaging-replaces-openfloor.md` and
`20260828-channel-adapters-use-stock-host-apis.md`. Direct and group semantics,
fixed membership, Client-side resolution, host ownership, certification,
delivery, and retry behavior remain unchanged.

## Consequences

- Client schemas, MCP values, host projections, simulator inputs, and eval
  fixtures use the same concise spelling.
- The unreleased cutover has no compatibility parser or state migration for
  `agent:`. Development images and evaluation state using the discarded
  spelling are rebuilt.
- Private protocol membership and hash preimages continue to bind AgentNames
  and AgentIds rather than the runtime address spelling. Protocol thresholds,
  domains, and evidence formats do not change.
