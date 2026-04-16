<!-- /autoplan restore point: /home/tapanc/.gstack/projects/chughtapan-moltzap/worktree-agile-wobbling-catmull-autoplan-restore-20260414-233139.md -->
# AppHost — Standardized App Framework for MoltZap

## Problem

MoltZap needs a standardized interface for building **Apps** — structured services that agents participate in (Scheduler, Werewolf, prediction markets, etc.). Today, downstream consumers like `moltzap-arena` build game infrastructure from scratch, tightly coupling game logic to MoltZap primitives (conversations, agents, messages) with no shared admission, policy, or lifecycle layer.

The architecture spec defines three policy gates (Identity, Capability, Permission) that every App must enforce before admitting agents. This work adds the `AppHost` framework to `@moltzap/server-core` — a standardized way to define, register, and host Apps with built-in policy enforcement.

## Naming Decision

**`AppHost`** — the server-core component that *hosts* developer-defined Apps. It handles admission, policy enforcement, sessions, and lifecycle. Developers register App manifests with the host.

- `AppHost` (the policy engine + session manager in server-core)
- `AppManifest` (the JSON declaration of what an App needs)
- `AppSession` (a running instance of an App, backed by a group conversation)
- `ContactChecker` (injectable identity policy — contacts live outside server-core)

Rejected names: `BaseApp` (sounds like abstract class), `AgentApp` (ambiguous agent-vs-app), `AppRuntime` (too enterprise).

---

## Downstream Customer: moltzap-arena

The Arena is the first real consumer. Today it builds:
- `GameRoom` — maps Discord-style channels (town_square, werewolf_den, role_{id}) to MoltZap conversations
- `GameMaster` — pure state machine returning `Instruction[]` arrays
- `GameOrchestrator` — executes instructions, manages phase timers, wires betting/spectators
- `AgentManager` — registers agents, creates conversations via `@moltzap/server-core`

**What Arena needs from AppHost:**
1. Register Werewolf as an App with a manifest (permissions, skill URL, participant limits)
2. Standard session creation that sets up the conversation + channels
3. Policy enforcement so rogue agents can't join game sessions
4. Lifecycle hooks so the orchestrator knows when all agents are admitted and ready

**What Arena does NOT need AppHost to do:**
- Game logic (stays in `@moltzap/arena-engine`)
- Instruction execution (stays in orchestrator)
- Betting/spectator management (Arena-specific, not generic)
- Phase timers (game-specific)

This informs the boundary: AppHost handles **admission and sessions**, not game/app logic.

---

## Design Decisions

1. **App Session = collection of tagged conversations**: A session is NOT a single conversation. It's a set of conversations linked via `metadata.tags: [{ appSessionId, channelKey }]`. The `app_sessions` table tracks session state; conversations are linked by metadata, not FK. Agents become `conversation_participants` only after passing all three policies.

2. **Identity Policy is injectable**: `server-core` has no contacts table. Define a `ContactChecker` interface (`areInContact(userIdA, userIdB) → boolean`); downstream (moltzap-app) supplies the implementation. Default passes all agents (for dev/testing). AppHost resolves agent IDs to owner user IDs via the batch-fetched agent map before calling `areInContact()` — the checker never sees agent IDs.

3. **Capability: challenge/response**: Server emits `app/skillChallenge` event → agent calls `apps/attestSkill` → handler resolves pending promise. 30s timeout.

4. **Permission: request/grant via control channel**: Server emits `app/permissionRequest` → user approves via `apps/grantPermission`. 120s timeout for required permissions.

5. **`registerApp()` on CoreApp**: App developers register their manifest. AppHost looks up the manifest by `appId` at session creation time.

6. **No separate "channel" concept**: Apps declare conversations to auto-create in the manifest. AppHost creates them as normal group conversations with `name` set and `metadata.tags: [{ appSessionId, channelKey }]` for discoverability. Apps find their conversations by querying metadata tags. No `app_session_channels` table, no `addChannel()` API. Conversations are conversations.

---

## App Manifest Schema

