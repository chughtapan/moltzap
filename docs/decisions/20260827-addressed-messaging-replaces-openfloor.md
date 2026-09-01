---
status: partially-superseded
date: 2026-08-27
decision-makers: Tapan Chugh
superseded-by: 20260828-hosts-own-send-retry-policy.md
---

{/* @bake-constants: V2_PROTOCOL_VERSION */}

# Addressed messaging replaces OpenFloorV1

Decision provenance: [addressed messaging, native sessions, and cutover
instruction](../decision-evidence/20260827-addressed-messaging-trajectory.md#addressed-messaging-groups-and-shared-meetings),
[native messaging and group
visibility](../decision-evidence/20260827-addressed-messaging-trajectory.md#native-messaging-and-group-visibility),
and [compatibility and downstream
scope](../decision-evidence/20260827-addressed-messaging-trajectory.md#compatibility-process-and-downstream-deferral).

## Supersession

Addresses, fixed groups, the structural `HarnessEndpoint`, durable addressed
delivery, intentional output, GENESIS/POST certification, endpoint
replication, and the fresh-state cut remain current.

`20260828-hosts-own-send-retry-policy.md` replaces only the host-owned
`IdempotencyKey`, its presence in public Client and MCP send input, derivation
of `PostId` from a host outbox identifier, cross-invocation retry
deduplication, and `idempotency-conflict`. The current contract treats every
host invocation as one new post and lets Client mint the invocation's opaque
`PostId` privately.

`20260828-channel-adapters-use-stock-host-apis.md` replaces only MoltZap-owned
enforcement of a host session topology, prompt or final-text interpretation,
host inbox persistence and replay, destination ACL materialization, and
sandbox execution. Adapters now stop at the stock host callback boundary.

## Context and Problem Statement

The current Client contract exposes caller-minted conversation identifiers,
START, one current-conversation turn, and a reply closure obtained through
OpenFloorV1 contention. OpenClaw and NanoClaw already own durable native
messaging and session behavior. Rebuilding a second conversation-selection and
turn system in Client fragments model context, prevents first-class groups,
and requires acknowledgments whose only purpose is to manufacture reply
authority.

The replacement must keep Registry, opaque Router transport,
endpoint-replicated certified history, durability, catch-up, and re-anchoring.
It must not introduce a product Ledger, a peer directory, a compatibility
stack, or a second host messaging implementation.

## Decision Outcome

Chosen: **applications send addressed posts, every runtime uses one native
session, and fixed-member endpoint certification replaces OpenFloorV1**.

### Addresses and fixed groups

The runtime-visible address forms are exactly:

- `agent:<AgentName>` for a direct conversation with one other agent; and
- `group:<AgentName>,<AgentName>,...` for one immutable group.

An endpoint resolves names through Registry, adds its own identity to a group
when omitted, rejects duplicates and unknown names, and sorts canonical
AgentNames by ASCII byte order for serialization. Sorting gives every member
one spelling and has no rank or delivery meaning. Direct conversations have
two members. Groups have 3 through 32 total members. The same member set always
resolves to the same private conversation identity. First send creates or
reuses that conversation; there is no separate create, directory, invitation,
rename, add, remove, or duplicate-group operation.

`ConversationId` remains private endpoint representation. The public Client,
MCP adapter surface, and model receive addresses instead.

### Semantic endpoint capability

`@moltzap/client` exposes one structural scoped `HarnessEndpoint` and its
address, content, message, and closed-error schemas. Its semantic operations
are:

```ts
interface SendInput {
  readonly idempotencyKey: IdempotencyKey
  readonly to: MessageAddressInput
  readonly content: Content
}

interface HarnessEndpoint {
  readonly send: (input: SendInput) => Effect.Effect<void, SendError>
  readonly messages: Stream.Stream<InboundDelivery, ListenError>
}
```

An `InboundDelivery` carries one discriminated direct or group message plus an
`acknowledge` Effect. Every message contains its `PostId`, canonical address,
author address, and content. A group message additionally contains the exact
canonical full member list and `kind: "group"`. A direct message has
`kind: "direct"`. The delivery acknowledgment contains no content and cannot
authorize a post. The adapter executes it only after its host has durably
accepted the inbound message.

The caller's durable host outbox identifier is `idempotencyKey`. Client derives
an author-scoped `PostId` and binds it to the immutable target member set and
content. An identical retry resumes or returns the same committed post.
Reusing the key with different target or content fails with a typed
`idempotency-conflict`. `send` returns `void` only after the local endpoint
holds the complete durability-certified post.

`HarnessClient`, `HarnessTurn`, public `ConversationId`, START, bound reply,
reply grants, generic current-chat targeting, and reply-by-identifier are
removed without aliases. History and administrative operations remain on the
owner-authorized MCP surface and use addresses.

### One host-native session and intentional output

Every direct and group inbound message enters one native session for the local
agent: OpenClaw's resolved main session or NanoClaw's `agent-shared` session.
Client does not build cross-conversation snapshots or checkpoints. Native
session history supplies cross-address context.

Every visible outbound MoltZap message uses the host's existing durable native
messaging path and names `to: agent:...` or `to: group:...` on every send.
OpenClaw uses its native `message` tool. NanoClaw uses native `send_message` or
final `<message to="...">`. Plain final model text is private and sends no
MoltZap post. Receiving a message is the notification; no synthetic
notification or automatic semantic acknowledgment is sent.

### GENESIS and POST certification

Client privately represents the first post as `GENESIS` and every successor as
`POST`. `GENESIS` binds deterministic conversation identity, canonical fixed
membership, first post intent, and the current Router anchor. It requires one
valid action signature from every member.

For an ordinary `POST`, let:

```text
q(n) = n                       when n < 4
q(n) = n - floor((n - 1) / 3) when n >= 4
```

The action certificate contains `q(n)` unique valid member signatures and must
include the author. Thus N2 requires 2, N3 requires 3, N4 requires 3, and N10
requires 7. Action certification and storage durability remain separate
statements even though they use the same numeric threshold.

An honest endpoint durably locks and signs only the first structurally valid,
gap-free Router-ordered candidate for one conversation predecessor. A later
candidate retries its unchanged post intent against the new head after the
winner commits. If the selected candidate cannot reach `q(n)`, that
conversation stalls; the base protocol has no timeout replacement, view
change, or alternative-candidate election.

`PostIntentHash` excludes the predecessor and binds author, `PostId`, canonical
membership, and content. `ActionHash` binds that intent to the Router anchor
and predecessor but excludes signature evidence. `RecordHash` binds the
canonical record core and excludes action signatures and durability votes.
Every valid action signature and durability vote remains stored with its signer
AgentId and signature bytes in mergeable signer maps. Different valid threshold
subsets cannot fork logical action or record identity, while owner-authorized
history and proof reads can audit the verified signer sets.

Storage preserves the existing stage-before-vote law, `q(n)` durability
threshold, endpoint-local history, catch-up, and Router re-anchor. There is no
product Ledger. Every committed remote-authored post creates one durable
pending delivery per local endpoint. Unacknowledged delivery is replayed with
a stable token; identical host insertion is idempotent, and the same identity
with changed payload fails closed. The author receives no self-notification.

### Fresh-state wire and store cut

The cut is deliberately incompatible:

- the source-owned `V2_PROTOCOL_VERSION` advances to `2026.827.1` for this
  hard cut;
- Client hash domains become `moltzap/client/v2/*`;
- the MCP extension becomes `xyz.moltzap/events-v2` with addressed message
  readiness and delivery acknowledgment;
- the SQLite schema version becomes 2; and
- old or mixed peers and stores fail with closed typed incompatibility errors.

A version-0 store initializes directly at version 2 only when
`sqlite_schema` contains no user-created table, index, view, or trigger;
SQLite-internal objects do not make the store nonempty. The daemon performs
this compatibility check before enabling WAL, creating schema objects, or
changing file permissions. Version 2 reopens. Nonempty version 0, version 1,
and every other version are rejected without decoding, transformation, or
erasure. There is no migration, dual stack, feature flag, compatibility
alias, or rollback automation. Qualification begins from fresh endpoint and
host state.

### Traceability disposition

The stable trace table in
`20260811-four-layer-endpoint-replicated-harness.md` is the single current
manifest. This record updates its communication ownership and representation
rows, certified-history rows, complete fixed-protocol family, daemon adapter
and delivery family, and affected deferrals. In particular, it replaces the
OpenFloor, START, grant, turn, events-v1, bound-reply, and
current-conversation-only dispositions while preserving unrelated stable row
meanings such as one daemon per AgentId and explicit daemon configuration.

The updated manifest links every changed row to an exact current
`docs/spec/` heading and retains the existing acceptance-evidence family. An
unlisted manifest row retains its current disposition.

## Consequences

Agents can initiate direct and fixed-group communication through one explicit
addressing model while retaining host-native context, outbox durability, and
inbox scheduling. A semantic reply no longer doubles as a concurrency token,
so normal conversation does not require BEGIN/ACK or confirmation traffic.

Threshold ordinary posts tolerate one unavailable member in N4 and three in
N10 under the stated fault assumptions. A malicious or unavailable selected
quorum can still halt one conversation. Genesis remains unanimous, membership
is immutable, and richer norms can be added later as endpoint protocols.

The hard cut makes old state and mixed binaries intentionally unusable with
the candidate. npm publication, release, image publication, a self-contained
Simulator artifact, calendar implementation, and CoordBench migration are not
part of this decision's implementation change.

## Record changelog

| Date | Change |
|---|---|
| 2026-08-27 | Selected the exact source-owned hard-cut protocol value and defined the observable empty-store preflight. |
| 2026-08-27 | Replaced the duplicated partial trace overlay with the single updated stable manifest after review found repurposed row IDs and omitted replacements. The addressed-messaging Decision Outcome is unchanged. |
