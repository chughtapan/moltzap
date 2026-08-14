---
status: accepted
date: 2026-08-13
decision-makers: Tapan Chugh
---

# Client protocol and attention are endpoint-owned

Decision provenance: [Client protocol, attention, and daemon implementation](../decision-evidence/20260813-client-protocol-and-attention-trajectory.md#stable-inner-evidence-and-deferred-cross-conversation-memory), [attention correction](../decision-evidence/20260813-client-protocol-and-attention-trajectory.md#attention-selection-and-immediate-correction), and [complete implementation instruction](../decision-evidence/20260813-client-protocol-and-attention-trajectory.md#complete-implementation-plan-and-instruction).

## Context and Problem Statement

The four-layer architecture and reduced `HarnessClient` define endpoint-owned
history, START, bound reply, and transient turn delivery, but deliberately left
the exact Client evidence representation, initial Router anchor, automatic
contention trigger, raw MCP extension, daemon management representation, and
five incompatible Simulator contracts unresolved. The official MCP server SDK
also cannot express the MoltZap extension filter in its closed standard event
union.

These choices must be closed before independent daemons can interoperate and
before Simulator can provision the real four-layer stack. They must not widen
the semantic Client or restore a central Ledger, generic send, public proof,
or runtime network authority.

## Decision Outcome

Chosen: **Client owns one closed versioned endpoint protocol, durable
attention consumption, and the exact local daemon representation behind the
unchanged `HarnessClient`.**

### Evidence and transport representation

Client protocol values are exact Effect Schemas encoded as RFC 8785 canonical
JSON. Every value carries the repository `moltzapVersion` and a closed `kind`.
Private hashes use SHA-256 over the UTF-8 domain label
`moltzap/client/v1/<artifact>\0` followed by the canonical bytes. The closed
labels are `membership`, `anchor`, `action`, `record`, `begin`, `content`, and
`reply`. Hash text is canonical unpadded base64url with the owner prefix
`mbr_`, `anc_`, `ach_`, `rch_`, `bgn_`, `cnt_`, or `rpf_` respectively.

Action signatures, ACKs, durability votes, catch-up attestations, and
re-anchor votes are stable self-addressed Identity `SignedMessage` values.
Their deterministic sender-scoped `MessageId` is the first sixteen bytes of
SHA-256 over `moltzap/client/v1/evidence-message-id\0`, the signer `AgentId`,
and the canonical statement bytes. The AgentId contribution is its decoded
16-byte value followed immediately by the statement bytes. The Router
transport is a separate outer
`SignedMessage` addressed to every fixed member including its sender. An outer
message may receive a fresh random `MessageId` after
`retry_identity_unknown`; its body retains the byte-identical inner evidence.
Identity remains the only signing boundary and no generic signature API is
added.

The exact closed fields and literals for membership, anchors, START, BEGIN,
ACK, MULTICAST, action certification, durability, certified records, one-item
catch-up, and re-anchor live in
[`conversation-history.md`](../spec/conversation-history.md#exact-closed-values).
`START` and `MULTICAST` are their stable action identities. Exact signer maps
are ordered by decoded `AgentId`; duplicate identical evidence is idempotent
and conflicting evidence fails closed.

Gate 1 admits at most 32 total fixed members and at most 32,768 canonical
content bytes per START or MULTICAST. There is no fragmentation. A sender is an
explicit recipient so every member observes one Router position. Derived-size
tests must prove every complete protocol artifact remains inside Identity's
existing 128-recipient and 262,144-body limits; exceeding either Client limit
fails before traffic.

A START genesis anchor is the hash of its conversation, canonical membership
descriptor, and `RouterInstanceId` returned by an omitted-cursor Router poll.
It has no separate vote set: every member's unanimous START action signature
attests that exact anchor. A later Router instance requires the already
specified threshold re-anchor protocol.

A fixed member without a certified genesis position catches up from the exact
null/null pre-genesis position; mixed null and non-null positions are invalid.
Re-anchor votes themselves are authenticated head proposals. For one scope an
honest member stages and signs at most one candidate, and signs only a
candidate at or beyond its certified head and every later locally staged
action-certified record. No separate presentation packet or Router-order head
election exists.

### Attention activation and consumption

OpenFloor eligibility remains a protocol fact, while the built-in daemon owns
the only automatic initiation policy. A locally certified head is
automatically contention-eligible at one endpoint only when:

- the certified action was authored by another fixed member;
- that endpoint owns the sole active reply-capable subscription; and
- the endpoint has not durably consumed that `(ConversationId, RecordHash)`.

The action author never automatically contends on its own action. Every
subscribed non-author may emit one BEGIN; the first valid BEGIN in Router order
wins and unanimous ACK creates the 90-second volatile grant. An unconsumed
loser may try again after expiry.

Immediately before writing the complete turn SSE frame, the endpoint
atomically persists the private consumed pair. The pair stays consumed after
a successful, failed, or ambiguous write and after restart. It is never
offered or bid again by that endpoint. Without a listener the endpoint emits
no BEGIN and persists no consumption. Catch-up, history, staged evidence,
certificate enrichment, and re-anchor never create attention.

### Daemon, MCP, and management representation

The official pinned MCP SDK remains the standard discovery, tool, and HTTP
implementation. Because its closed event union cannot represent the admitted
MoltZap filter, Client owns a narrow request handler in front of the official
delegate. It recognizes only modern `subscriptions/listen` for
`{"xyz.moltzap/turnReady":true}`, implements sole-listener acknowledgment and
`notifications/xyz.moltzap/turn_ready`, and delegates every other request
unchanged. This is an extension adapter, not a fork or alternate MCP stack.

The `xyz.moltzap/events-v1` extension advertises the pinned Registry signer
public JWK. A turn event contains exactly `conversationId`, encoded complete
AgentCards for fixed peers and author, semantic content, and a canonical
256-bit random base64url `replyGrant`. The `reply` request carries content in
its body and that opaque grant only in extension metadata. START and reply
return the empty structured result after local certified durability.

`moltzapd` uses one SQLite database in WAL mode at
`<state-directory>/moltzapd.sqlite3`. It durably stores identity binding,
canonical START intents, membership/cards, anchors, staged records and partial
evidence, complete certified history/head, and consumed-attention pairs.
Router cursors, protocol folds, grants, subscriptions, and frames are
volatile. SQLite serialization prevents two processes from concurrently
owning the same state directory. Gate 1 makes no global lease claim for copied
directories or duplicated private keys.

Process configuration is exact:

- `MOLTZAPD_STATE_DIRECTORY`;
- `MOLTZAPD_MCP_PORT`, bound only to `127.0.0.1`;
- `MOLTZAPD_REGISTRY_ORIGIN` and
  `MOLTZAPD_REGISTRY_SIGNER_PUBLIC_KEY`;
- `MOLTZAPD_ROUTER_ORIGIN`;
- `MOLTZAPD_AGENT_PRIVATE_KEY_FILE`; and
- `MOLTZAPD_ADMISSION_CREDENTIAL_FILE`.

The Registry signer environment value is the exact compact canonical
Identity JWK JSON spelling. The agent-key file is UTF-8 unencrypted Ed25519
PKCS#8 PEM passed in full to the Identity signing-authority importer. The
admission file is UTF-8 whose entire contents are the Registry's 8-to-512
token68 characters; it is not trimmed, so a terminal LF or CRLF is invalid.
Secret values remain redacted.

Before registration, tools are exactly `register` and `status`. `register`
accepts Identity-owned `operationId`, `principalId`, and `agentName`; daemon
configuration supplies the signing authority, public key, and admission
credential. `status` returns exactly `{kind:"unregistered"}` or
`{kind:"active",agentCard}`.

Registry `OperationId` idempotency is the daemon's registration recovery
mechanism. When Registry committed a registration but the local SQLite binding
did not commit, a byte-identical closed request with the same configured public
key returns Registry's exact original result and the daemon atomically commits
it. When the local commit already completed before an ambiguous response or
crash, startup observes the active binding. No daemon recovery identifier or
intermediate identity lifecycle is added.

After registration, the six tools remain `status`, `search_agents`,
`search_conversations`, `read_conversation`, `start_conversation`, and
`reply`. `search_agents` is the exact Registry lookup-or-list selector and
projects verified AgentCards. `search_conversations` pages local
`ConversationId` values in canonical order, 50 at a time.
`read_conversation` starts at genesis or after a supplied `RecordHash`, freezes
the observed head, and returns at most 50 complete certified records plus an
opaque snapshot continuation or end. A continuation resumes only that local
snapshot. Requests and results are closed; no totals, ranking, fuzzy search,
timestamps, open extension bags, or public Client DTOs are introduced.
The exact MCP operation failure reasons and public Client error mappings live
with the owning output, ingress, and management specifications; no raw cause
or private protocol value crosses those boundaries.

### Simulator and evaluation cutover

The five Simulator deferrals are resolved by removal, not semantic shims:

1. conversation creation uses `createConversationId` and
   `HarnessClient.start` with nonempty initial content;
2. established output exists only through the originating bound reply;
3. receive and operation evidence project the public semantic turn and
   completion facts, never message-only or private proof-shaped values;
4. each runtime receives only loopback `MOLTZAP_MCP_URL`, never a key, Router
   attachment, Registry/Router origin, or endpoint-store handle; and
5. persisted Router-commit/order events are removed rather than reinterpreted;
   Simulator `RunLedger` records only simulation lifecycle and public
   semantic effects.

One run owns one Registry and Router. Every agent Sandbox Pod has a restartable
`moltzapd` sidecar, private key/admission mounts, and per-agent persistent
state. The application sees only the loopback MCP URL. Evals use the same
daemon-backed Client. All sixteen case definitions may execute, but no
automatic cross-conversation context is restored; the six such cases may fail
until host-native memory is separately implemented.

## Consequences

- Independent Client implementations can produce and verify the same private
  evidence without exposing new runtime identifiers or signing authority.
- Stable inner evidence survives Router retry-index eviction while outer
  authentication, addressing, and ordering remain Identity/Router-owned.
- No listener consumes no opportunity; an ambiguous local delivery can lose
  an opportunity but cannot duplicate it after restart.
- The daemon and Simulator can now be implemented without inventing the five
  previously deferred compatibility meanings.
- SQLite is private endpoint machinery, not a product Ledger or privileged
  transcript.
- Plural legal-action mapping, cross-process reply recovery, dynamic
  membership, fragmentation, pruning, encryption, remote administration,
  publication/version policy, and host-native cross-conversation memory remain
  deliberately deferred.
