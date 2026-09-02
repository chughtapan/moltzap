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

Chosen: **a channel adapter conforms to the stock host API; a pinned host image
may carry only the narrow integration needed to reach that stock callback**.

The MoltZap channel adapter owns only these operations:

- acquire one public `HarnessEndpoint` directly or through loopback MCP;
- project canonical address, sender, content, and exact group membership into
  the stock inbound message, and publish the host's supported address and group
  metadata through its stock metadata callback;
- await successful completion of the stock inbound callback before
  acknowledging the Client delivery;
- bind the stock host's ordinary reply-delivery callback to the current
  inbound message's canonical address, validate the explicit `agent:` or
  `group:` input supplied to any other stock outbound callback, invoke Client
  send once per callback, and leave resolution and canonicalization to Client;
  and
- translate closed Client and host-callback failures without exposing Client
  internals.

The inbound callback's successful completion is the adapter boundary. MoltZap
does not extend that callback with `accepted` or `pending` results and does not
inspect the host database to reinterpret success. A host that promises durable
insertion makes its stock callback complete only after that insertion. Inbox
deduplication, collision handling, and replay effects remain host behavior.

The host owns friendly-name destination discovery and ACLs, session identity
and context, implicit-reply rules, inbox and outbox persistence, retries,
scheduling, and sandbox or container drivers. The adapter does not add a
destination resolver or a provider-owned database.

The pinned NanoClaw image has one narrow exception. Its generic `send_message`
and `<message to>` paths recognize a syntactically valid Client
`MessageAddressInput`, describe that existing capability to the model, and
queue it for the registered MoltZap channel. The host delivery loop validates
that input with Client before bypassing NanoClaw's messaging-group lookup and
named-destination ACL. Client then resolves and canonicalizes the address. A
syntactically valid explicit MoltZap address is the complete recipient input,
not a NanoClaw-owned friendly destination, so no NanoClaw destination row is
created or consulted. Reserved `agent:` and `group:` inputs take precedence
over friendly aliases.

That image integration does not change NanoClaw's channel ABI, inbound router,
inbox schema, session model, persistence or replay, retry policy, scheduling,
or sandbox driver. It does not add implicit replies, provider-owned host state,
or cross-conversation context. Other needed host capabilities come from a
released stock version or are contributed upstream.

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
- The maintained NanoClaw image builder applies and typechecks the pinned
  explicit-address bridge; it carries no broader host fork or custom sandbox
  driver.
- A stock host that lacks a needed behavior may provide fewer integration
  guarantees until that behavior is available upstream; MoltZap does not hide
  the limitation behind a fork.

## Record changelog

| Date | Change |
|---|---|
| 2026-09-01 | Allowed the pinned NanoClaw image to bridge explicit Client address inputs from its generic send surfaces to the registered stock channel callback. Friendly destination policy and all other host behavior remain NanoClaw-owned. |
| 2026-08-28 | Clarified that the stock host's ordinary current-origin reply callback and its explicitly addressed proactive callback are both forwarded once. The host still owns whether tools or final output invoke either callback, so the stock-host Decision Outcome is unchanged. |
| 2026-08-28 | Corrected proactive target validation to accept Client's explicit address-input grammar while leaving name resolution and group canonicalization to Client. The stock-host boundary remains unchanged. |
