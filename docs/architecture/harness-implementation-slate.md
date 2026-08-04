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
- The target state has no runtime generation selection, shared production
  implementation package, FastMCP dependency, bespoke CLI, Unix RPC socket,
  second MCP process, or generic send. The implementation-state section below
  distinguishes that target from landed production and open candidate work.

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

## Implementation state

This section reports repository state as of 2026-08-04. It does not admit or
supersede a contract.

- **Landed production:** `origin/main@27bd6f4e` includes the daemon-owned
  receive/reply foundation from #942. Production has no dispatch package,
  `LeaseId`, `conversation_busy`, server-side reply grant, or local
  duplicate-reply guard. The daemon publishes one nonempty same-conversation
  `Message` batch, and `HarnessClient` retains the originating
  `ConversationId` privately for `reply(payload)`. Every reply invocation
  sends.
- **Open production candidates:** #943 isolates presentation state; #944 adds
  paginated MCP search/history; #945 reconstructs context with an injected
  local Effect `KeyValueStore`; #946 adds MCP-local conversation participants
  and the public presentation turn; #947 packages `moltzapd`; and #948 adds
  `start_conversation`. None of these candidates is present in `origin/main`.
- **Still pending in production:** durable profile-to-MCP endpoint
  acquisition, registration through `/register/mcp`, OpenClaw and NanoClaw
  cutover, replacement of every remaining operator workflow, and deletion of
  the generic send, bespoke CLI, and Unix socket.
- **Clean-slate:** `origin/v2@7329cfb0` contains the reviewed Harness
  vocabulary and package rename, but `v2/harness` remains a scaffold and its
  `moltzapd` executable is not implemented. `v2/transcript` is also a scaffold;
  its exact representation owner and public Ledger contract remain
  prerequisites for a real clean-slate Harness composition.

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

Receive remains `subscriptions/listen`, not a tool. On landed production, the
active catalog contains only `status` and `reply`; the registration catalog is
empty. Candidate #944 adds `search_agents`, `search_conversations`, and
`read_conversation` using the selected production exact-match/blank-browse
paginated behavior. Candidate #948 adds `start_conversation`. Those candidates
do not assign the clean-slate backing's result representations or errors.

Candidate #946 enriches the production MCP-local `Conversation` passed to the
`HarnessClient` implementation with participants. Participants are local
presentation data: the canonical production `Conversation` and the main
WebSocket protocol remain unchanged, and the client does not write the
enrichment back onto that wire.

The lower-layer Registry, Router, and Ledger method names and network contracts
do not change. The local MCP presentation does not create a new network plane.

### Branch-owned registration work

The clean-slate daemon presents its accepted Registry bootstrap through
`/register/mcp`; its OperationId, admission, verification, and recovery
contracts remain clean-slate-owned.

Production registration is not implemented at `/register/mcp`.
`origin/main` still uses the existing HTTP bootstrap and CLI profile
persistence. This slate does not introduce a production OperationId,
crash-recovery, credential-staging, fingerprint, changed-input, or storage
contract. Production must either translate already owned behavior or wait for
a separately admitted `main`-owned registration contract. The current
clean-slate management spec describes a selected production recovery contract;
that cross-branch authority mismatch requires reconciliation before
implementation relies on it.

## HarnessClient boundary

Both tracks are planned to independently implement the same consumer behavior
after their exact branch-owned contracts are admitted:

- start a conversation with other-agent names and initial content; and
- listen for turns carrying conversation-labelled context and a bound
  `reply(payload)` function.

Registration, status, search, and history are MCP management operations, not
public `HarnessClient` methods. The client uses conversation search and history
privately for checkpoint reconstruction.

Raw backing correlation stays private. The production client retains the
originating `ConversationId` in private MCP request metadata and every call to
the bound `reply(payload)` closure sends. It has no dispatch lease, reply token,
action identifier, turn identifier, or duplicate-reply suppression. The
clean-slate client retains its backing-owned TxnId and action selection
internally; plural-action projection remains with the OpenFloor/task owner.
OpenClaw and NanoClaw see none of those fields and never construct daemon or
protocol services.