```typescript
// packages/protocol/src/schema/apps.ts
AppManifestSchema = Type.Object({
  appId: Type.String(),
  name: Type.String(),
  description: Type.Optional(Type.String()),
  permissions: Type.Object({
    required: Type.Array(Type.Object({
      resource: Type.String(),
      access: Type.Array(Type.String()),
    })),
    optional: Type.Array(Type.Object({
      resource: Type.String(),
      access: Type.Array(Type.String()),
    })),
  }),
  skillUrl: Type.Optional(Type.String()),        // omit → skip capability check
  skillMinVersion: Type.Optional(Type.String()),
  challengeTimeoutMs: Type.Optional(Type.Integer({ default: 30000 })),
  permissionTimeoutMs: Type.Optional(Type.Integer({ default: 120000 })),
  limits: Type.Optional(Type.Object({
    maxParticipants: Type.Optional(Type.Integer({ default: 50 })),
  })),
  conversations: Type.Optional(Type.Array(Type.Object({
    key: Type.String(),           // e.g. "town_square", "werewolf_den" — stored in metadata tag
    name: Type.String(),          // set as conversation.name
    participantFilter: Type.Optional(
      stringEnum(["all", "initiator", "none"])  // "none" = empty, app manages membership
    ),
  }))),
}, { additionalProperties: false })
```

---

## Files to Create / Modify

### `@moltzap/protocol`

**1. `packages/protocol/src/schema/apps.ts`** — NEW
- `AppPermissionSchema` — `{ resource: string, access: string[] }`
- `AppManifestSchema` — full manifest as above
- `AppSessionSchema` — `{ id, appId, initiatorAgentId, status, conversations: Record<string, ConversationId>, createdAt }`
- `AppParticipantStatusEnum` — `"pending" | "admitted" | "rejected"`
- Static type exports

**2. `packages/protocol/src/schema/methods/apps.ts`** — NEW
- `AppsCreateParamsSchema` — `{ appId, invitedAgentIds: AgentId[] }`
- `AppsCreateResultSchema` — `{ session: AppSession }`
- `AppsAttestSkillParamsSchema` — `{ challengeId, skillUrl, version }`
- `AppsAttestSkillResultSchema` — `{}`
- `AppsGrantPermissionParamsSchema` — `{ sessionId, agentId, resource, access[] }`
- `AppsGrantPermissionResultSchema` — `{}`

**3. `packages/protocol/src/schema/events.ts`** — UPDATE
Add events:
- `app/skillChallenge` — `{ challengeId, sessionId, appId, skillUrl, minVersion? }`
- `app/permissionRequest` — `{ sessionId, appId, resource, access[], requestId }`
- `app/participantAdmitted` — `{ sessionId, agentId, grantedResources[] }`
- `app/participantRejected` — `{ sessionId, agentId, reason, stage }`
- `app/sessionReady` — `{ sessionId, conversations: Record<string, ConversationId> }`

**4. `packages/protocol/src/schema/index.ts`** — UPDATE
Add exports.

**5. `packages/protocol/src/validators.ts`** — UPDATE
Add compiled validators.

### `@moltzap/server-core`

**6. `packages/server/src/app/core-schema.sql`** — UPDATE
Add tables:
- `app_sessions` — `{ id, app_id, initiator_agent_id, status, created_at }` (no conversation_id — conversations linked via metadata tags)
- `app_session_participants` — `{ session_id, agent_id, status, rejection_reason, admitted_at }`
- `app_permission_grants` — `{ id, user_id, app_id, resource, access[], granted_at }`

**7. `packages/server/src/db/database.ts`** — UPDATE
Add Kysely table interfaces for new tables.

**8. `packages/server/src/services/app-session.service.ts`** — NEW
CRUD for app sessions and participant status tracking.

**9. `packages/server/src/services/app-permission.service.ts`** — NEW
Permission grant CRUD (upsert, check, list).

**10. `packages/server/src/app/app-host.ts`** — NEW
Core policy engine:

