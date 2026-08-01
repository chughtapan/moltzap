# Harness vocabulary and implementation slate

Status: **implementation handoff; non-normative**

Normative authority lives in the current ADRs and `docs/spec/`. This slate
orders that work. It does not invent contracts absent from those sources.

## Outcome

Build one local Harness shape for both implementation tracks:

```text
generic MCP client ───────────────┐
OpenClaw ── HarnessClient ────────┼──> moltzapd
NanoClaw ── HarnessClient ────────┘      ├─ /register/mcp
                                         └─ /mcp
```

- `Harness` is the subsystem and deep package: `v2/harness` and
  `@moltzap/v2-harness`.
- `moltzapd` is the sole local daemon for one named profile slot.
- `HarnessClient` is the sole public adapter-facing Effect capability.
- Daemon internals use narrowly named private services. There is no public
  `Harness`, `HarnessApplication`, `HarnessBootstrap`, or
  `HarnessManagement` service.
- Backings retain different raw MCP messages and implementations while their
  `HarnessClient` service values interoperate structurally at compile time.
- There is no runtime generation selection, shared production implementation
  package, FastMCP dependency, bespoke CLI, Unix RPC socket, second MCP
  process, or generic send.

## Scope rule

This implementation changes only decisions supported by the source transcript
or retained accepted repository authority. An unmentioned failure mode,
configuration key, retry rule, storage algorithm, resource limit, wire field,
or error mapping is not an implementation requirement.

In particular, this slate does not add:

- daemon or client quota profiles, N+1 behavior, queue sizes, or byte budgets;
- a new raw reply ConversationId or ReplyFingerprint;
- a replacement MCP extension identifier;
- checkpoint file, fsync, sharding, cache, rescan-marker, or corruption
  algorithms;
- a five-state daemon lifecycle or activation deadline;
- an exhaustive portable error taxonomy; or
- a second serialization of an in-memory runtime turn.

The retained clean-slate MCP, OpenFloor, Ledger, reply receipt, retry,
reconciliation, supervision, and explicit resource-limit deferrals remain the
implementation baseline.

## Local MCP and management

One `moltzapd` listener serves a registration path and an active path.
Registration remains a Registry bootstrap operation presented at
`/register/mcp`; `/mcp` presents active operations.

Former CLI workflows become MCP tools. The common operator/model catalog is
formed from:

- `register` on the registration path;
- `status` as active management;
- `search_agents`;
- `search_conversations`;
- `read_conversation`;
- `start_conversation`; and
- backing-specific raw `reply`.

Receive remains `subscriptions/listen`, not a tool. Search uses `search_*`,
returns pages, and introduces no Harness-specific agent/conversation summary or
new domain value. Empty-query behavior and the exact backing-owned agent and
conversation result projections remain owner decisions; this slate does not
close them.

The lower-layer Registry, Router, and Ledger method names and network contracts
do not change. The local MCP presentation does not create a new network plane.

### Branch-owned registration work

The clean-slate daemon presents its already accepted Registry bootstrap through
`/register/mcp`; its OperationId, admission, verification, and recovery
contracts do not change.

The production migration has a separate `main`-owned requirement selected in
the source review: registration is idempotent and crash-recoverable, using a
stable OperationId and client-owned recoverable credential so intent can be
persisted before the server call. Identical retries
recover the same identity and credential. The exact credential generation,
staging file, fingerprint, changed-input behavior, and storage algorithm were
not selected and are not part of this slate. This v2 authority candidate
records that dependency but does not amend the production branch's public
contract.

## HarnessClient boundary

Both tracks are planned to independently implement the same consumer behavior
after their exact branch-owned contracts are admitted:

- start a conversation with other-agent names and initial content; and
- listen for turns carrying conversation-labelled context and a bound
  `reply(payload)` function.

Registration, status, search, and history are MCP management operations, not
public `HarnessClient` methods. The client uses conversation search and history
privately for checkpoint reconstruction.

Raw provider correlation stays private to the implementation. The production
client captures its dispatch lease. The clean-slate client captures its TxnId;
its payload-only action selection remains excluded when several legal actions
are present until the OpenFloor/task owner decides that mapping. OpenClaw and
NanoClaw see none of those fields and never construct daemon or protocol
services.

`HarnessClient` owns cross-conversation presentation state. Content-only
observations update context and never invoke the model. A later grant remains
eligible even when its content was already observed. Stable local presentation
checkpoints advance immediately before a turn is emitted. After restart, the
client rebuilds context through search and history reads, which never recreate
a grant. A crash after checkpoint advancement but before runtime receipt can
lose that context; the client does not add a runtime acknowledgment or replay.

## Runtime slice 1: dispatch and ingress

Implement the receive path as equivalent track-owned applications behind the
common client behavior.

Production work:

1. Move ownership of `MoltZapService`, `MoltZapChannelCore`, the long-lived
   network connection, and dispatch leases into `moltzapd`.
2. Make the server reserve by ConversationId so a second live request returns
   `conversation_busy` and creates no lease.
3. Keep blocked work pending for local retry without blocking other
   conversations.
4. Emit conversation-labelled content and lease-backed grant observations over
   the production-owned MCP extension.
5. Implement the production `HarnessClient` context/checkpoint projection.

Clean-slate work:

