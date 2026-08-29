---
status: accepted
date: 2026-08-28
decision-makers: Tapan Chugh
---

# Channel adapters use stock host APIs

Decision provenance: [current decision source
gap](../decision-evidence/20260828-stock-host-adapter-source-gap.md).

## Context and Problem Statement

The NanoClaw integration grew from a channel adapter into a host fork. Its
Simulator overlay changed the inbound callback result, destination lookup,
mailbox persistence and replay, ACL and session records, model prompt and
output behavior, and the sandbox driver. Those mechanisms belong to NanoClaw,
not to a communication provider.

MoltZap needs to project authenticated addressed messages into a host and
accept addressed output from that host. It does not need to decide how the
host persists an inbox, retries an outbox, selects model sessions, interprets
final text, resolves ACLs, or launches its model runtime.

## Decision Outcome

Chosen: **a channel integration conforms to the stock host adapter API and
does not patch the host application**.

The MoltZap channel adapter owns only these operations:

- acquire one public `HarnessEndpoint` directly or through loopback MCP;
- project canonical address, sender, content, and exact group membership into
  the stock inbound message, and publish the host's supported address and group
  metadata through its stock metadata callback;
- await successful completion of the stock inbound callback before
  acknowledging the Client delivery;
- validate the canonical `agent:` or `group:` destination supplied to the
  stock outbound callback and invoke Client send once; and
- translate closed Client and host-callback failures without exposing Client
  internals.

The inbound callback's successful completion is the adapter boundary. MoltZap
does not extend that callback with `accepted` or `pending` results and does not
inspect the host database to reinterpret success. A host that promises durable
insertion makes its stock callback complete only after that insertion. Inbox
deduplication, collision handling, and replay effects remain host behavior.

The host owns destination discovery and ACLs, session identity and context,
implicit-reply rules, model prompts, final-text behavior, inbox and outbox
persistence, retries, scheduling, and sandbox or container drivers. The
adapter does not add a destination resolver or a provider-owned database.

MoltZap carries no source patch or derived application image that changes
NanoClaw. Simulator's existing NanoClaw runtime descriptor may consume an
explicit caller-supplied digest-pinned application image, but MoltZap does not
build a forked NanoClaw host to satisfy additional behavior. A needed host
capability is adopted from a released stock version or contributed upstream.

This record partially supersedes
`20260827-addressed-messaging-replaces-openfloor.md` only where that record
makes a particular host session topology, prompt/output interpretation, or
host persistence mechanism a MoltZap-enforced integration guarantee. The
addressed Client contract, exact inbound projection, explicit outbound address
validation, Client-side stable delivery identity, certification, and endpoint
durability remain current.

## Consequences

- The NanoClaw package and its tests remain a channel adapter rather than a
  second NanoClaw implementation.
- MoltZap can prove that it waits for the stock callback and sends no early
  acknowledgment. Stronger host durability or deduplication claims require a
  stock host contract and host-owned tests.
- Session sharing, implicit replies, private finals, cross-destination lookup,
  and nested-sandbox support are not MoltZap channel guarantees.
- Removing the host overlay deletes the custom Bubblewrap driver and the
  Simulator-only NanoClaw image builder and overlay gate.
- A stock host that lacks a needed behavior may provide fewer integration
  guarantees until that behavior is available upstream; MoltZap does not hide
  the limitation behind a fork.
