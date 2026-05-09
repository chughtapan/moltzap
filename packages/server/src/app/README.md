# app/

Top-of-stack composition: app-host, lease registry, dispatch admission,
server boot, layered Effect.js context. Owns "who runs the work" and
the entry points that wire everything below.

## Existing contents (pre-Phase-2A.2)

- `app-host.ts` (+ tests) — AppHost, ContactService.
- `layers.ts` (+ test) — ConnIdTag, layered service composition.
- `server.ts` — `createCoreApp`.
- `hooks.ts` — host hook surface.
- `dev.ts` — dev-mode wiring (`tsx watch src/app/dev.ts`).
- `types.ts` — AgentId, UserId, ConversationId, AppId, CoreConfig.
- `config.ts` (+ test) — app-level config.
- `conversation-app-lookup.ts` — TM/app routing helper (#513 prereq 1).
- `lease-registry.ts` — dispatch lease store.
- `core-schema.sql` — bundled SQL fixture.
- `handlers/apps.handlers.ts` — Apps RPCs.

## Phase 2A.2 changes

- `lease-registry.ts` stays in `app/` (parent epic mapping is explicit:
  "minimal change; keep").
- No moves into or out of app/ during 2A.2.

## Public surface

`@moltzap/server-core/app` re-exports the app layer's symbols.

## Import policy

| From  | To                                      | Allowed?                 |
|-------|-----------------------------------------|--------------------------|
| app   | task, network, identity, transport, _infra | Yes                   |
| app   | (no layer above)                         | n/a (top of stack)       |
| below | app                                      | NO (upward forbidden)    |
