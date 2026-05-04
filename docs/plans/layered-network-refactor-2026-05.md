# Layered Network Refactor — Landing Plan

**Source:** `/plan-eng-review` session 2026-05-04, against branch `chore/strict-json-rpc-frames` (PR #414). Three Codex review rounds folded in.
**Supersedes:** the original 7-slice plan in [issue #156](https://github.com/chughtapan/moltzap/issues/156). That doc is the architect-stage design; this is the eng-stage landing plan with all corrections consolidated.

---

## 1. What this branch (PR #414) already accomplishes

10,033 lines added, 6,976 removed across 298 files. Substantive deliverables:

- **JSON-RPC 2.0 wire frames** (`packages/protocol/src/schema/frames.ts:14-71`) — `RequestFrame`, `ResponseFrame`, `NotificationFrame` with branded type carriers.
- **Descriptor-backed RPC + notification system** (`packages/protocol/src/rpc.ts:31-130`, `notification.ts`) — `defineRpc()` / `defineNotification()` pre-compile AJV validators at module load.
- **Boundary validation** — `decodeRpcParams` validates exactly once; handlers receive typed `Static<P>` with no re-checking.
- **Effect-native server→client RPC** (`packages/server/src/ws/connection.ts:211-284`) — `sendRpcToClient` uses `acquireUseRelease` over per-connection `HashMap<JsonRpcStringId, Deferred>`, with `Scope` finalizer for connection teardown; tagged-error union covers `AppDisconnected | AppCallbackRpcResponseError | AppCallbackRpcDecodeError | AppCallbackRpcSocketError`.
- **events → notifications rename** — `EventNames` → `notificationGroup`, `EventFrame` → `NotificationFrame`, `eventFrame()` → `notificationFrame()`.
- **`defineMethod()` boundary** (`packages/server/src/rpc/context.ts:129-156`) — single validation point producing typed `ResolvedRpcMethod`.
- **`@effect/rpc` bridge** with opaque schemas (`rpc-groups.ts:48-62`) — TypeBox runtime + Effect type carrier. *Decision below: drop the bridge.*

The user's first goal ("validate at boundary once, types after") is largely DONE.

---

## 2. Architectural decisions

### 2.1 Packaging: moltzap publishes wire+runtime, no SDK

**moltzap publishes (versioned npm packages, 6 total):**
- `@moltzap/protocol` — wire types, descriptors, conformance suite
- `@moltzap/client` — generic transport (WebSocket, sendRpc, subscribe, registerAgent)
- `@moltzap/server-core` — runtime
- `@moltzap/openclaw-channel`, `@moltzap/claude-code-channel`, `@moltzap/runtimes` — agent runtime adapters
- ~~`@moltzap/app-sdk`~~ — DELETED from publish surface

**arena absorbs:**
- New package `arena/packages/app-runtime/` — vendored MoltZapApp + hook context types + result/error types + the SDK test suite, tailored to werewolf
- Replaces arena's `@moltzap/app-sdk` runtime dependency

**Concrete `@moltzap/app-sdk` retirement (Phase 11 or earlier):**
1. Add `"private": true` to `packages/app-sdk/package.json` (freezes publishing)
2. Eventually remove from `pnpm-workspace.yaml` packages list
3. Eventually delete `packages/app-sdk/` directory

`examples/mountains-or-beaches/` consumes `@moltzap/app-sdk` and needs migration to "consumer builds own runtime" pattern when app-sdk dies.

**arena breaks the `lib/moltzap` git submodule** in favor of npm version pins:
- `git submodule deinit lib/moltzap` + remove from `.gitmodules`
- `vitest.workspace-aliases.ts` aliases dropped
- Cross-repo dev uses `pnpm.overrides` when iterating both repos simultaneously
- Version bumps via `pnpm update @moltzap/protocol@^X.Y.Z`

**arena replaces `@moltzap/server-core` devDependency** with testcontainers / black-box server for integration tests.

### 2.2 Errors move from client to protocol

`RpcServerError`, `NotConnectedError`, `RpcTimeoutError` move from `@moltzap/client` to `@moltzap/protocol`. They're wire-derived error tags. Stronger home.

### 2.3 Drop the `@effect/rpc` bridge

`packages/protocol/src/rpc-groups.ts:48-62` (`opaqueEffectSchema`, `bridgeEffectRpcType`) — about 80 lines of indirection. Replace with thin descriptor-driven Effect-native handler binder we own. TypeBox+AJV stays runtime authority. Single shared frozen-singleton AJV instance across `defineRpc()` and `defineNotification()` (frozen at module load; explicit factory boundary if any caller needs to extend). Drop `@effect/rpc` package dependency once no consumer remains.

### 2.4 Hook resolution: collapse by firing site

The "delete all hooks, TM primitive replaces" framing was wrong. Hooks separate by firing site. Final positions:

**SEND-side hooks DISSOLVE into TM-as-endpoint topology:**
- `apps/onBeforeMessageDelivery` → DELETE. TM's main message handler IS the gate. The block/reason/patch/feedback verdict shape lives inside TM logic, not on the wire. SDK ergonomics rebuild it as the TM message handler's return value.
- The `agent → MessageService.send → broadcast` flow becomes `agent → network.send(to: TM) → TM decides forward/block/patch via existing CRUD`. **`messages/send` STAYS as wire RPC; routes to TM internally** (see §2.4.a).

**LIFECYCLE hooks DISSOLVE into notifications + TM state machine:**
- `apps/onSessionActive` → DELETE. Replaced by `task/admissionComplete` notification. TM holds participant messages during its setup window.
- `apps/onJoin` → DELETE (no consumer registered). Eager admit + TM gates participant traffic.
- `apps/onClose` → DELETE. Replaced by `task/closing` notification with augmented payload (`conversations` + `closedBy.ownerId`, not just `sessionId`).

**RECEIVE-side dispatch hook STAYS as awaitable wire RPC** (renamed, drop "hook" framing):
- `apps/onBeforeDispatch` → renamed to `task/authorizeDispatch`. Channel-to-TM awaitable round-trip. Verdict shape stays rich: `grant{leaseId, leaseTimeoutMs, dispatchMessageId} | deny{reason} | hold{reason}`. Werewolf actively uses every variant for game-rule scheduling. Cannot dissolve because the firing site is the channel (each agent's runtime), not the message-send path.

**Why the asymmetry:** SEND-side firing sites are absorbed by TM-as-endpoint topology (TM IS the gate). RECEIVE-side firing sites still need an awaitable round-trip because the channel is on the recipient and asks the TM (via wire) for permission to dispatch.

**Coupled deletions for the surviving channel→TM round-trip (LANDS IN PHASE 9, NOT PHASE 1):**
- `apps/authorizeDispatch` (channel→server admission RPC; wraps the kept `apps/onBeforeDispatch` today)
- `apps/onBeforeDispatch` itself (server→app hook RPC)
- channel-side parking/leases/coalesce/dispatchLeaseId enrichment machinery
- `service.authorizeDispatch?` interface in `packages/client/src/channel-core.ts:131,465,469,543`
- `runBeforeDispatch` server-side hook firing logic
- `dispatchBeforeDispatchHook`

These collapse together when slice C (TM-as-endpoint topology) replaces them with the new `task/authorizeDispatch` channel→TM RPC. Until then, the admission flow continues to work end-to-end.

**Surviving wire RPCs that go server→app are fail-CLOSED.** The "fail-open" behavior of `on_session_active` was a bug masquerading as a feature (sessionReady fired even when app failed setup) — fixed by the collapse to TM-state-managed setup window.

**Client-side dispatcher partitioning** (`packages/client/src/runtime/subscribers.ts`) stays; it's a client-side optimization, protocol-invisible.

#### 2.4.a `messages/send` stays as wire RPC; internally routes to TM

The wire-level RPC interface for senders is preserved. Server-side, the handler delegates to the TM:

```
agent A → messages/send(conversationId, parts)  [wire RPC, unchanged]
        → server handler looks up task for conversation
        → finds registered TM endpoint
        → network.send(to: TM, payload: <message>) via in-memory loopback (default-dm/default-group) or real WS (app TM)
        → TM decides forward/block/patch
        → result mapped back to RPC success or RPC error with reason/feedback
```

Sender experience preserved. Failure channel preserved (RPC error with reason/feedback). TM topology is internal.

#### 2.4.b TM authority model (real new work, lands with `tasks/*` RPCs at introduction)

"TM uses existing CRUD" is glib. The CRUD methods need a new authority dimension: **caller is the registered TM for taskId X**. Affected methods (~5-7 lines per method):
- `tasks/storeMessage`
- `tasks/addParticipant` / `tasks/removeParticipant`
- `tasks/closeTask`
- `tasks/createConversation` / `tasks/closeConversation`
- Any other task-mutation CRUD

**Authority checks ship WITH the `tasks/*` RPCs at introduction (Phase 6), not deferred.** Otherwise there's a security hole between Phase 6 (RPCs introduced) and Phase 8 (authority added) where any agent could call `tasks/storeMessage` directly.

Plus a registration mechanism: `endpoints/registerTaskManager(taskId)` RPC. The `tasks` row carries a durable `tm_endpoint_address: EndpointAddress` field (NOT volatile connection-id). On TM disconnect, the address becomes unreachable but the registration persists. On reconnect, the TM re-attaches to the same address. Idempotent. Explicit `endpoints/unregisterTaskManager(taskId)` releases ownership. Server-initiated unregister on prolonged unreachability is TBD; not v1 blocker.

### 2.5 Permissions/attestation deletion (not migration)

Verified zero usage in arena (the only known consumer). Werewolf manifest declares `permissions: { required: [], optional: [] }`. Full deletion scope:

**Permissions:**
- `permissions/grant`, `permissions/list`, `permissions/revoke` RPCs
- `permissions/required` notification
- `AppManifest.permissions` field
- `AppManifest.permissionTimeoutMs` field
- `app_permission_grants` DB table
- `DefaultPermissionService` server class
- `checkPermissions` server function
- `AppParticipantRejected.rejectionCode` permission codes (`PermissionDenied`, `PermissionTimeout`, `PermissionHandlerError`, `NoPermissionHandler`)
- `AppParticipantRejected.stage` `permission` entry
- `ErrorCodes.PermissionTimeout`, `ErrorCodes.PermissionDenied` from `packages/protocol/src/schema/errors.ts`
- CLI: `packages/client/src/cli/commands/permissions.ts`
- SDK auto-response wrappers tied to permissions

**Attestation:**
- `apps/attestSkill` RPC + `app/skillChallenge` notification
- `AppManifest.skillUrl`, `AppManifest.skillMinVersion`, `AppManifest.challengeTimeoutMs` fields
- `checkCapability` server function
- `apps attest-skill` CLI subcommand
- SDK auto-response at `packages/app-sdk/src/app.ts:810`
- `AppParticipantRejected.rejectionCode` attestation codes (`AttestationTimeout`, `SkillMismatch`, `SkillVersionTooOld`)
- `AppParticipantRejected.stage` `capability` entry
- `ErrorCodes.SkillTimeout`, `ErrorCodes.SkillMismatch`

Phase 1 cleanup is a 2-3 PR chain, not one PR.

### 2.6 Surface area cleanup beyond hooks/permissions

- **Surfaces** (`surface/update|get|action|clear` + 2 notifications): zero consumer. DELETE.
- **Push notifications** (`push/register|unregister`): zero consumer. DELETE.
- **`apps/attachConversation`**: collapses into `tasks/createConversation(taskId, ...)` under composite FK schema (Phase 6/7 work, NOT Phase 1).
- **`TaskManagerAction` 5-tag union, `MutationAttempt` 3-tag union**: never wire-needed. TM calls existing CRUD; "verdicts" are sequences of RPC calls, not wire shape. DELETE from any planned protocol surface.
- **`task_manager_endpoints` table**: collapses into a column (`tm_endpoint_address`) on `tasks`.
- **`appCallbackRpcMethods` group**: name retires once apps/onBeforeDispatch renames to task/authorizeDispatch and the other `appCallback` members delete.
- **`app/hookTimeout` notification**: no hooks → no hook timeouts. DELETE.
- **`apps/onJoin`**: no consumer registered (werewolf manifest doesn't even declare it). DELETE.

### 2.7 Stays despite zero current arena usage (product calls)

- **Contacts** (`contacts/list|add|accept|byId` + 2 notifications): human identity is platform vision; future apps will use. **Needs IMPLEMENTING** in Phase 4 — `createCoreApp` doesn't register handlers today; CLI calls them but server doesn't handle.
- **Mute / Archive** (`conversations/mute|unmute|archive|unarchive` + 2 notifications): CLI uses; server filters delivery. **Status quo preserved**: today's enforcement is per-connection cache (`broadcaster.ts:56` checks `conn.mutedConversations`); cross-socket consistency is a future concern, not in scope.
- **Rich Presence** (`presence/update`): CLI uses.
- **`presence/subscribe`**: live server handler at `presence.handlers.ts:23`; required for explicit subscribers.
- **`app/participantAdmitted` and `app/participantRejected` notifications**: admission is async after `apps/create` returns; outcome notifications fire later, separately from any RPC return value. Not collapsible into `addParticipant` return.

### 2.8 TM same-process loopback (no short-circuit)

`default-dm` and `default-group` task managers ALWAYS route through `network.send` even in-process. In-memory loopback. One code path, one set of tests. No "preserve auth/ack/logging semantics" verbal contract needed.

### 2.9 Lifecycle notification renames (Phase 7 / B+E cutover)

Existing `app/sessionReady`, `app/sessionFailed`, `app/sessionClosed` notifications **rename**:
- `app/sessionReady` → `task/ready` (same payload)
- `app/sessionFailed` → `task/failed` (same payload)
- `app/sessionClosed` → `task/closed` with **augmented payload**: `{ taskId, conversations, closedBy: { agentId, ownerId } }` (replaces today's `{sessionId, closedBy: AgentId}`)

New notification (Phase 9): `task/admissionComplete` — fires to TM with `admittedAgentIds`. Does NOT replace `task/ready`; both exist:
- `task/admissionComplete` — server → TM, signals "you can begin setup, here are admitted agents"
- `task/ready` — server → participants, signals "task is interactive"

### 2.10 Slice reshape (vs. issue #156 original)

| Slice | Original (#156) | Revised |
|---|---|---|
| A | Protocol split + handler Effect Context redesign | **REBASE on this branch.** Most of A's "Context redesign" already done. Remaining: split `rpcMethods` into 3 layered tuples (network/task/app), move handlers under `packages/server/src/{network,task,app}/handlers/`, activate tsconfig project refs + ESLint no-restricted-imports + Effect Context tag absence boundary gates. |
| B + E | B: task layer CRUD + DB migration. E: Session→Task rename. | **SPLIT additive→cutover (3 PRs):** B1 introduces `tasks` schema alongside `app_sessions`; B2 introduces `tasks/*` RPCs alongside `apps/*` (with TM authority at introduction); B+E final cuts over and deletes old. |
| C | Task manager runtime + 5-tag verdict + attach API | **RESHAPE.** TM = network endpoint. No verdict union. TM takes action via existing CRUD. Reshape eliminates ~half the originally-scoped surface. Includes `apps/authorizeDispatch` + admission machinery deletion (the channel→TM rename). |
| D | humanContact unification | **DEFER entirely.** Permissions deleted (not unified). |
| F | Actor-model protocol types | **GATE on #161 cleanup landing first.** Drop legacy TypeBox `UserId`/`AgentId`/`MessageId`/`ConversationId` schema-value exports from flat barrel and `./schemas` subpath. Then F's brand types own the names cleanly. |
| G | Effect-native delivery + Broadcaster removal | **SPLIT into G1 + G2.** G1 = introduce new outbound-routing service (rename to avoid collision with existing `DeliveryService` for delivery tracking — call it `RouterService` or fold into `ConnectionManager.send`) + `AgentEndpointResolver` multimap, dual-DI. G2 = migrate 16+ Broadcaster call sites, delete Broadcaster, Effect-ify `MessageService`. |

### 2.11 AgentEndpointResolver implementation constraint

`HashMap<AgentId, Set<EndpointAddress>>` (multimap — agent can have multiple connections). Maintained by `ConnectionManager`. O(1) hot path. No DB lookup.

**Auth-lifecycle:** connections are added pre-auth (`conn.auth` is assigned later in `auth/connect`). Resolver:
- On WS connect: NOT yet added (no agentId known)
- On `auth/connect` success: add `(agentId → endpointAddress)` to resolver
- On disconnect: remove (whether authed or not)
- Multimap throughout: same agent, multiple connections both go in the Set

Perf assertion: 50-recipient fan-out completes in <50ms total. Multi-process / restart durability is a future scaling concern, not v1.

---

## 3. Sequencing

```
Phase -1   Arena vendors @moltzap/app-sdk into arena/packages/app-runtime/
            └── Gates on Phase 1C (error relocation) per §2.2
            └── Submodule pin still points at moltzap with app-sdk

Phase 0    This branch (PR #414) lands as foundation
            └── JSON-RPC frames + descriptor system + Effect-native RPC

Phase 1A   Delete surfaces, push, attestation
            ├── surface/* (4 RPCs + 2 notifications + schemas)
            ├── push/register, push/unregister
            ├── apps/attestSkill + app/skillChallenge
            ├── AppManifest skill fields + checkCapability + CLI + SDK auto-response
            └── attestation rejection codes + ErrorCodes (SkillTimeout, SkillMismatch)

Phase 1B   Delete permissions surface (full scope per §2.5)
            ├── 3 permissions/* RPCs + permissions/required notification
            ├── DefaultPermissionService + checkPermissions + app_permission_grants table
            ├── AppManifest permissions + permissionTimeoutMs fields
            ├── permission rejection codes + ErrorCodes (PermissionTimeout, PermissionDenied)
            ├── packages/client/src/cli/commands/permissions.ts (full file)
            └── SDK auto-response wrappers

Phase 1C   Move RpcServerError/NotConnectedError/RpcTimeoutError client → protocol
            ├── Drop @effect/rpc bridge from rpc-groups.ts (~80 lines)
            ├── Single shared frozen-singleton AJV
            └── [ARENA VENDORS AFTER THIS]

Phase 1D   Delete dead lifecycle/hook orphans
            ├── apps/onJoin RPC + OnJoinContext (no consumer)
            ├── app/hookTimeout notification + emission sites (no hooks → no timeouts)
            ├── server dispatchOnJoinHook, onJoinParamsForWire, onAppJoin, OnJoinHook
            ├── MoltZapApp.onJoin() SDK method
            ├── apps.ts on_join field from manifest
            └── 2 fixtures + generate-protocol-docs.ts entries + app-hooks-rpc.mdx references

   NOTE: apps/authorizeDispatch and the channel-side admission machinery are NOT deleted in
   Phase 1D. They survive until Phase 9 (slice C / TM-as-endpoint topology) where the
   channel→server→app flow gets replaced by a direct channel→TM round-trip via the new
   task/authorizeDispatch RPC. Premature deletion would break werewolf's admission flow.

Phase 2    #161 cleanup
            ├── Drop legacy TypeBox UserId/AgentId/MessageId/ConversationId exports
            │   from flat barrel + ./schemas subpath
            └── Migrate internal consumers to subpath imports

Phase 3    Slice F: actor-model brand types
            └── Tiny, types-only

Phase 4    Slice A': layered split + boundary gates + contacts implementation
            ├── Split rpcMethods into networkRpcMethods, taskRpcMethods, appRpcMethods
            ├── Move handlers under {network,task,app}/handlers/ in server-core
            ├── tsconfig project refs at server-core/{network,task}/
            ├── ESLint no-restricted-imports rule
            ├── Effect Context tag absence (NetworkRequiredContext)
            └── Implement contacts: 4 RPCs + 2 notifications + handlers + DB schema

Phase 5    B1 additive: introduce tasks schema alongside app_sessions
            └── tasks, task_participants tables; tm_endpoint_address column

Phase 6    B2 additive: introduce tasks/* RPCs WITH TM authority at introduction
            ├── 11 task-layer CRUD methods (createTask, closeTask, etc.)
            ├── endpoints/registerTaskManager, endpoints/unregisterTaskManager
            └── caller-is-registered-TM-for-taskId-X check on every task-mutation

Phase 7    B+E final (cutover): rename + delete old
            ├── DROP app_sessions, app_session_* tables
            ├── DELETE apps/createSession|closeSession|getSession|listSessions|attachConversation RPCs
            ├── Rename AppSessionId → TaskId across wire and TS types
            └── Lifecycle notification renames per §2.9

Phase 8    Slice G1: introduce outbound-routing service (rename from "DeliveryService" to
            avoid collision) + AgentEndpointResolver multimap, dual-DI alongside Broadcaster

Phase 9    Slice C reshaped: TM-as-endpoint topology in full
            ├── messages/send delegates to TM via network.send (per §2.4.a)
            ├── DELETE apps/onBeforeMessageDelivery (TM absorbs)
            ├── DELETE apps/onSessionActive (notification + TM state machine)
            ├── DELETE apps/onClose (notification with augmented payload)
            ├── DELETE apps/authorizeDispatch + channel-side parking/leases/coalesce
            ├── DELETE apps/onBeforeDispatch (the server→app hook)
            ├── INTRODUCE task/authorizeDispatch (channel→TM awaitable round-trip)
            ├── INTRODUCE task/admissionComplete, task/closing notifications
            └── ~70% of app-host.ts deletes

Phase 10   Slice G2: migrate Broadcaster call sites, delete Broadcaster
            ├── 16+ call sites switch to new outbound service
            ├── Effect-ify MessageService (drop 9-param constructor)
            └── Delete Broadcaster, BroadcasterTag, BroadcasterLive

Phase 11   ARENA SIDE final cleanup
            ├── Bump @moltzap/protocol + @moltzap/client npm pins
            ├── Update EventFrame → NotificationFrame, etc. (already vendored)
            ├── Update apps/closeSession → tasks/close magic strings
            ├── Migrate any remaining sendRpc(string, ...) call sites to RpcDefinition shape
            ├── Break lib/moltzap submodule
            ├── Replace @moltzap/server-core devDep with testcontainers
            └── Run @moltzap/protocol/testing/conformance/client suite as regression gate
```

**Phase ordering rationale:**
- Phase 1C lands BEFORE Phase -1 so arena's vendored app-sdk imports the relocated error types correctly.
- Phase 8 (network.send + resolver) lands BEFORE Phase 9 (TM topology) which depends on it.
- Phase 10 (Broadcaster removal) is last; needs G1's replacement service in place first.
- Phase 1D deliberately does NOT delete `apps/authorizeDispatch` — that lands in Phase 9 with the topology change.

Phases 1A-1D are independent and can land in either order. Phase -1 (arena) gates only on Phase 1C. Phases 3-10 are mostly sequential.

---

## 4. Worktree parallelization

The work decomposes into mostly sequential phases, but a few opportunities exist for parallel lanes:

| Lane | Phases | Modules touched | Depends on |
|---|---|---|---|
| **Lane A (cleanup):** Phase 1A, 1B | protocol/, server-core/app/, server-core/__tests__/ (deletions) | — |
| **Lane A2 (errors+bridge):** Phase 1C | protocol/rpc-groups.ts, protocol/index.ts, internal consumers | — |
| **Lane A3 (orphans):** Phase 1D | protocol/schema/methods/apps.ts (on_join only), app-host.ts, SDK | — |
| **Lane B (#161 cleanup):** Phase 2 | protocol/index.ts, protocol/schemas/, internal consumer imports | — (independent of Lane A) |
| **Lane C (slice F):** Phase 3 | protocol/network/ (actor-model types) | Lane B |
| **Lane D (slice A'):** Phase 4 | protocol/{network,task,app}/, server-core/{network,task,app}/handlers/ | Lane A |
| **Lane E (slice B+E):** Phases 5,6,7 | server-core/db/, protocol/schema/methods/, server-core/__tests__/ | Lane D |
| **Lane F (slice C):** Phase 9 | server-core/app/app-host.ts → split + collapse, channel admission machinery | Lane E + Lane G1 |
| **Lane G1:** Phase 8 | server-core/ws/, server-core/services/, server-core/app/layers.ts | Lane D |
| **Lane G2:** Phase 10 | server-core/ws/broadcaster.ts → DELETE, MessageService rewrite | Lane F + Lane G1 |
| **Lane H (arena absorb):** Phase -1 | arena/packages/app-runtime/, arena root, arena tests | Lane A2 (Phase 1C) |
| **Lane I (arena cleanup):** Phase 11 | arena root, arena/packages/server/, arena CI | Lane G2 + Lane H |

**Parallel execution opportunity:**
- Phase 1A, 1B, 1C, 1D can run simultaneously (independent surfaces).
- Lane B (Phase 2) parallel with Lane A.
- Lane H (Phase -1) starts as soon as Lane A2 (Phase 1C) merges.
- Phase 3 (Slice F) blocked only on Phase 2.

**Conflict risk:**
- Lane D (handler reorganization) and Lane F (app-host.ts collapse) both touch `packages/server/src/app/app-host.ts`. Sequential.
- Lane E and Lane F both touch session lifecycle code. Sequential.
- Lane G1 introduces new files; Lane G2 modifies existing. G2 must wait for G1 + Phase 9 (TM topology).
- Phase 1A/1B/1C/1D may conflict on `apps.ts` schema files — whichever lands second silently rebases on the deletions of the first.

---

## 5. NOT in scope (explicit deferrals)

| Item | Why deferred |
|---|---|
| humanContact unification | Permissions deleted; no need to unify what's gone. Future work if scale demands. |
| Migration runner / versioned schema framework | Implementer-stage decision. Pre-prod allows destructive migration without one. |
| Multi-process AgentEndpointResolver durability | v1 is single-process; multi-process is a future scaling pass. |
| `@moltzap/client` vendoring into arena | Decision: keep `@moltzap/client` as a normal arena npm dep. Vendor only the SDK piece. Transport stays shared infrastructure. |
| Backpressure policy per-descriptor | Default per-descriptor: admission = `Fail`, notifications = `DropOldest`, sync RPC = `Block` with ceiling. Per-descriptor tuning is later. |
| Web client (`packages/web/src/lib/ws-client.ts`) refactor | That's arena's spectator-betting protocol, not a moltzap client. Out of scope. |
| Permission flow in apps | Apps build their own. moltzap doesn't provide one. |
| Skill attestation | Same — gone, no replacement in moltzap-core. |
| Agent-selection policy when multiple agents online for one user | humanContact deferred → question doesn't apply at this layer. |
| moltzap-arena werewolf integration verification | Tracked separately in arena's PR cycle. |
| Cross-socket mute/archive consistency | Multi-socket same-agent still gets messages until reconnect. Status quo preserved. |

---

## 6. What already exists (don't rebuild)

| Existing infrastructure | Why we reuse it |
|---|---|
| `defineRpc()`, `defineNotification()`, `decodeRpcParams()`, `decodeNotification()` | Already validate-at-boundary-once. Don't rebuild. |
| `sendRpcToClient` with `Deferred`/`Scope`/`acquireUseRelease` | Effect-native server→client RPC already correct. Reuse for the surviving channel→TM `task/authorizeDispatch` round-trip and any other awaitable wire RPC. |
| `JsonRpcMethod`, `JsonRpcStringId` brand types | Already in place. |
| `defineMethod()` boundary in server | Already typed. Reuse for new layered handlers. |
| Conformance suite (`packages/protocol/src/testing/conformance/`) | Already covers wire correctness. arena can run it against vendored transport. |
| `@moltzap/client` `MoltZapClient` class | Generic transport. Arena keeps using it, just stops vendoring. |
| `app/sessionClosed` notification | Already exists. Augment payload (carry conversations + closedBy.ownerId) and rename to `task/closed` in Phase 7. |
| AppHost's hook timeout firing pattern | Pattern reused (with simplifications) in the new TM dispatch. |
| Channel-side parking/leases/coalesce machinery | Stays through Phase 8. Replaced by direct channel↔TM mechanics in Phase 9. |

---

## 7. Failure modes and critical gaps

For each new codepath, one realistic production failure scenario:

| Codepath | Failure mode | Test? | Error handling? | User-visible? |
|---|---|---|---|---|
| TM dispatch `network.send → app endpoint` | App endpoint queue full | Need new test | `Block` verdict (fail-closed) | Yes — message rejected with reason |
| `AgentEndpointResolver.resolveAgent` | Agent disconnected mid-fan-out | Need new test | `Some(addr) → None` transition; caller handles | Yes — partial fan-out logged |
| `default-dm` SELECT-before-INSERT | Concurrent creation race | Existing dispatcher tests partial | Application-layer monitoring; ratchet to DB constraint if observed | No (low scale) |
| `task/authorizeDispatch` server-side timeout | App hung, no response | Existing 30-app-hooks tests cover (pre-rename) | Fail-closed verdict | Yes — message rejected |
| B+E destructive migration | Migration fails mid-DDL | Need migration test | Migration is atomic per statement; manual rollback (drop fresh DB) | No (pre-prod) |
| Effect Context tag boundary | Handler accidentally yields wrong tag | New negative type-test (boundary canary) | TS2344 compile error | No (caught at build) |
| ESLint no-restricted-imports | Cross-layer import sneaks in | New lint rule | CI failure | No (caught at PR) |
| Arena bumps moltzap submodule break | Arena's existing tests fail under new wire shape | Conformance suite + arena's werewolf E2E | Migration playbook + version pin | Yes if arena ships broken (mitigated by CI gate) |

**Critical gaps requiring NEW tests** (regression rule applies):
1. TM-routed message regression test (synthetic app fixture in moltzap)
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
| Subpath exports for `{network,task,app}` | Add to `packages/protocol/package.json` `"exports"` block. Audit `./schemas` re-export path too. |
| Effect Context tag absence as "strong" boundary | Belt+suspenders with tsconfig project refs + ESLint rule. Not relying on Context tags alone. |
| @effect/rpc dependency removal | When the bridge code drops, also drop the @effect/rpc dep from package.json. |
| Arena vendoring includes SDK test suite | Conformance suite covers protocol/server properties. SDK-specific tests (default manifest, heartbeat, reconnect, error mapping) live in `packages/app-sdk/src/__tests__/*`. Arena absorbs those tests too. |

---

## Decision evolution (folded into §2 above)

This plan went through three Codex review rounds. Earlier drafts had:

- **Round 1 (eliminated):** "All hooks delete; TM primitive replaces all of them." Reversed in Round 2: hooks separate by firing site (SEND-side dissolves, RECEIVE-side stays renamed).
- **Round 2 (partially eliminated):** Listed `apps/authorizeDispatch` as a "Phase 1 orphan deletion." Reversed in Round 3 implicitly (since the channel-to-TM round-trip survives) and explicitly during execution: `apps/authorizeDispatch` is the channel-to-server admission RPC that wraps the kept `apps/onBeforeDispatch` hook. Its deletion lives in Phase 9 with the topology change, not Phase 1.
- **Round 3 (final):** `messages/send` STAYS as wire RPC routing internally to TM; TM authority ships with `tasks/*` at introduction not deferred; phase order corrected (1C before -1, G1 before slice C); contacts need IMPLEMENTING (not just preserving schemas); B+E split additive→cutover.

The body sections above reflect the final state. This footer exists for archeological context only; do not treat as live planning.