```typescript
export interface ContactChecker {
  areInContact(userIdA: string, userIdB: string): Promise<boolean>;
}

export class AppHost {
  private pendingChallenges: Map<string, PendingChallenge>
  private pendingPermissions: Map<string, PendingPermission>
  private manifests: Map<string, AppManifest>

  constructor(deps: {
    db: Kysely<Database>,
    broadcaster: Broadcaster,
    connections: ConnectionManager,
    appSessionService: AppSessionService,
    appPermissionService: AppPermissionService,
    conversationService: ConversationService,
    contactChecker?: ContactChecker,
    logger: Logger,
  })

  registerApp(manifest: AppManifest): void
  setContactChecker(checker: ContactChecker): void

  // Creates session + channels, starts async admission for each invited agent
  createSession(appId: string, initiatorAgentId: string, invitedAgentIds: string[]): Promise<AppSession>

  // Called by apps/attestSkill handler
  resolveChallenge(challengeId: string, skillUrl: string, version: string): void

  // Called by apps/grantPermission handler
  resolvePermission(userId: string, appId: string, resource: string, access: string[]): void

  // Internal policy chain (per agent, async)
  private admitAgent(session, manifest, initiatorAgentId, agentId): Promise<void>
  private checkIdentity(agentId, initiatorAgentId): Promise<void>
  private checkCapability(session, agentId, manifest): Promise<void>
  private checkPermission(session, agentId, manifest): Promise<string[]>
}
```

**11. `packages/server/src/app/handlers/apps.handlers.ts`** — NEW
RPC handlers:
- `apps/create` — creates session via AppHost, returns session + channels
- `apps/attestSkill` — resolves capability challenge
- `apps/grantPermission` — grants permission, resolves pending request

**12. `packages/server/src/app/types.ts`** — UPDATE
Add to `CoreApp`:
```typescript
registerApp: (manifest: AppManifest) => void;
setContactChecker: (checker: ContactChecker) => void;
createAppSession: (appId: string, initiatorAgentId: string, invitedAgentIds: string[]) => Promise<AppSession>;
```

**13. `packages/server/src/app/server.ts`** — UPDATE
- Instantiate AppHost with all deps
- Register app handlers
- Expose `registerApp()` and `setContactChecker()` on returned CoreApp

**14. `packages/server/src/index.ts`** — UPDATE
Export: `AppHost`, `AppSessionService`, `AppPermissionService`, `ContactChecker`, new DB types.

---

## Policy Chain Flow

```
apps/create called by initiator agent A1
  → Validate manifest exists for appId
  → Validate initiator has owner_user_id (required for app participation)
  → Create conversations from manifest.conversations[] with name + metadata tags
  → Insert app_session row
  → For each invited agentId (async, non-blocking):
      1. Identity: contactChecker.areInContact(ownerA, ownerB)
         Fail → rejected "not a contact"
      2. Capability: emit app/skillChallenge, await apps/attestSkill (30s)
         Fail → rejected "skill mismatch" or "attestation timeout"
      3. Permission: for each required resource, check grant or emit app/permissionRequest (120s)
         Fail → rejected "permission denied" or "permission timeout"
      4. Admit: add to conversation participants, emit app/participantAdmitted
  → When all agents admitted or rejected, emit app/sessionReady
```

---

## How moltzap-arena Would Adopt This

```typescript
// In arena's server setup
import { createCoreApp } from "@moltzap/server-core";

const core = createCoreApp(config);

// Register Werewolf as an App
core.registerApp({
  appId: "werewolf",
  name: "Werewolf",
  description: "Social deduction game",
  permissions: { required: [], optional: [] },
  skillUrl: "https://arena.moltzap.com/skills/werewolf.md",
  limits: { maxParticipants: 12 },
  conversations: [
    { key: "town_square", name: "Town Square", participantFilter: "all" },
    { key: "werewolf_den", name: "Werewolf Den", participantFilter: "none" },
  ],
});

// Create a game session
const session = await core.createAppSession("werewolf", gmAgentId, playerAgentIds);
// session.conversations = { town_square: "conv-123", werewolf_den: "conv-456" }
// Each conversation has metadata.tags: [{ appSessionId: session.id, channelKey: "town_square" }]

// Add per-player role conversations at runtime (just create conversations with tags)
for (const player of players) {
  const conv = await conversationService.create("group", `${player.name} Private`, [], gmRef);
  // Tag it with the session — AppHost helper or direct metadata update
}

// GameOrchestrator finds conversations by querying metadata tags
```

This replaces the current `GameRoom.createGameRoomWithExistingAgents()` + manual `agentManager.createConversation()` calls.

---

## Verification

1. **Unit tests** — `packages/server/src/app/app-host.test.ts`:
   - Identity fail → participant rejected
   - Capability timeout → rejected
   - Permission denied → rejected  
   - Full happy path with mock deps

2. **Integration test** — `packages/server/src/__tests__/integration/30-app-host.integration.test.ts`:
   - Register app, create session, verify skill challenge sent
   - Attest skill, verify permission request sent
   - Grant permission, verify participant admitted to conversation
   - Verify session ready event

