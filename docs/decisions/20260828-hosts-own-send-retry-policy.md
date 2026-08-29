---
status: accepted
date: 2026-08-28
decision-makers: Tapan Chugh
---

# Hosts own addressed-send retry policy

Decision provenance: [superseded host-idempotency
context](../decision-evidence/20260827-addressed-messaging-trajectory.md#addressed-messaging-groups-and-shared-meetings)
and [current decision source
gap](../decision-evidence/20260828-host-owned-retry-policy-source-gap.md).

## Context and Problem Statement

The addressed-messaging contract made a host's durable outbox identifier part
of every Client send. That coupled a communication provider to OpenClaw and
NanoClaw retry policy, required adapters to manufacture identities when a host
did not supply one, and made two host calls ambiguous: they could mean a retry
or two intentional posts.

The communication provider needs a stable identity while one post is being
certified and recovered. It does not need authority to decide whether a later
host invocation is the same user-visible action.

## Decision Outcome

Chosen: **the host decides whether to invoke send again, and every Client send
invocation creates one new post**.

The public semantic input is exactly:

```ts
interface SendInput {
  readonly to: MessageAddressInput
  readonly content: Content
}
```

Client mints a fresh opaque 32-byte `PostId` for the invocation before it
persists the immutable post intent or emits protocol traffic. That identifier
is private lifecycle bookkeeping until the post representation carries it. It
is not a caller token and does not expose a cross-invocation deduplication
contract.

Client recovery reuses the persisted `PostId` while completing that one
intent, including rebasing unchanged intent after a competing commit. A later
`send` call always mints a different `PostId`, even when its address and
content are byte-identical. Client does not infer whether the host meant to
retry, repeat, or replace an earlier call.

The adapter-only MCP `send_message` operation also accepts exactly `to` and
`content`. OpenClaw, NanoClaw, and other hosts may retry, queue, reconcile, or
decline to retry according to their own native behavior. Adapters neither
forward host queue identifiers into Client nor add a provider-owned retry or
deduplication layer.

`IdempotencyKey` and `SendError("idempotency-conflict")` leave the public
Client and MCP contracts. Stable Router request retry identity, immutable
post-intent persistence, protocol-message deduplication, and stable inbound
delivery replay remain endpoint responsibilities and are unchanged.

This record partially supersedes
`20260827-addressed-messaging-replaces-openfloor.md` only where that record
requires a host-owned idempotency key, derives `PostId` from that key, or makes
identical host calls resume one post. All address, native-session, output,
certification, durability, delivery, compatibility, and cutover outcomes in
that record remain current.

## Consequences

- One host call has one unambiguous meaning: create one addressed post.
- A host that repeats a call can create a second visible post. Avoiding that
  repetition belongs to the host workflow that decides to call again.
- Client can still recover an already-persisted in-flight intent without host
  participation because the `PostId` is retained with that intent.
- Adapters no longer depend on OpenClaw delivery queue identity or NanoClaw
  outbox row identity to satisfy the Client contract.
- The public surface and error taxonomy shrink, while Router and inbound
  delivery idempotency laws remain distinct and unchanged.
