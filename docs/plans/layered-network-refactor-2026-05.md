# Layered Network Refactor — Landing Plan (revised post plan-eng-review)

**Source:** `/plan-eng-review` session 2026-05-04, against branch `chore/strict-json-rpc-frames` (PR #414).
**Supersedes:** the original 7-slice plan in [issue #156](https://github.com/chughtapan/moltzap/issues/156). That doc is the architect-stage design; this is the eng-stage landing plan.

---

## 1. What this branch (PR #414) already accomplishes

10,033 lines added, 6,976 removed across 298 files. Substantive deliverables:

- **JSON-RPC 2.0 wire frames** (`packages/protocol/src/schema/frames.ts:14-71`) — `RequestFrame`, `ResponseFrame`, `NotificationFrame` with branded type carriers.
- **Descriptor-backed RPC + notification system** (`packages/protocol/src/rpc.ts:31-130`, `notification.ts`) — `defineRpc()` / `defineNotification()` pre-compile AJV validators at module load.
- **Boundary validation** — `decodeRpcParams` validates exactly once; handlers receive typed `Static<P>` with no re-checking.
- **Effect-native server→client RPC** (`packages/server/src/ws/connection.ts:211-284`) — `sendRpcToClient` uses `acquireUseRelease` over per-connection `HashMap<JsonRpcStringId, Deferred>`, with `Scope` finalizer for connection teardown; tagged-error union covers AppDisconnected | AppCallbackRpcResponseError | AppCallbackRpcDecodeError | AppCallbackRpcSocketError.
- **events → notifications rename** — `EventNames` → `notificationGroup`, `EventFrame` → `NotificationFrame`, `eventFrame()` → `notificationFrame()`.
- **`defineMethod()` boundary** (`packages/server/src/rpc/context.ts:129-156`) — single validation point producing typed `ResolvedRpcMethod`.
- **`@effect/rpc` bridge** with opaque schemas (`rpc-groups.ts:48-62`) — TypeBox runtime + Effect type carrier. *Decision below: drop the bridge.*

The user's first goal ("validate at boundary once, types after") is largely DONE.

---

## 2. Architectural decisions captured in this review

### 2.1 Packaging: moltzap publishes wire+runtime, no SDK

**moltzap publishes (versioned npm packages):**
- `@moltzap/protocol` — wire types, descriptors, conformance suite
- `@moltzap/client` — generic transport (WebSocket, sendRpc, subscribe, registerAgent)
- `@moltzap/server-core` — runtime
- ~~`@moltzap/app-sdk`~~ — DELETED

**arena absorbs:**
- New package `arena/packages/app-runtime/` — ~600-1000 lines of vendored MoltZapApp + hook context types + result/error types, tailored to werewolf
- Replaces arena's `@moltzap/app-sdk` runtime dependency

**arena breaks the `lib/moltzap` git submodule** in favor of npm version pins:
- `git submodule deinit lib/moltzap` + remove from `.gitmodules`
- `vitest.workspace-aliases.ts` aliases dropped
- Cross-repo dev uses pnpm overrides when iterating both repos simultaneously
- Version bumps via `pnpm update @moltzap/protocol@^X.Y.Z`

**arena replaces `@moltzap/server-core` devDependency** with testcontainers / black-box server for integration tests.

### 2.2 Errors move from client to protocol

`RpcServerError`, `NotConnectedError`, `RpcTimeoutError` move from `@moltzap/client` to `@moltzap/protocol`. They're wire-derived error tags. Stronger home.

### 2.3 Drop the `@effect/rpc` bridge

`packages/protocol/src/rpc-groups.ts:48-62` (`opaqueEffectSchema`, `bridgeEffectRpcType`) — about 80 lines of indirection. Replace with thin descriptor-driven Effect-native handler binder we own. TypeBox+AJV stays runtime authority. Single AJV instance shared across `defineRpc()` and `defineNotification()`.

### 2.4 Hook collapse into TM primitive

All hook RPCs delete:
- `apps/onJoin` — no consumer registered (verified)
- `apps/onClose` → existing `app/sessionClosed` notification (already exists; redundant)
- `apps/onBeforeDispatch`, `apps/onBeforeMessageDelivery`, `apps/onSessionActive` → TM endpoint receives messages via `network.send` and takes action via existing CRUD

All surviving hook semantics are **fail-CLOSED**. The "fail-open" behavior of `on_session_active` was a bug masquerading as a feature (sessionReady fired even when app failed setup) — gets corrected by the collapse.

Client-side dispatcher partitioning (`subscribers.ts`) stays; protocol unaffected.

### 2.5 Permissions/attestation deletion (not migration)

Verified zero usage in arena (the only known consumer):
- `permissions/grant`, `permissions/list`, `permissions/revoke` RPCs
- `permissions/required`, `app/skillChallenge` notifications
- `apps/attestSkill` RPC
- `apps/authorizeDispatch` (orphan after admission flow deletion)
- `AppManifest.permissions` field
- All related codes in `AppParticipantRejected.rejectionCode` enum
- `DefaultPermissionService` server class

**Net deletion: ~70 lines of permission code + ~4 lines of attestation code from `app-host.ts`, plus protocol schemas, SDK auto-response, integration test files.**

### 2.6 Surface area cleanup beyond hooks/permissions

- **Surfaces** (`surface/update|get|action|clear` + 2 notifications): zero consumer. DELETE.
- **Push notifications** (`push/register|unregister`): zero consumer. DELETE.
- **`apps/attachConversation`**: collapses into `tasks/createConversation(taskId, ...)` under composite FK schema.
- **`TaskManagerAction` 5-tag union, `MutationAttempt` 3-tag union**: never wire-needed. TM calls existing CRUD; "verdicts" are sequences of RPC calls, not wire shape.
- **`task_manager_endpoints` table**: collapses into a column on `tasks`.
- **`appCallbackRpcMethods` group**: empty after deletions, drop the group.

### 2.7 Stays despite zero arena usage (product calls)

- **Contacts** (`contacts/list|add|accept` + 2 notifications): human identity is platform vision; future apps will use.
- **Mute / Archive** (`conversations/mute|unmute|archive|unarchive` + 2 notifications): CLI uses; server filters delivery.
- **Rich Presence** (`presence/update`): CLI uses.

### 2.8 TM same-process loopback (no short-circuit)

`default-dm` and `default-group` task managers ALWAYS route through `network.send` even in-process. In-memory loopback. One code path, one set of tests. No "preserve auth/ack/logging semantics" verbal contract needed.

### 2.9 Slice reshape

| Slice | Original (#156) | Revised |
|---|---|---|
| A | Protocol split + handler Effect Context redesign | **REBASE on this branch.** Most of A's "Context redesign" already done. Remaining: split `rpcMethods` into 3 layered tuples (network/task/app), move handlers under `packages/server/src/{network,task,app}/handlers/`, activate tsconfig project refs + ESLint no-restricted-imports + Effect Context tag absence boundary gates. |
| B + E | B: task layer CRUD + DB migration. E: Session→Task rename. | **MERGE into one PR.** Drop app_sessions/app_session_*, add tasks/task_participants. Rename `sessionId` → `taskId` on wire AND in handlers AND in tests AND in DB columns, atomically. |
| C | Task manager runtime + 5-tag verdict + attach API | **RESHAPE.** TM = network endpoint. No verdict union. TM takes action via existing CRUD. Reshape eliminates ~half the originally-scoped surface. |
| D | humanContact unification | **DEFER entirely.** Permissions deleted (not unified). |
| F | Actor-model protocol types | **GATE on #161 cleanup landing first.** Drop legacy TypeBox `UserId`/`AgentId`/`MessageId`/`ConversationId` schema-value exports from flat barrel and `./schemas` subpath. Then F's brand types own the names cleanly. |
| G | Effect-native delivery + Broadcaster removal | **SPLIT into G1 + G2.** G1 = introduce `DeliveryService` (rename to avoid collision with existing `DeliveryService` for delivery tracking — call it `RouterService` or fold into `ConnectionManager.send`) + `AgentEndpointResolver`, dual-DI. G2 = migrate 16+ Broadcaster call sites, delete Broadcaster, Effect-ify `MessageService`. |

### 2.10 AgentEndpointResolver implementation constraint

In-memory `HashMap<AgentId, EndpointAddress>` maintained by `ConnectionManager`. Register on connect, drop on disconnect. O(1) hot path. No DB lookup. Perf assertion: 50-recipient fan-out completes in <50ms total.

(Multi-process / restart durability is a future scaling concern, not v1.)

---

## 3. Sequencing

```
Phase 0  ━━━ This branch (PR #414) lands as foundation (already done)
              JSON-RPC frames + descriptor system + Effect-native RPC

Phase 1  ━━━ moltzap-side cleanup pass (one PR or small chain)
              ├── Move RpcServerError/NotConnectedError/RpcTimeoutError client → protocol
              ├── Drop @effect/rpc bridge from rpc-groups.ts
              ├── Single shared AJV instance (frozen singleton)
              ├── Delete permissions/attestation/surfaces/push surfaces
              ├── Delete apps/onJoin, apps/onClose (use existing app/sessionClosed)
              ├── Delete apps/authorizeDispatch
              ├── Delete TaskManagerAction, MutationAttempt schemas
              ├── Delete app/hookTimeout, app/skillChallenge, app/participantAdmitted/Rejected notifications
              └── Delete AppManifest.permissions field

Phase 2  ━━━ #161 cleanup: drop legacy UserId/AgentId from flat barrel
              ├── Audit @moltzap/protocol main, ./schemas, ./testing exports
              └── Migrate internal consumers to subpath imports (where applicable)

Phase 3  ━━━ Slice F: actor-model brand types
              ├── #159 lands once #161 has tightened the canary

Phase 4  ━━━ Slice A': layered split + boundary gates
              ├── Split rpcMethods into networkRpcMethods, taskRpcMethods, appRpcMethods
              ├── Move handlers under {network,task,app}/handlers/ in server-core
              ├── tsconfig project refs at server-core/{network,task}/
              ├── ESLint no-restricted-imports rule
              └── Effect Context tag absence (NetworkRequiredContext)

Phase 5  ━━━ Slice B+E merged: schema migration + sessionId→taskId rename atomic
              ├── Drop app_sessions/app_session_* tables
              ├── Add tasks/task_participants/task_manager_endpoints
              ├── Rename across wire + handlers + tests + DB columns
              └── Pre-production status is the green light

Phase 6  ━━━ Slice C reshaped: TM as network endpoint
              ├── TM endpoint registration mechanism (piggyback on agent registration or own RPC)
              ├── Default-dm task manager (DM uniqueness via SELECT-before-INSERT, immutability)
              ├── Default-group task manager (passthrough)
              ├── App TM (third-party, over-the-wire)
              ├── New synthetic 5-hook regression test fixture
              └── Hook firing collapses; ~70% of app-host.ts deletes

Phase 7  ━━━ Slice G1: introduce delivery service (dual-DI)
              ├── New service alongside existing Broadcaster, no consumer migration
              └── AgentEndpointResolver in-memory hashmap

Phase 8  ━━━ Slice G2: migrate + delete Broadcaster
              ├── 16+ call sites switch to new service
              ├── Effect-ify MessageService along the way
              └── Delete Broadcaster, BroadcasterTag, BroadcasterLive

Phase 9  ━━━ ARENA SIDE (parallel-able after Phase 1 in arena's repo)
              ├── Vendor MoltZapApp into arena/packages/app-runtime/ (one-time copy)
              ├── Drop @moltzap/app-sdk dep
              ├── Update EventFrame → NotificationFrame, etc.
              ├── Update apps/closeSession → tasks/close magic strings
              ├── Bump @moltzap/protocol + @moltzap/client npm pins
              ├── Break lib/moltzap submodule
              ├── Replace @moltzap/server-core devDep with testcontainers
              └── Run @moltzap/protocol/testing/conformance/client suite as regression gate
```

Phases 1-2 are independent and can land in either order. Phases 3-8 are mostly sequential. Phase 9 (arena side) gates on Phase 1 minimum but can run mostly in parallel with Phases 2-8.

---

## 4. Worktree parallelization

The work decomposes into mostly sequential phases (Phase N depends on Phase N-1), but a few opportunities exist for parallel lanes:

| Lane | Phases | Modules touched | Depends on |
|---|---|---|---|
| **Lane A (cleanup):** Phase 1 (delete dead surfaces) | protocol/, server-core/app/, server-core/__tests__/ (deletions) | — |
| **Lane B (#161 cleanup):** Phase 2 | protocol/index.ts, protocol/schemas/, internal consumer imports | — (independent of Lane A) |
| **Lane C (slice F):** Phase 3 | protocol/network/ (actor-model types) | Lane B |
| **Lane D (slice A'):** Phase 4 | protocol/{network,task,app}/, server-core/{network,task,app}/handlers/ | Lane A |
| **Lane E (slice B+E):** Phase 5 | server-core/db/, protocol/schema/methods/, server-core/__tests__/ (rename) | Lane D |
| **Lane F (slice C):** Phase 6 | server-core/app/app-host.ts → split + collapse | Lane E |
| **Lane G (slice G1+G2):** Phases 7-8 | server-core/ws/, server-core/services/, server-core/app/layers.ts | Lane D, Lane F |
| **Lane H (arena absorb):** Phase 9 | arena/packages/app-runtime/, arena root, arena tests | Lane A (minimum); arena can absorb the SDK copy whenever |

**Parallel execution opportunity:**
- Launch Lane A and Lane B in parallel (independent).
- Lane H (arena absorb) can launch as soon as Lane A is in flight.
- Once Lane A merges, Lane D unblocks.
- Lane C is a tiny one-file change blocked only on Lane B.

**Conflict risk:**
- Lane D (handler reorganization) and Lane F (app-host.ts collapse) both touch `packages/server/src/app/app-host.ts`. Sequential.
- Lane E and Lane F both touch session lifecycle code. Sequential.
- Lane G1 introduces new files; Lane G2 modifies existing. G2 must wait for G1.

---

## 5. NOT in scope (explicit deferrals)

| Item | Why deferred |
|---|---|
| humanContact unification | Permissions deleted; no need to unify what's gone. Future work if scale demands. |
| Migration runner / versioned schema framework | Implementer-stage decision. Pre-prod allows destructive migration without one. |
| Multi-process AgentEndpointResolver durability | v1 is single-process; multi-process is a future scaling pass. |
| `@moltzap/client` vendoring into arena | Decision: keep `@moltzap/client` as a normal arena npm dep. Vendor only the SDK piece. Transport stays shared infrastructure. |
| Backpressure policy per-descriptor | Default `Block` for inbound, `DropOldest` for outbound notifications. Per-descriptor tuning is later. |
| Web client (`packages/web/src/lib/ws-client.ts`) refactor | That's arena's spectator-betting protocol, not a moltzap client. Out of scope. |
| Permission flow in apps | Apps build their own. moltzap doesn't provide one. |
| Skill attestation | Same — gone, no replacement in moltzap-core. |
| Agent-selection policy when multiple agents online for one user | humanContact deferred → question doesn't apply at this layer. |
| moltzap-arena werewolf integration verification | Tracked separately in arena's PR cycle. |

---

## 6. What already exists (don't rebuild)

| Existing infrastructure | Why we reuse it |
|---|---|
| `defineRpc()`, `defineNotification()`, `decodeRpcParams()`, `decodeNotification()` | Already validate-at-boundary-once. Don't rebuild. |
| `sendRpcToClient` with `Deferred`/`Scope`/`acquireUseRelease` | Effect-native server→client RPC already correct. Reuse for any remaining hook-as-RPC dispatch. |
| `JsonRpcMethod`, `JsonRpcStringId` brand types | Already in place. |
| `defineMethod()` boundary in server | Already typed. Reuse for new layered handlers. |
| Conformance suite (`packages/protocol/src/testing/conformance/`) | Already covers wire correctness. arena can run it against vendored transport. |
| `@moltzap/client` `MoltZapClient` class | Generic transport. Arena keeps using it, just stops vendoring. |
| `app/sessionClosed` notification | Already exists. Augment payload to absorb `apps/onClose` RPC's role (carry conversations + closedBy.ownerId). |
| AppHost's hook timeout firing pattern | Pattern reused (with simplifications) in the new TM dispatch. |

---

## 9. CORRECTIONS from Codex round 2

The first version of this plan over-stated the hook collapse and under-scoped several deletions. Round 2 codex review caught the misses. Net corrections:

### 9.1 Hook collapse — corrected by firing site

The "delete all hooks, TM primitive replaces" claim was wrong. Hooks separate by firing site:

**SEND-side hooks DISSOLVE into TM-as-endpoint topology** (mandatory under this collapse, not optional):
- `apps/onBeforeMessageDelivery` → TM's main message handler IS the gate. The block/reason/patch/feedback verdict shape lives inside TM logic, not on the wire. SDK ergonomics rebuild it as the TM message handler's return value.
- The `agent → MessageService.send → broadcast` flow becomes `agent → network.send(to: TM) → TM decides forward/block/patch via existing CRUD`. `messages/send` as a wire RPC may dissolve entirely (TM does `network.send` with sender in payload).

**LIFECYCLE hooks DISSOLVE into notifications + TM state machine**:
- `apps/onSessionActive` → `task/admissionComplete` notification. TM holds participant messages during its setup window. No awaitability needed because TM is the gate.
- `apps/onJoin` → eager admit + TM gates participant traffic. (Or explicit `task/admitParticipant`/`task/rejectParticipant` if explicit-admit is wanted.)
- `apps/onClose` → `task/closing` notification with AUGMENTED payload (must carry `conversations` + `closedBy.ownerId`, not just `sessionId` like today's `app/sessionClosed`).

**RECEIVE-side dispatch hook STAYS as awaitable wire RPC** (renamed, drop "hook" framing):
- `apps/onBeforeDispatch` → `task/authorizeDispatch` (or similar). Channel-to-TM awaitable round-trip. Verdict shape stays rich: `grant{leaseId, leaseTimeoutMs, dispatchMessageId} | deny{reason} | hold{reason}`. Werewolf actively uses every variant for game-rule scheduling. Cannot dissolve because the firing site is the channel (each agent's runtime), not the message-send path.

**Why the asymmetry:** SEND-side firing sites are absorbed by TM-as-endpoint topology (TM IS the gate). RECEIVE-side firing sites still need an awaitable round-trip because the channel is on the recipient and asks the TM (via wire) for permission to dispatch.

### 9.2 TM authority model is real new work

"TM uses existing CRUD" is glib. The CRUD methods need a new authority dimension: **caller is the registered TM for taskId X**. Affected methods (~5-7 lines per method):
- `tasks/storeMessage`
- `tasks/addParticipant` / `tasks/removeParticipant`
- `tasks/closeTask`
- `tasks/createConversation` / `tasks/closeConversation`
- Any other task-mutation CRUD

Plus a registration mechanism: `endpoints/registerTaskManager(taskId)` RPC or a column on the `tasks` row that records which connection is the registered TM. Without this, any agent could write to any task's storage by calling CRUD directly.

### 9.3 Phase ordering corrected: arena absorbs FIRST

Original Phase 9 (arena absorb) parallel with Phase 1 (delete app-sdk) creates a window where arena's submodule pin loses `@moltzap/app-sdk` before arena vendors a replacement. Corrected ordering:

```
Phase -1 (NEW): Arena vendors @moltzap/app-sdk into arena/packages/app-runtime/
                 Arena's submodule pin still points at current moltzap (with app-sdk).
                 Arena's package.json migrates @moltzap/app-sdk → app-runtime.
                 Arena tests still pass.
Phase 0:        This branch (PR #414) lands as foundation
Phase 1+:       moltzap deletes app-sdk + dead surfaces
Phase 9 (now):  Arena bumps moltzap submodule (or breaks submodule, switches to npm pins)
```

### 9.4 Permission deletion scope expanded

Beyond the 3 RPCs + DefaultPermissionService class:
- `AppManifest.permissions` field
- `permissionTimeoutMs` field
- `app_permission_grants` DB table
- `checkPermissions` server function
- `AppParticipantRejected.rejectionCode` permission-related codes (`PermissionDenied`, `PermissionTimeout`, `PermissionHandlerError`, `NoPermissionHandler`)
- CLI: `packages/client/src/cli/commands/permissions.ts`
- SDK auto-response wrappers

Phase 1 cleanup is a 2-3 PR chain, not one PR.

### 9.5 Skill attestation deletion scope expanded

- `apps/attestSkill` RPC + `app/skillChallenge` notification (already on list)
- `skillUrl`, `skillMinVersion`, `challengeTimeoutMs` AppManifest fields
- `checkCapability` server function
- `apps attest-skill` CLI subcommand
- SDK auto-response at `packages/app-sdk/src/app.ts:810`
- `AttestationTimeout`, `SkillMismatch`, `SkillVersionTooOld` rejection codes

### 9.6 Packaging is 6 publishable packages, not 3

Repo also publishes `@moltzap/openclaw-channel`, `@moltzap/claude-code-channel`, `@moltzap/runtimes`. Plus `examples/mountains-or-beaches/` consumes `@moltzap/app-sdk` and needs migration when app-sdk dies. Migrate the example to "consumer builds own runtime" pattern.

### 9.7 AgentEndpointResolver is a multimap

`HashMap<AgentId, Set<EndpointAddress>>`. One agent can have multiple connections (multiple devices, multiple runtimes). Today's `getByAgent` returns an array. The resolver respects that with atomic add on connect, atomic remove on disconnect, cleanup ordering on reconnect.

### 9.8 `presence/subscribe` stays

Was accidentally dropped from the "stays" list. Live server handler at `presence.handlers.ts:23`. Required for explicit subscribers.

### 9.9 Contacts need IMPLEMENTING if kept

`createCoreApp` registers auth/conversations/messages/presence/apps/system handlers — NOT contacts. CLI calls `ContactsList`; server doesn't handle it (today). "Keep contacts" means writing the server handlers, registering them in `createCoreApp`, hooking up the contact-graph DB. New work, not preservation.

### 9.10 B+E split into additive → cutover (3 PRs not 1)

407 sessionId refs + 441 app-session refs across protocol/server/client/app-sdk. Single PR has no useful bisect point. Better:
- B1: introduce `tasks` schema alongside `app_sessions` (additive, no rename)
- B2: introduce `tasks/*` RPCs alongside `apps/*` (additive)
- B+E final: cut over and delete old (atomic now because the new path is already proven)

### 9.11 Arena vendors SDK test suite alongside SDK code

Conformance suite covers protocol/server properties. SDK-specific tests (default manifest, heartbeat, reconnect, error mapping) live in `packages/app-sdk/src/__tests__/*`. When arena absorbs the SDK, it must also absorb those tests. Otherwise the vendored copy is untested for SDK-internal behaviors.

### 9.12 `app/participantAdmitted` and `app/participantRejected` notifications STAY

Were on deletion list. Codex caught: admission is async after `apps/create` returns; outcome notifications fire later, separately from any RPC return value. They're not collapsible into `addParticipant` return.

---

## 10. CORRECTIONS from Codex round 3

Round 3 said "Not correct" and named 13 issues. 5 fatal (architectural holes), 8 mechanical. Resolutions:

### 10.1 `messages/send` STAYS as wire RPC; internally routes to TM (decision γ)

`messages/send` was internally contradictory in the plan (listed as "stays" but also "dissolves under TM topology"). Resolved: **stays.** The wire-level RPC interface for senders is preserved. Server-side, the handler delegates to the TM:

```
agent A → messages/send(conversationId, parts)  [wire RPC, unchanged]
        → server handler looks up task for conversation
        → finds registered TM endpoint
        → network.send(to: TM, payload: <message>) via in-memory loopback (default-dm/default-group) or real WS (app TM)
        → TM decides forward/block/patch
        → result mapped back to RPC success or RPC error with reason/feedback
```

Sender experience preserved. Failure channel preserved (RPC error with reason/feedback). TM topology is internal. This resolves the "send-side hook dissolution loses failure channel" finding (F3) and the "messages/send contradiction" finding (F5).

### 10.2 TM registration uses durable `EndpointAddress`, not connection-id

Connection-ids are volatile (deleted on disconnect at `connection.ts:367`). The `tasks` row carries a durable `tm_endpoint_address: EndpointAddress` field. On TM disconnect, the address becomes unreachable but the registration persists. On reconnect, the TM re-attaches to the same address.

`endpoints/registerTaskManager(taskId)` RPC records the EndpointAddress + ownership grant. Idempotent; same EndpointAddress can re-register.

Reconnect/lease/ownership model (concrete):
- A TM "owns" a task while its EndpointAddress is registered
- Disconnect doesn't drop ownership (TM may reconnect)
- Explicit `endpoints/unregisterTaskManager(taskId)` releases ownership
- Server-initiated unregister on prolonged unreachability (TBD threshold; not v1 blocker)

### 10.3 TM authority checks land WITH `tasks/*` RPCs at introduction (Phase 6)

Was deferred to Phase 8. Security hole between Phase 6 (RPCs introduced) and Phase 8 (authority added) where any agent could call `tasks/storeMessage`, `tasks/closeTask`, etc. directly.

**Corrected:** Every task-mutation CRUD method ships with the authority check at introduction. The `caller-is-registered-TM-for-taskId-X` check is part of Phase 6, not Phase 8.

### 10.4 Phase order corrected

Original: Phase 8 (TM topology) → Phase 9 (introduce delivery service) → Phase 10 (delete Broadcaster). Phase 8 needed network.send + resolver but those came in Phase 9. Wrong order.

**Corrected sequencing:**

```
Phase -1   Arena vendors @moltzap/app-sdk (after Phase 1C lands)
Phase 0    This branch (PR #414) lands
Phase 1A   Delete surfaces, push, attestation
Phase 1B   Delete permissions surface (full scope per §9.4)
Phase 1C   Move RpcServerError/NotConnectedError/RpcTimeoutError to protocol; drop @effect/rpc bridge; single AJV  [ARENA VENDORS AFTER THIS]
Phase 1D   Delete dead lifecycle/hook orphans (apps/onJoin, apps/authorizeDispatch)
Phase 2    #161 cleanup
Phase 3    Slice F (actor-model brand types)
Phase 4    Slice A' (layered split + boundary gates) + contacts implementation
Phase 5    B1 (additive: introduce tasks schema)
Phase 6    B2 (additive: introduce tasks/* RPCs WITH TM authority checks at introduction)
Phase 7    B+E final (cutover: rename, delete app_sessions/apps/closeSession). Lifecycle notifications rename: app/sessionReady → task/ready, app/sessionFailed → task/failed, app/sessionClosed → task/closed (augmented payload)
Phase 8    Slice G1 (introduce network.send + AgentEndpointResolver multimap, dual-DI alongside Broadcaster)
Phase 9    Slice C (TM-as-endpoint topology: messages/send wires to TM internally, lifecycle notifications, task/admissionComplete, task/closing)
Phase 10   Slice G2 (migrate Broadcaster call sites, delete Broadcaster, Effect-ify MessageService)
Phase 11   Arena bumps moltzap deps; breaks submodule; switches to npm pins; replaces server-core devDep with testcontainers
```

Network.send + resolver (G1, Phase 8) lands BEFORE TM topology (slice C, Phase 9) which depends on it. Broadcaster removal (G2, Phase 10) is last. Phase 9 is now slice C, not the original Phase 8.

### 10.5 Lifecycle notification migration explicit

Existing `app/sessionReady`, `app/sessionFailed`, `app/sessionClosed` notifications **rename** in B+E:
- `app/sessionReady` → `task/ready` (same payload)
- `app/sessionFailed` → `task/failed` (same payload)
- `app/sessionClosed` → `task/closed` with **augmented payload**: `{ taskId, conversations, closedBy: { agentId, ownerId } }` (replaces today's `{sessionId, closedBy: AgentId}`)

New notification (Phase 9): `task/admissionComplete` — fires to TM with `admittedAgentIds`. Does NOT replace `task/ready`; both exist:
- `task/admissionComplete` — server → TM, signals "you can begin setup, here are admitted agents"
- `task/ready` — server → participants, signals "task is interactive"

### 10.6 ErrorCodes purge (added to deletion list)

- `ErrorCodes.SkillTimeout`
- `ErrorCodes.SkillMismatch`
- `ErrorCodes.PermissionTimeout`
- `ErrorCodes.PermissionDenied`
- `AppParticipantRejected.stage` enum: drop `capability`, `permission` entries

Lands with Phase 1B (permission surface deletion).

### 10.7 Contacts implementation sequenced

Plan said "needs implementing." Now scheduled: contacts implementation lands in Phase 4 (slice A') alongside the layered split work, since that's the structural reorganization where adding contact handlers to `createCoreApp` registration fits naturally. Includes:
- `contacts/list`, `contacts/add`, `contacts/accept`, `contacts/byId` server handlers (4 RPCs, not 3 — caught the missed one)
- `contact/request`, `contact/accepted` notification senders
- Contact-graph DB schema (or reuse existing if present)
- `createCoreApp` registers the new handlers

### 10.8 Arena vendoring order: error relocation lands FIRST

Original Phase -1 (arena vendors) before Phase 1C (move errors to protocol) created broken imports in arena's vendored code. **Corrected:** Phase 1C lands first, then arena vendors against the corrected client. Updated in §10.4 sequencing.

### 10.9 `app-sdk` packaging concrete step

"Deleted from publish" requires explicit change. **Action:** in Phase 11 (or earlier coordination):
1. Add `"private": true` to `packages/app-sdk/package.json`
2. Eventually remove from `pnpm-workspace.yaml` packages list
3. Eventually delete `packages/app-sdk/` directory

Order matters: `"private": true` first (freezes publishing without breaking workspace internals); workspace removal once no internal consumer remains; directory deletion last.

### 10.10 Mute/archive scope clarification

Today's mute/archive enforcement is per-connection cache (`broadcaster.ts:56` checks `conn.mutedConversations`). Multi-socket same-agent: other sockets keep receiving until reconnect. **Plan does not claim more enforcement than exists.** Status quo preserved; cross-socket consistency is a future scaling concern, not part of this refactor.

### 10.11 AgentEndpointResolver updates on auth transition

Connections are added pre-auth; `conn.auth` is assigned later in `auth/connect` handler. Resolver:
- On WS connect: NOT yet added to resolver (no agentId known)
- On auth/connect success: add `(agentId → endpointAddress)` to resolver
- On disconnect: remove (whether authed or not)
- Multimap semantics throughout: `HashMap<AgentId, Set<EndpointAddress>>` (same agent, multiple connections)

### 10.12 Verdict on the plan

After 3 codex rounds + iterative scope reductions, the plan is convergent. Remaining work is execution, not design. Round 4 might surface 1-2 small issues during implementation but no more architectural holes are pending.

---

## 7. Failure modes and critical gaps

For each new codepath, one realistic production failure scenario:

| Codepath | Failure mode | Test? | Error handling? | User-visible? |
|---|---|---|---|---|
| TM dispatch `network.send → app endpoint` | App endpoint queue full | Need new test | `Block` verdict (fail-closed) | Yes — message rejected with reason |
| `AgentEndpointResolver.resolveAgent` | Agent disconnected mid-fan-out | Need new test | `Some(addr) → None` transition; caller handles | Yes — partial fan-out logged |
| `default-dm` SELECT-before-INSERT | Concurrent creation race | Existing dispatcher tests partial | Application-layer monitoring; ratchet to DB constraint if observed | No (low scale) |
| Hook RPC server-side timeout | App hung, no response | Existing 30-app-hooks tests cover | Fail-closed verdict | Yes — message rejected |
| B+E destructive migration | Migration fails mid-DDL | Need migration test | Migration is atomic per statement; manual rollback (drop fresh DB) | No (pre-prod) |
| Effect Context tag boundary | Handler accidentally yields wrong tag | New negative type-test (boundary canary) | TS2344 compile error | No (caught at build) |
| ESLint no-restricted-imports | Cross-layer import sneaks in | New lint rule | CI failure | No (caught at PR) |
| Arena bumps moltzap submodule break | Arena's existing tests fail under new wire shape | Conformance suite + arena's werewolf E2E | Migration playbook + version pin | Yes if arena ships broken (mitigated by CI gate) |

**Critical gaps requiring NEW tests** (regression rule applies):
1. Hook-as-TM-message regression test (synthetic 5-hook fixture in moltzap)
2. arena werewolf full-game E2E under refactored stack (in arena repo)
3. Boundary type-test canaries (new files under `packages/server/src/{network,task}/__tests__/`)
4. Destructive migration round-trip test (fresh DB → run migration → assert schema)
5. AgentEndpointResolver fan-out perf test (50 recipients <50ms)

---

## 8. Open implementation issues (Codex-flagged, not blocking architecture)

| Issue | Disposition |
|---|---|
| `DeliveryService` name collision with existing delivery-tracking service (`packages/server/src/services/delivery.service.ts:16`) | Rename the new outbound-routing service. Candidates: `RouterService`, `OutboundDelivery`, or fold into `ConnectionManager.send`. |
| Backpressure policy explicit semantics | Default per-descriptor: admission = `Fail`, notifications = `DropOldest`, sync RPC = `Block` with ceiling. |
| ESLint vs oxlint for `no-restricted-imports` | ESLint. The existing rule is at `eslint.config.mjs:64`. |
| AJV singleton discipline | Frozen singleton at module load; explicit factory boundary if any caller needs to extend. |
| Subpath exports for `{network,task,app}` | Add to `packages/protocol/package.json` `"exports"` block. Audit ./schemas re-export path too. |
| Effect Context tag absence as "strong" boundary | Belt+suspenders with tsconfig project refs + ESLint rule. Not relying on Context tags alone. |
| @effect/rpc dependency removal | When the bridge code drops, also drop the @effect/rpc dep from package.json. |