3. **Build + type check**: `pnpm -r build && pnpm -r typecheck`

---

## Implementation Order

1. Protocol schemas (apps.ts, methods/apps.ts, events update)
2. Protocol validators + type exports
3. Server-core DB schema + Kysely types
4. AppSessionService + AppPermissionService
5. AppHost class
6. App RPC handlers
7. Wire into createCoreApp + CoreApp interface
8. Unit tests
9. Integration tests
10. Export from index.ts

---

## Risk Assessment

- **Channel concept is new**: Manifest-declared channels add complexity. Could defer to V2 and let apps create conversations manually (like Arena does today). Decision: include channels — it's the key developer experience win.
- **Async admission**: Policy chain runs asynchronously per agent. Need careful promise/timeout management. Mitigated by in-memory maps with TTL cleanup.
- **No contacts in server-core**: Injectable ContactChecker means the default (allow-all) is insecure. Clear documentation needed that production deployments must inject a real checker.
- **Arena migration**: Arena will need to refactor GameRoom to use AppHost sessions. Not blocking — Arena can adopt incrementally.

---

## Review Findings & Fixes (from /autoplan)

### Critical fixes incorporated after review:

1. **Broken adoption example (CRITICAL, DX):** Plan showed `appHost.createSession()` but `appHost` was not exposed from `createCoreApp()`. Fix: add `createAppSession()` and `addChannel()` directly to `CoreApp` interface. Developer uses `core.createAppSession(...)` — one object, one import.

2. **No auth on `apps/create` (CRITICAL, Eng):** Any authenticated agent could create sessions. Fix: validate initiator is a registered agent with active status. Consider `allowedCreators` manifest field for production.

3. **Challenge replay attack (CRITICAL, Eng):** Stale `challengeId` could resolve after timeout if race condition exists. Fix: delete `challengeId` from pending map on timeout BEFORE the rejection event. Check map existence on resolve.

4. **`resolveChallenge` caller not validated (HIGH, Eng):** Any agent could attest for another agent. Fix: store `targetAgentId` in pending challenge map, assert `ctx.agentId === pendingChallenge.targetAgentId`.

5. **Permission request routing (HIGH, Eng):** `app/permissionRequest` must go to the **owner of the invited agent** (the human user), NOT the agent itself. Self-granting is an authorization bypass. Fix: add `targetUserId` to event, route via `sendToParticipant("user", ownerUserId, ...)`.

6. **No structured error codes (CRITICAL, DX):** Every rejection was a black hole. Fix: add `AppErrorCode` enum (`APP_NOT_FOUND`, `AGENT_NOT_FOUND`, `SKILL_TIMEOUT`, `SKILL_MISMATCH`, `PERMISSION_TIMEOUT`, `PERMISSION_DENIED`, `IDENTITY_REJECTED`, `MAX_PARTICIPANTS`). Every rejection event includes `{ reason, stage, suggestedAction }`.

7. **No backpressure (HIGH, Eng):** Unlimited concurrent admission chains. Fix: enforce hard cap (50) when `maxParticipants` omitted. Validate `invitedAgentIds.length <= limits.maxParticipants` in handler. Use concurrency limiter.

8. **In-memory state loss on restart (HIGH, Eng):** Pending admissions lost on crash. Fix: add `updated_at` to `app_session_participants`. On startup, query `status = 'pending'` rows older than timeout and transition to `rejected`. Log WARN.

9. **Channel concept eliminated (MEDIUM, Eng):** Channels were just conversations with labels. Fix: drop the "channel" abstraction entirely. Conversations are tagged with `metadata.tags: [{ appSessionId, channelKey }]` for discoverability. No `app_session_channels` table. `participantFilter: "none"` creates empty conversations the app manages.

10. **Configurable timeouts (MEDIUM, DX):** 30s/120s were hardcoded. Fix: add `challengeTimeoutMs` and `permissionTimeoutMs` to manifest with defaults.

11. **Default ContactChecker warning (MEDIUM, DX):** Allow-all default is insecure. Fix: log `logger.warn("AppHost using default allow-all ContactChecker — inject a real checker for production")` at startup.

12. **Dynamic conversations at runtime (MEDIUM, CEO+DX):** Arena needs per-player role conversations that can't be declared statically. Fix: apps create additional conversations via existing `conversationService.create()` and tag them with session metadata. No new API needed.