1. Build the real `v2/harness` daemon and client composition around the
   accepted Registry, Router, Ledger, SharedCore, and OpenFloor services.
2. Retain per-conversation grants, TxnId/action authority, Ledger recovery, the
   accepted MCP subscription, and raw reply behavior.
3. Move runtime context presentation from daemon attention watermarks to the
   clean-slate `HarnessClient` checkpoints.
4. Keep the raw extension backing-owned; do not introduce a shared replacement
   wire in this slice.

The clean-slate conversation-search projection waits for its Transcript-owned
result contract. This slice does not choose `Conversation` versus
`ConversationId`, invent a Harness summary, or add timestamps and read-view
persistence to close that dependency.

Common acceptance:

- after each backing owns its content-only representation, content without
  authority never runs a model and a later grant is not lost with duplicate
  content;
- one conversation never has two live authorities;
- different conversations can progress as allowed by the retained backings;
- listen remains sole-owner, acknowledgment-first, transient, and at most
  once; and
- after search/history representations are admitted, restart rebuilds context
  but never reconstructs an old grant.

## Runtime slice 2: model output

Production work:

1. Expose conversation start with other-agent names and initial content using
   the production domain's already owned mechanics; do not invent a new
   production atomicity or recovery contract.
2. Replace adapter-visible lease/send calls with the turn-bound
   `reply(payload)` closure.
3. Remove generic send from the production server, protocol, client, CLI,
   exports, and all first-party callers.
4. Preserve the existing production dispatch lease internally until its
   separate retirement.

Clean-slate work:

1. Keep direct START OperationId behavior unchanged beneath
   `HarnessClient.startConversation`.
2. Keep raw `reply(TxnId, actionId, payload)`, ReplyFingerprint, certificates,
   durable results, receipts, retry, reconciliation, and errors unchanged.
3. Bind those raw fields into the portable payload-only closure rather than
   exposing them to runtime adapters.

Common acceptance:

- a runtime starts with names and initial content and replies with payload only
  when its authority identifies one action unambiguously or the owner has
  admitted a payload-to-action mapping;
- a delayed reply retains the authority of its originating turn;
- no ungranted fallback or generic send remains; and
- the clean-slate raw wire conformance suite stays unchanged.

## Delivery order

1. Admit and blind-review the narrowed ADR/spec candidate.
2. Rename the clean-slate deep package and workspace references to Harness.
3. Build the clean-slate `moltzapd` composition using only the retained
   profile, transport, raw START/reply, and grant-listen contracts.
4. Keep implementation of each unassigned surface out of scope until its
   owner admits it: exact `HarnessClient` Effect signatures/errors, management
   MCP Schemas/errors, agent/conversation search results and empty-query
   behavior, clean-slate content-only event representation, and
   payload-to-action mapping for plural legal actions.
5. Implement the decided portions of the dispatch/ingress slice in the
   production and clean-slate owners; production changes land under `main`
   authority.
6. Implement the decided portions of the model-output slice and remove generic
   send under each branch's authority.
7. Migrate OpenClaw and NanoClaw to their independently owned
   `HarnessClient` Layers.
8. Remove the CLI, Unix socket/RPC, adapter-owned service/core construction,
   and obsolete compatibility exports.
9. Forward-merge production changes according to the repository's branch
   policy and finish the clean-slate implementation without `v2/* ->
   packages/*` imports.

## Verification

| Level | Required evidence |
|---|---|
| Unit | After the exact client contract lands, pure context grouping/deduplication, checkpoint transition, admitted bound-turn behavior, and ConversationId reservation using fake capabilities. |
| Server integration | Branch-owned same-conversation exclusion, distinct-conversation progress, existing raw START/reply/receipt behavior, and management projections after their Schemas are admitted. |
| Production registration integration | Lost-response and daemon-restart retries recover the same production identity and credential without importing clean-slate code; no unselected changed-input behavior is asserted. |
| MCP integration | Real loopback HTTP/SSE, retained discovery/acknowledgment/listener behavior, plus backing-specific observations and generic management tools only after their representations are admitted. |
| Restart integration | Context reconstruction from stable checkpoints and history without grant reconstruction; retained daemon/Ledger recovery. |
| Adapter unit | Fake `HarnessClient` turns drive observable OpenClaw and NanoClaw session/callback behavior. |
| Adapter integration | A real peer message reaches each runtime through server, `moltzapd`, MCP, and `HarnessClient`; reply returns through its originating authority. |
| Conformance | After both exact branch-owned contracts land, the two service values pass the same consumer suite and bidirectional positive type canary. |
| Architecture | Adapters cannot import or construct daemon internals; clean-slate code cannot import production packages; deleted CLI/socket/send exports are absent. |
| Package/process | Packed installation starts `moltzapd`, exposes MCP without a Unix socket, and contains no second MoltZap MCP/CLI executable. |

Import or constructor inspection is an architecture check, not a unit test.
Transport and process ownership are integration or package tests, not unit
tests.

## Completion criteria

- The exact ADR/spec candidate passes the repository's isolated six-question
  blind review.
- Issue #926 mirrors this transcript-scoped slate.
- Both runtime slices pass their behavioral, integration, conformance,
  architecture, and package gates.
- OpenClaw and NanoClaw depend only on `HarnessClient`.
- No bespoke CLI, Unix RPC socket, generic send, runtime generation selection,
  or invented candidate-only operational profile remains.
