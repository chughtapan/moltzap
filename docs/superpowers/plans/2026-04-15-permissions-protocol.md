# First-Class Permissions Protocol — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the permission system from the `app/*` namespace to a dedicated `permissions/*` namespace, replace the inline broadcaster-based permission flow with an externalized `PermissionHandler` interface (same pattern as `ContactChecker`), add `permissions/list` and `permissions/revoke` RPCs, and add `onPermissionRequired` handler to the client SDK.

**Architecture:** The `PermissionHandler` interface replaces the current `pendingPermissions` map + `resolvePermission()` + `broadcaster.sendToAgent()` flow. Server-core calls `permissionHandler.requestPermission()` and awaits a `Promise<string[]>`. The wrapping layer provides the implementation (push notification, web UI, agent relay, etc.). This matches the `ContactChecker` externalization pattern. `permissions/list` and `permissions/revoke` are thin Kysely queries on `app_permission_grants`, callable by agents scoped to `ctx.ownerUserId`.

**Base branch:** `feat/issue-45` (PR #51 — removes users/participant_type from server-core)

**Tech Stack:** TypeBox (protocol schemas), AJV (validation), Kysely (DB), Vitest (tests)

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/protocol/src/schema/events.ts` | Modify | Rename `AppPermissionRequest` → `PermissionsRequired` in `EventNames` |
| `packages/protocol/src/schema/methods/apps.ts` | Modify | Remove `AppsGrantPermission*` schemas, add `PermissionsListParams/Result`, `PermissionsRevokeParams/Result` |
| `packages/protocol/src/validators.ts` | Modify | Remove `appsGrantPermissionParams`, add `permissionsListParams`, `permissionsRevokeParams` |
| `packages/protocol/src/types.ts` | Modify | Update type re-exports |
| `packages/server/src/app/app-host.ts` | Modify | Add `PermissionHandler` interface, `setPermissionHandler()`, `listGrants()`, `revokeGrant()`. Remove `pendingPermissions`, `resolvePermission()`, `broadcaster.sendToAgent` permission call. Refactor `checkPermissions()` to use handler. |
| `packages/server/src/app/app-host.test.ts` | Modify | Add tests for handler interface, listGrants, revokeGrant. Remove `resolvePermission` tests. |
| `packages/server/src/app/handlers/apps.handlers.ts` | Modify | Remove `apps/grantPermission` handler. Add `permissions/list` and `permissions/revoke`. |
| `packages/server/src/app/types.ts` | Modify | Add `setPermissionHandler` to `CoreApp` interface |
| `packages/server/src/app/server.ts` | Modify | Wire `setPermissionHandler` on `CoreApp` return object |
| `packages/client/src/service.ts` | Modify | Add `on("permissionRequired", ...)` handler |
| `packages/client/src/service.test.ts` | Modify | Add tests for `onPermissionRequired` |
| `packages/client/src/channel-core.ts` | Modify | Add optional `onPermissionRequired` hook |
| `packages/client/src/index.ts` | Modify | Export `PermissionRequiredData` type |
| `docs/guides/building-apps.mdx` | Modify | Update event/RPC names, document handler pattern |

---

### Task 1: Protocol — Rename Event, Remove Grant RPC, Add List/Revoke Schemas

**Files:**
- Modify: `packages/protocol/src/schema/events.ts:11-26`
- Modify: `packages/protocol/src/schema/methods/apps.ts`
- Modify: `packages/protocol/src/validators.ts`
- Modify: `packages/protocol/src/types.ts`

- [ ] **Step 1: Rename event in EventNames and schema**

In `packages/protocol/src/schema/events.ts`, change:
```typescript
// EventNames: rename key and value
AppPermissionRequest: "app/permissionRequest",
// becomes:
PermissionsRequired: "permissions/required",
```

Rename the schema export:
```typescript
// AppPermissionRequestEventSchema → PermissionsRequiredEventSchema
// Same shape, just rename the export
export const PermissionsRequiredEventSchema = Type.Object(
  {
    sessionId: AppSessionId,
    appId: Type.String(),
    resource: Type.String(),
    access: Type.Array(Type.String()),
    requestId: Type.String({ format: "uuid" }),
    targetUserId: Type.String({ format: "uuid" }),
  },
  { additionalProperties: false },
);
```

- [ ] **Step 2: Remove grant schemas, add list/revoke in `packages/protocol/src/schema/methods/apps.ts`**

Remove `AppsGrantPermissionParamsSchema`, `AppsGrantPermissionResultSchema`, and their type exports.

Add:
```typescript
export const PermissionsListParamsSchema = Type.Object(
  {
    appId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const PermissionsListResultSchema = Type.Object(
  {
    grants: Type.Array(
      Type.Object(
        {
          appId: Type.String(),
          resource: Type.String(),
          access: Type.Array(Type.String()),
          grantedAt: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const PermissionsRevokeParamsSchema = Type.Object(
  {
    appId: Type.String(),
    resource: Type.String(),
  },
  { additionalProperties: false },
);

export const PermissionsRevokeResultSchema = Type.Object(
  {},
  { additionalProperties: false },
);

export type PermissionsListParams = Static<typeof PermissionsListParamsSchema>;
export type PermissionsListResult = Static<typeof PermissionsListResultSchema>;
export type PermissionsRevokeParams = Static<typeof PermissionsRevokeParamsSchema>;
export type PermissionsRevokeResult = Static<typeof PermissionsRevokeResultSchema>;
```

- [ ] **Step 3: Update `packages/protocol/src/validators.ts`**

Remove `AppsGrantPermissionParamsSchema` import and `appsGrantPermissionParams` validator.

Add:
```typescript
import {
  PermissionsListParamsSchema,
  PermissionsRevokeParamsSchema,
} from "./schema/index.js";

// In validators object:
permissionsListParams: ajv.compile(PermissionsListParamsSchema),
permissionsRevokeParams: ajv.compile(PermissionsRevokeParamsSchema),
```

- [ ] **Step 4: Update `packages/protocol/src/types.ts`**

Remove `AppsGrantPermissionParams` and `AppsGrantPermissionResult` re-exports.

Add:
```typescript
export type {
  PermissionsListParams,
  PermissionsListResult,
  PermissionsRevokeParams,
  PermissionsRevokeResult,
} from "./schema/methods/apps.js";
```

- [ ] **Step 5: Build protocol**

Run: `pnpm --filter @moltzap/protocol build`
Expected: Clean build.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/
git commit -m "feat(protocol): rename permission event to permissions/required, add list/revoke schemas

Remove apps/grantPermission schema (replaced by PermissionHandler interface).
Add permissions/list and permissions/revoke RPC schemas."
```

---

### Task 2: Server — Add PermissionHandler Interface and Refactor AppHost

**Files:**
- Modify: `packages/server/src/app/app-host.ts`
- Modify: `packages/server/src/app/app-host.test.ts`

- [ ] **Step 1: Write failing tests for PermissionHandler, listGrants, revokeGrant**

Add to `packages/server/src/app/app-host.test.ts`:

```typescript
describe("PermissionHandler", () => {
  it("calls handler.requestPermission during admission when permissions are required", async () => {
    const handler = {
      requestPermission: vi.fn().mockResolvedValue(["read"]),
    };
    appHost.setPermissionHandler(handler);
    appHost.registerApp({
      ...TEST_MANIFEST,
      appId: "perm-app",
      permissions: {
        required: [{ resource: "calendar", access: ["read"] }],
        optional: [],
      },
    });
    db._setAgentRows(TEST_AGENTS);

    await appHost.createSession("perm-app", "agent-init", ["agent-2"]);
    await new Promise((r) => setTimeout(r, 100));

    expect(handler.requestPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-2",
        appId: "perm-app",
        resource: "calendar",
        access: ["read"],
      }),
    );
  });

  it("rejects agent when no handler is set and permissions are required", async () => {
    appHost.registerApp({
      ...TEST_MANIFEST,
      appId: "perm-app",
      permissions: {
        required: [{ resource: "calendar", access: ["read"] }],
        optional: [],
      },
    });
    db._setAgentRows(TEST_AGENTS);

    await appHost.createSession("perm-app", "agent-init", ["agent-2"]);
    await new Promise((r) => setTimeout(r, 100));

    expect(broadcaster.sendToAgent).toHaveBeenCalledWith(
      "agent-2",
      expect.objectContaining({
        event: "app/participantRejected",
      }),
    );
  });
});

describe("listGrants", () => {
  it("returns empty array when no grants exist", async () => {
    const grants = await appHost.listGrants("user-1");
    expect(grants).toEqual([]);
  });

  it("filters by appId when provided", async () => {
    const grants = await appHost.listGrants("user-1", "test-app");
    expect(grants).toEqual([]);
  });
});

describe("revokeGrant", () => {
  it("returns delete result", async () => {
    const result = await appHost.revokeGrant("user-1", "test-app", "contacts");
    expect(result.numDeletedRows).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @moltzap/server test -- --run packages/server/src/app/app-host.test.ts`
Expected: FAIL — methods don't exist.

- [ ] **Step 3: Define PermissionHandler interface and add to AppHost**

In `packages/server/src/app/app-host.ts`, add after `ContactChecker`:

```typescript
export interface PermissionHandler {
  requestPermission(params: {
    userId: string;
    agentId: string;
    sessionId: string;
    appId: string;
    resource: string;
    access: string[];
    timeoutMs: number;
  }): Promise<string[]>;
}
```

Add to AppHost class:
```typescript
private permissionHandler: PermissionHandler | null = null;

setPermissionHandler(handler: PermissionHandler): void {
  this.permissionHandler = handler;
}
```

- [ ] **Step 4: Refactor checkPermissions to use handler**

Replace the `pendingPermissions` + `broadcaster.sendToAgent` flow in `checkPermissions()` with:

```typescript
// In the required permissions loop, replace the Promise/broadcaster block with:
if (!this.permissionHandler) {
  await this.rejectAgent(
    session.id,
    agentId,
    "permission",
    `No permission handler configured for resource: ${perm.resource}`,
    "Server must configure a PermissionHandler to process permission requests",
  );
  throw new Error("No permission handler");
}

try {
  const access = await this.permissionHandler.requestPermission({
    userId: ownerUserId,
    agentId,
    sessionId: session.id,
    appId: session.appId,
    resource: perm.resource,
    access: perm.access,
    timeoutMs: manifest.permissionTimeoutMs ?? 120000,
  });

  // Store the grant
  await this.db
    .insertInto("app_permission_grants")
    .values({
      user_id: ownerUserId,
      app_id: session.appId,
      resource: perm.resource,
      access,
    })
    .onConflict((oc) =>
      oc
        .columns(["user_id", "app_id", "resource"])
        .doUpdateSet({ access }),
    )
    .execute();

  granted.push(perm.resource);
} catch {
  await this.rejectAgent(
    session.id,
    agentId,
    "permission",
    `Permission denied for resource: ${perm.resource}`,
    `Grant ${perm.resource} access via the permission prompt`,
  );
  throw new Error("Permission denied");
}
```

- [ ] **Step 5: Remove pendingPermissions and resolvePermission**

Delete from AppHost:
- `private pendingPermissions = new Map<string, PendingPermission>();`
- The `PendingPermission` interface
- The `resolvePermission()` method
- The `pendingPermissions` cleanup in `destroy()`

- [ ] **Step 6: Add listGrants and revokeGrant methods**

Add after `findGrant()`:

```typescript
async listGrants(
  userId: string,
  appId?: string,
): Promise<Array<{ appId: string; resource: string; access: string[]; grantedAt: string }>> {
  let query = this.db
    .selectFrom("app_permission_grants")
    .select(["app_id", "resource", "access", "granted_at"])
    .where("user_id", "=", userId);

  if (appId) {
    query = query.where("app_id", "=", appId);
  }

  const rows = await query.execute();
  return rows.map((r) => ({
    appId: r.app_id,
    resource: r.resource,
    access: r.access,
    grantedAt: new Date(r.granted_at).toISOString(),
  }));
}

async revokeGrant(
  userId: string,
  appId: string,
  resource: string,
): Promise<{ numDeletedRows: bigint }> {
  const result = await this.db
    .deleteFrom("app_permission_grants")
    .where("user_id", "=", userId)
    .where("app_id", "=", appId)
    .where("resource", "=", resource)
    .executeTakeFirst();

  return { numDeletedRows: result.numDeletedRows };
}
```

- [ ] **Step 7: Update event name string**

Change `eventFrame("app/permissionRequest", ...)` to `eventFrame("permissions/required", ...)` in any remaining references. After the refactor, the broadcaster call is gone, but check if `"app/permissionRequest"` appears elsewhere in the file.

- [ ] **Step 8: Run tests**

Run: `pnpm --filter @moltzap/server test -- --run packages/server/src/app/app-host.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add packages/server/src/app/app-host.ts packages/server/src/app/app-host.test.ts
git commit -m "feat(server): add PermissionHandler interface, listGrants, revokeGrant

Replace pendingPermissions/resolvePermission/broadcaster flow with
externalized PermissionHandler.requestPermission() pattern (like ContactChecker).
Remove resolvePermission() method — handler owns the full round-trip."
```

---

### Task 3: Server — Update RPC Handlers and CoreApp Interface

**Files:**
- Modify: `packages/server/src/app/handlers/apps.handlers.ts`
- Modify: `packages/server/src/app/types.ts`
- Modify: `packages/server/src/app/server.ts`

- [ ] **Step 1: Remove `apps/grantPermission`, add `permissions/list` and `permissions/revoke`**

In `packages/server/src/app/handlers/apps.handlers.ts`:

Remove the `"apps/grantPermission"` handler entirely.

Remove `AppsGrantPermissionParams` from imports. Add `PermissionsListParams`, `PermissionsRevokeParams`.

Remove `ParticipantService` import (no longer needed here).

Add:

```typescript
"permissions/list": defineMethod<PermissionsListParams>({
  validator: validators.permissionsListParams,
  handler: async (params, ctx) => {
    if (!ctx.ownerUserId) {
      throw new RpcError(
        ErrorCodes.AgentNoOwner,
        "Agent has no owner — cannot query permission grants",
      );
    }

    const grants = await deps.appHost.listGrants(ctx.ownerUserId, params.appId);
    return { grants };
  },
}),

"permissions/revoke": defineMethod<PermissionsRevokeParams>({
  validator: validators.permissionsRevokeParams,
  handler: async (params, ctx) => {
    if (!ctx.ownerUserId) {
      throw new RpcError(
        ErrorCodes.AgentNoOwner,
        "Agent has no owner — cannot revoke permission grants",
      );
    }

    await deps.appHost.revokeGrant(ctx.ownerUserId, params.appId, params.resource);
    return {};
  },
}),
```

- [ ] **Step 2: Add `setPermissionHandler` to CoreApp interface**

In `packages/server/src/app/types.ts`, add to `CoreApp`:

```typescript
import type { PermissionHandler } from "./app-host.js";

// In CoreApp interface:
setPermissionHandler: (handler: PermissionHandler) => void;
```

- [ ] **Step 3: Wire setPermissionHandler in server.ts**

In `packages/server/src/app/server.ts`, add to the return object (after `setContactChecker`):

```typescript
setPermissionHandler(handler) {
  appHost.setPermissionHandler(handler);
},
```

- [ ] **Step 4: Export PermissionHandler from package index**

In `packages/server/src/index.ts`, add:

```typescript
export type { PermissionHandler } from "./app/app-host.js";
```

- [ ] **Step 5: Build and test**

Run: `pnpm build && pnpm --filter @moltzap/server test -- --run`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/server/
git commit -m "feat(server): remove apps/grantPermission RPC, add permissions/list and permissions/revoke

Wire setPermissionHandler on CoreApp interface. Export PermissionHandler type."
```

---

### Task 4: Client SDK — Add `onPermissionRequired` Handler

**Files:**
- Modify: `packages/client/src/service.ts`
- Modify: `packages/client/src/service.test.ts`
- Modify: `packages/client/src/index.ts`

- [ ] **Step 1: Write failing test**

Add to `packages/client/src/service.test.ts`:

```typescript
import { EventNames } from "@moltzap/protocol";

describe("MoltZapService.on('permissionRequired')", () => {
  it("fires handler when permissions/required event arrives", () => {
    const service = new FakeMoltZapService();
    const received: unknown[] = [];
    service.on("permissionRequired", (data) => received.push(data));

    const event = {
      jsonrpc: "2.0" as const,
      type: "event" as const,
      event: EventNames.PermissionsRequired,
      data: {
        sessionId: "sess-1",
        appId: "test-app",
        resource: "contacts",
        access: ["read"],
        requestId: crypto.randomUUID(),
        targetUserId: crypto.randomUUID(),
      },
    };
    (Reflect.get(service, "handleEvent") as (e: typeof event) => void).call(
      service,
      event,
    );

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      sessionId: "sess-1",
      appId: "test-app",
      resource: "contacts",
      access: ["read"],
    });
  });

  it("does not fire for unrelated events", () => {
    const service = new FakeMoltZapService();
    const received: unknown[] = [];
    service.on("permissionRequired", (data) => received.push(data));

    const event = {
      jsonrpc: "2.0" as const,
      type: "event" as const,
      event: EventNames.PresenceChanged,
      data: { agentId: "agent-1", status: "online" },
    };
    (Reflect.get(service, "handleEvent") as (e: typeof event) => void).call(
      service,
      event,
    );

    expect(received).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @moltzap/client test -- --run service.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement in MoltZapService**

In `packages/client/src/service.ts`:

Add interface:
```typescript
export interface PermissionRequiredData {
  sessionId: string;
  appId: string;
  resource: string;
  access: string[];
  requestId: string;
  targetUserId: string;
}
```

Add handler array:
```typescript
private permissionRequiredHandlers: EventHandler<PermissionRequiredData>[] = [];
```

Add `on()` overload:
```typescript
on(event: "permissionRequired", handler: EventHandler<PermissionRequiredData>): void;
```

Add case to `on()` implementation:
```typescript
case "permissionRequired":
  this.permissionRequiredHandlers.push(handler as EventHandler<PermissionRequiredData>);
  break;
```

Add case to `handleEvent()`:
```typescript
case EventNames.PermissionsRequired: {
  const data = event.data as PermissionRequiredData;
  for (const h of this.permissionRequiredHandlers) h(data);
  break;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @moltzap/client test -- --run service.test.ts`
Expected: PASS

- [ ] **Step 5: Export from index**

In `packages/client/src/index.ts`, add `type PermissionRequiredData` to the service exports.

- [ ] **Step 6: Build and verify**

Run: `pnpm --filter @moltzap/client build`
Expected: Clean.

- [ ] **Step 7: Commit**

```bash
git add packages/client/
git commit -m "feat(client): add onPermissionRequired handler to MoltZapService"
```

---

### Task 5: Client SDK — Optional Permission Hook in ChannelCore

**Files:**
- Modify: `packages/client/src/channel-core.ts`

- [ ] **Step 1: Add permission hook to ChannelService and MoltZapChannelCore**

In `packages/client/src/channel-core.ts`:

Import:
```typescript
import type { PermissionRequiredData } from "./service.js";
```

Add to `ChannelService` interface:
```typescript
on(event: "permissionRequired", handler: (data: PermissionRequiredData) => void): void;
```

Add to `MoltZapChannelCore`:
```typescript
private permissionRequiredHandler: ((data: PermissionRequiredData) => void) | null = null;

onPermissionRequired(handler: (data: PermissionRequiredData) => void): void {
  this.permissionRequiredHandler = handler;
}
```

In constructor, after existing `service.on` calls:
```typescript
this.service.on("permissionRequired", (data) => {
  if (this.permissionRequiredHandler) {
    this.permissionRequiredHandler(data);
  }
});
```

- [ ] **Step 2: Build and test**

Run: `pnpm --filter @moltzap/client build && pnpm --filter @moltzap/client test -- --run`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/client/
git commit -m "feat(client): add optional onPermissionRequired hook to MoltZapChannelCore"
```

---

### Task 6: Full Build and Verification

- [ ] **Step 1:** `pnpm build` — all packages build
- [ ] **Step 2:** `pnpm test` — all tests pass
- [ ] **Step 3:** `pnpm lint` — 0 errors
- [ ] **Step 4:** `pnpm format`
- [ ] **Step 5:** `scripts/check-type-safety.sh` — 0 violations
- [ ] **Step 6:** Fix any issues
- [ ] **Step 7:** Commit fixes if needed

---

### Task 7: Update Documentation

**Files:**
- Modify: `docs/guides/building-apps.mdx`

- [ ] **Step 1: Update building-apps guide**

- Replace `app/permissionRequest` → `permissions/required`
- Replace `apps/grantPermission` → explain `PermissionHandler` interface
- Document `permissions/list` and `permissions/revoke` RPCs
- Document `setPermissionHandler()` on `CoreApp`

- [ ] **Step 2: Commit**

```bash
git add docs/
git commit -m "docs: update building-apps guide for PermissionHandler pattern and permissions/* namespace"
```

---

## CEO Review Amendments (2026-04-15)

The following changes were identified during /plan-ceo-review and must be incorporated during implementation:

### From review sections:
1. **Use `ParticipantService.requireOwnerId(ctx)`** in `permissions/list` and `permissions/revoke` handlers instead of inline `!ctx.ownerUserId` checks (DRY, Section 5)
2. **Add logging** before/after `permissionHandler.requestPermission()` calls in `checkPermissions()` (Section 8)

### From Codex outside voice (3 findings accepted):
3. **Fix `findGrant()` access-set checking** — compare stored `access[]` against required `access[]` using set containment. A prior `["read"]` grant must NOT satisfy a `["read","write"]` request.
4. **Add `DefaultPermissionHandler`** — a default handler in server-core that preserves the current broadcaster.sendToAgent() flow. `setPermissionHandler()` overrides it. Prevents breaking change for existing deployments.
5. **Typed permission errors** — distinguish `PermissionDeniedError` vs `PermissionTimeoutError` vs handler crash in `checkPermissions()` catch block. Better operability.
6. **Permission prompt coalescing** — when multiple agents owned by the same user need the same grant (userId + appId + resource), piggyback on the in-flight handler call instead of duplicating prompts.

## Eng Review Amendments (2026-04-15)

### Design revision (from Codex eng review):
7. **Keep `permissions/grant` RPC** — the DefaultPermissionHandler needs a completion path. The RPC routes to `defaultHandler.resolvePermission()`, not AppHost. Custom handlers bypass it entirely.
8. **Keep `PermissionsGrantParamsSchema`** in protocol — do NOT remove it (reverses CEO amendment to remove).
9. **Client SDK `grantPermission()` method** — add `grantPermission(params)` to MoltZapService as a convenience that calls `this.sendRpc("permissions/grant", params)`. Pairs with `onPermissionRequired`.
10. **DefaultPermissionHandler owns pending state** — has its own `pendingPermissions` Map and `resolvePermission()` method. AppHost has NO pending permission state.
11. **Post-handler access validation** — after `requestPermission()` resolves, verify the returned `access[]` covers the required access. If handler returns `[]` or partial, treat as rejection.
12. **Use `DateTimeString`** for `grantedAt` in `PermissionsListResultSchema` instead of bare `Type.String()`.
13. **Coalescing cleanup on rejection** — when the coalescing promise rejects, remove the entry from the map so future requests for the same key trigger a fresh handler call.
14. **Tests: both mock + integration** — extend app-host.test.ts with mock tests for all 20 paths, plus write integration tests against real DB for the handler→DB→coalesce flow.

## DX Review Amendments (2026-04-15)

### From DX triage (Passes 1-3):
15. **Add end-to-end permission flow example** in docs (Task 7). Show both server-side (PermissionHandler or default) and client-side (onPermissionRequired + grantPermission()) in one complete example.
16. **Add `rejectionCode` to `AppParticipantRejectedEventSchema`** — optional `stringEnum` field with typed codes (`no_handler`, `permission_denied`, `permission_timeout`, `identity_rejected`, `capability_failed`, `capability_timeout`). Backward compatible (Optional field).

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | CLEAR | mode: HOLD_SCOPE, 0 critical gaps |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 1 issue, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 1 | CLEAR | score: 7/10, DX TRIAGE |

- **OUTSIDE VOICE (CEO):** Codex found 7 issues: 3 accepted, 1 rejected, 2 build-now, 1 already decided.
- **OUTSIDE VOICE (ENG):** Codex found 6 issues: DefaultPermissionHandler completion path (critical, led to design revision), access-set check signature, handler return validation, timeout concern (re-raised, still rejected), mock harness limitations, schema consistency.
- **UNRESOLVED:** 0
- **VERDICT:** CEO + ENG + DX CLEARED. Ready to implement.