13. **owner_user_id required for app participation (HIGH, Eng):** Agents without `owner_user_id` break the permission flow (no user to route requests to). Fix: validate `owner_user_id` is set on all participating agents. Arena must create a system user as owner for its game agents.

13. **Protocol convention compliance (MEDIUM, Eng):** Use `stringEnum()` for enums, `brandedId()` for UUIDs per protocol CLAUDE.md conventions.

14. **owner_user_id required for app participation (HIGH, Eng):** Agents without `owner_user_id` break the permission flow. Fix: validate on admission, reject with clear error. Arena creates a system user as owner for game agents.

15. **Extend ErrorCodes, not a new enum (MEDIUM, Eng):** App error codes go into the existing `ErrorCodes` object in `errors.ts` (-32010 through -32018), not a separate `AppErrorCode` enum.

16. **Batch-fetch agent owners (MEDIUM, Eng):** One query to fetch all invited agents' `owner_user_id` upfront instead of N per-agent lookups.

17. **Transaction boundary for createSession (HIGH, Eng):** Wrap conversation creation + session row + participant rows in a single `db.transaction().execute()`. If any conversation fails to create, everything rolls back. Test: force a conversation creation failure, verify no orphaned rows.

18. **AppHost resolves agent→user IDs (MEDIUM, Eng):** `ContactChecker.areInContact()` takes user IDs, not agent IDs. AppHost uses the batch-fetched agent map to resolve before calling the checker.

19. **Getting started flow (HIGH, DX):** No docker-compose, no demo script, MWE is incomplete. Fix: add docker-compose.yml (Postgres + server), update `create-moltzap-server` to use `createCoreApp()` + AppHost, add `demo-app.ts` that registers 2 agents + creates an echo session + logs messages. Target TTHW: 5-10 min. Also: move `launchFleet()` out of `@moltzap/evals` into a more accessible location (server-core or a new `@moltzap/agent-runner` package) so hackathon devs don't need to import from the evals package.

20. **Expand MWE to full flow (HIGH, DX):** Current MWE shows 30% of the steps. Fix: show agent registration via HTTP, WebSocket connection, THEN `createAppSession()`. The developer needs to see the complete path.

21. **Error suggestedAction (MEDIUM, DX):** Error codes exist but lack fix guidance. Fix: every app RPC error includes `data.suggestedAction` with a concrete code snippet (e.g., "Call core.registerApp({ appId: 'werewolf', ... }) before creating sessions").

22. **server-core README (MEDIUM, DX):** No README for the package developers import. Fix: add `packages/server/README.md` with AppHost section + JSDoc on `registerApp()`, `createAppSession()`, `AppManifest`.

23. **App test utility (MEDIUM, DX):** Developers building apps need test helpers. Fix: add `setupAppTestSession()` to `test-utils/` that registers a test app + creates session + returns handles, following the existing `setupAgentPair()` pattern.

### Deferred to TODOS.md:
- Session query API (`apps/listSessions`, `apps/getSession`)
- Orphaned session cleanup (sessions where all agents rejected)
- JSDoc on all public types and methods
- Minimal working example / getting started guide
- Rate limiting session creation per agent
- Session teardown API (`apps/closeSession`) — archive/delete conversations on game end. Requires conversation archival support first (no soft-delete or archive exists in ConversationService today). Without this, every game creates conversations that persist forever in the DB. `apps/closeSession` would set session status to "closed" and archive all linked conversations (found via metadata tags). Blocked by: conversation archival feature in server-core.
- Permission grant scoping — add `session_id` to `app_permission_grants` so grants expire with sessions
- Multi-process constraint — document that in-memory pending Maps require single-process deployment; add Redis/DB-backed Maps for horizontal scaling

---

## Minimal Working Example (acceptance test for DX)

```typescript
import { createCoreApp } from "@moltzap/server-core";

const core = createCoreApp({
  databaseUrl: process.env.DATABASE_URL!,
  encryptionMasterSecret: "dev-secret-32-chars-minimum-here",
  port: 3000,
  corsOrigins: ["*"],
});

// Register a simple app — no skill attestation, no permissions
core.registerApp({
  appId: "echo",
  name: "Echo App",
  permissions: { required: [], optional: [] },
  conversations: [{ key: "main", name: "Main Channel", participantFilter: "all" }],
});

// Create a session (after agents are registered and connected)
const session = await core.createAppSession("echo", agentA.id, [agentB.id]);
console.log("Session:", session.id);
console.log("Conversations:", session.conversations);
// → { main: "conv-uuid-here" }
// The conversation has name: "Main Channel" and metadata tags linking it to the session
```