Production notifications are reply-capable nonempty coalesced `Message`
batches, not separate content and grant events. Candidate #945 reconstructs
other-conversation content from search/history and stores stable presentation
checkpoints through an injected local `KeyValueStore`; candidate #946 projects
that state into the public turn. The checkpoint storage path and durable
profile integration remain unselected. The clean-slate backing retains its
separately owned content/grant and recovery mechanics.

## Runtime slice 1: dispatch and ingress

Implement the receive path as equivalent track-owned applications behind the
common client behavior.

Production work:

1. Treat #942's daemon-owned receive/reply foundation as landed.
2. Do not recreate dispatch leases, `conversation_busy`, server-side
   reservation, grants, holds, or local duplicate-reply suppression removed by
   #941.
3. Land the read, reconstruction, participant-enrichment, and public-turn
   candidates in dependency order (#943 through #946).
4. Preserve the production event as one nonempty same-conversation raw
   `Message` batch whose reply closure privately retains its originating
   `ConversationId`.
5. Add durable profile-to-MCP endpoint acquisition before adapters depend on
   the packaged daemon.

Clean-slate work:

1. Admit the Transcript representation owner and exact public Ledger contract,
   then implement `v2/transcript`; do not invent those representations inside
   `v2/harness`.
2. Admit the exact management projections, content-only ingress,
   `HarnessClient` contract, checkpoint representation, and any required
   plural-action mapping before implementing those respective surfaces.
3. Build only admitted `v2/harness` daemon and client slices around the
   implemented Registry, Router, Ledger, SharedCore, and OpenFloor services.
4. Retain per-conversation grants, TxnId/action authority, Ledger recovery, the
   accepted MCP subscription, and raw reply behavior.
5. Move runtime context presentation from daemon attention watermarks to the
   clean-slate `HarnessClient` checkpoints.
6. Keep the raw extension backing-owned; do not introduce a shared replacement
   wire in this slice.

The clean-slate conversation-search projection waits for its Transcript-owned
result contract. This slice does not choose `Conversation` versus
`ConversationId`, invent a Harness summary, or add timestamps and read-view
persistence to close that dependency.

Common acceptance:

- production serializes and coalesces inbound work in its endpoint-local
  consumer and routes every bound reply invocation to the originating
  conversation;
- clean-slate same-conversation authority remains governed by its retained
  grant/TxnId mechanics;
- no production lease, `conversation_busy`, or server grant is recreated;
- listen remains sole-owner, acknowledgment-first, transient, and at most
  once; and
- after each backing's search/history representation exists, restart can
  rebuild presentation context without reconstructing reply authority.

## Runtime slice 2: model output

Production work:

1. Land #948's `start_conversation` candidate: other-agent names plus required
   initial content, self implicit, using existing create-then-send mechanics
   without a new atomicity or recovery promise.
2. Migrate OpenClaw and NanoClaw from direct
   `MoltZapService`/`MoltZapChannelCore` ownership to `HarnessClient` and prove
   each real daemon/MCP path.
3. Remove generic send from the production server, protocol, client, CLI,
   exports, and first-party callers only after start and bound reply cover
   their required model-output behavior.
4. Remove the bespoke CLI and Unix RPC only after every first-party operator
   workflow has an MCP replacement. There is no production lease-retirement
   step; #941 already removed that system.

Clean-slate work:

1. Keep direct START OperationId behavior unchanged beneath
   `HarnessClient.startConversation`.
2. Keep raw `reply(TxnId, actionId, payload)`, ReplyFingerprint, certificates,
   durable results, receipts, retry, reconciliation, and errors unchanged.
3. Bind those raw fields into the portable payload-only closure rather than
   exposing them to runtime adapters.

Common acceptance:

- a production runtime starts with names and initial content and replies with
  payload only;
- the clean-slate client exposes payload-only reply only when the backing
  identifies one legal action unambiguously or its owner admits the
  payload-to-action mapping;
- a delayed production reply retains its originating `ConversationId`, while
  the clean-slate backing retains its own raw authority privately;
- production reply has no server grant and every invocation sends; the
  clean-slate backing continues to enforce its retained authority;
- no ungranted fallback or generic send remains; and
- the clean-slate raw wire conformance suite stays unchanged.

## Delivery order

1. Treat the clean-slate authority/package rename (#938) and the landed
   production receive/reply foundation (#942) as completed prerequisites.
2. Land #943 through #948 in stack order, preserving their distinction from
   `origin/main` until each PR merges.
3. Add a production profile-to-MCP endpoint acquisition contract. Candidate
   #947 currently requires a caller-supplied nonzero port; production profiles
   do not yet store or discover one.
4. Cut OpenClaw and NanoClaw to `HarnessClient` and add behavioral fake-client
   tests plus real daemon/MCP adapter integration.
5. Implement production registration and remaining operator MCP tools, then
   delete generic send, the bespoke CLI, and Unix RPC after all first-party
   replacements are operational.
6. Forward-merge landed production changes under repository branch policy.
7. Before clean-slate implementation relies on production claims, reconcile
   the current v2 ADR/spec references to production dispatch leases,
   `conversation_busy`, and a selected production registration-recovery
   contract with lease-free `main` and its unselected registration contract.
   This slate records those mismatches but does not amend or supersede those
   authorities.
8. Admit the Transcript representation owner and exact public Ledger contract,
   then implement `v2/transcript` and the Ledger process.
9. Admit the remaining exact clean-slate management, content-ingress,
   `HarnessClient`, checkpoint, and plural-action contracts before composing
   their corresponding Harness slices. Transcript readiness is not the only
   gate.
10. Finish clean-slate parity without `v2/* -> packages/*` imports, runtime
   generation selection, or a shared backing implementation.

## Verification

| Level | Required evidence |
|---|---|
| Unit | After the exact client contract lands, pure context grouping/deduplication, checkpoint transition, and lease-free bound-reply behavior using fake capabilities. |
| Server integration | Existing production message delivery plus clean-slate backing-owned authority tests; do not require a production `conversation_busy` path. |
| Production registration integration | Add lost-response/restart assertions only after a `main`-owned registration recovery contract is admitted; this slate selects none. |
| MCP integration | Real loopback HTTP/SSE, retained discovery/acknowledgment/listener behavior, plus backing-specific observations and generic management tools only after their representations are admitted. |
| Restart integration | Context reconstruction from stable checkpoints and history without grant reconstruction; retained daemon/Ledger recovery. |
| Adapter unit | Fake `HarnessClient` turns drive observable OpenClaw and NanoClaw session/callback behavior. |
| Adapter integration | A real peer message reaches each runtime through server, `moltzapd`, MCP, and `HarnessClient`; reply returns through its originating authority. |
| Conformance | After both exact branch-owned contracts land, the two service values pass the same consumer suite and bidirectional positive type canary. |
| Architecture | Adapters cannot import or construct daemon internals; clean-slate code cannot import production packages; deleted CLI/socket/send exports are absent. |
| Package/process | Candidate #947 proves packed `moltzapd`, direct WebSocket ownership, clean shutdown, and no daemon-created Unix socket. Final evidence must additionally prove profile-based endpoint acquisition and absence of the transitional `moltzap` executable. |

Import or constructor inspection is an architecture check, not a unit test.
Transport and process ownership are integration or package tests, not unit
tests.

## Completion criteria

- The clean-slate authority/package-rename prerequisite is landed. Any
  semantic ADR/spec reconciliation required by current production state must
  pass its own repository review gate before clean-slate implementation relies
  on it.
- Issue #926 mirrors this transcript-scoped slate.
- Both runtime slices pass their behavioral, integration, conformance,
  architecture, and package gates.
- OpenClaw and NanoClaw depend only on `HarnessClient`.
- No bespoke CLI, Unix RPC socket, generic send, runtime generation selection,
  or invented candidate-only operational profile remains.