---

<!-- AUTONOMOUS DECISION LOG -->
## Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|-------|----------|---------------|-----------|-----------|----------|
| 1 | CEO | Accept premises with adjustments | Mechanical | P6 | User filed issue, architecture spec exists | Reject plan entirely |
| 2 | CEO | SELECTIVE EXPANSION mode | Mechanical | P6 | Autoplan default | SCOPE EXPANSION |
| 3 | CEO | Make capability attestation optional | Mechanical | P3+P5 | No current consumer needs it; skip when no skillUrl | Force mandatory attestation |
| 4 | CEO | Accept dynamic channels expansion | Mechanical | P2 | In blast radius, Arena needs it | Defer to V2 |
| 5 | CEO | Accept lifecycle hooks expansion | Mechanical | P1 | 20 LOC, makes API useful | Defer |
| 6 | CEO | Defer session query API | Mechanical | P3 | Not needed for Arena game loop | Include in scope |
| 7 | Eng | Add auth check on apps/create | Mechanical | P1 | Security gap, no valid reason to skip | Leave open |
| 8 | Eng | Store targetAgentId in challenge map | Mechanical | P1+P5 | Prevents attestation by wrong agent | Trust agent identity |
| 9 | Eng | Route permissionRequest to owner user | Mechanical | P1 | Self-granting is auth bypass | Route to agent |
| 10 | Eng | Add backpressure (default 50 max) | Mechanical | P3 | Unbounded concurrency is a DoS vector | No limit |
| 11 | Eng | Add restart recovery via DB query | Mechanical | P1 | Silent failure on restart | Accept data loss |
| 12 | Eng | Add "none" participantFilter | Mechanical | P5 | Explicit > implicit empty behavior | Leave ambiguous |
| 13 | Eng | Use stringEnum/brandedId per conventions | Mechanical | P4 | DRY with existing protocol patterns | Ad-hoc types |
| 14 | DX | Fix CoreApp to expose createAppSession | Mechanical | P5 | Example didn't compile | Keep separate AppHost |
| 15 | DX | Add AppErrorCode enum | Mechanical | P1 | Every error path needs structured output | Generic RpcError |
| 16 | DX | Add configurable timeouts to manifest | Mechanical | P1 | Hardcoded limits are an escape hatch gap | Keep hardcoded |
| 17 | DX | Log WARN for default ContactChecker | Mechanical | P5 | Insecure default should be visible | Silent default |
| 18 | DX | Add addChannel() for dynamic channels | Mechanical | P1+P2 | Arena needs per-player channels | Static only |

---

## Cross-Phase Themes

**Theme: API surface discoverability** — flagged in CEO (thin extraction concern), Eng (missing auth on create), and DX (broken example, missing JSDoc). High-confidence signal that the developer-facing API needs careful attention during implementation. The fix (expose everything on CoreApp, add JSDoc, write MWE) addresses all three.

**Theme: In-memory state fragility** — flagged in CEO (6-month regret) and Eng (restart recovery). The pending maps are necessary for async admission but need DB backing for production reliability.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | clean (via /autoplan) | 5 findings, all auto-resolved |
| Eng Review | `/plan-eng-review` | Architecture & tests | 2 | clean (PLAN) | Run 1: 8 via autoplan. Run 2: 6 new (owner_user_id, metadata tags, ErrorCodes, batch fetch, transaction, areInContact) |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | skipped | No UI scope |
| DX Review | `/plan-devex-review` | Developer experience gaps | 2 | clean (PLAN) | Run 1: 5 via autoplan (score 5→7). Run 2: 5 new (getting started flow, MWE expansion, error suggestedAction, README, test utility). Score 5→7 |
| Outside Voice | Claude subagent | Independent challenge | 3 | issues_found | 3 runs across autoplan + eng + dx. Key: metadata accepted, transaction added, teardown deferred |

**VERDICT:** CEO + ENG + DX CLEARED — 5 reviews complete, 0 unresolved critical issues. 23 total findings incorporated. Target TTHW: 5-10 min. `launchFleet()` to be relocated for DX.
