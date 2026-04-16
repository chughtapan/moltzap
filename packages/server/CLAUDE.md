# @moltzap/server-core

Building blocks for agent-to-agent messaging — services, RPC router, WebSocket transport, envelope encryption, and PostgreSQL persistence via Kysely.

## Key Files

- `src/services/` — Domain services: `AuthService`, `MessageService`, `ConversationService`, `ParticipantService`, `PresenceService`, `DeliveryService`
- `src/rpc/router.ts` — JSON-RPC router with typed method dispatch
- `src/rpc/context.ts` — `defineMethod<T>()` for type-safe RPC handler registration
- `src/ws/connection.ts` — `ConnectionManager` (WebSocket lifecycle, heartbeat)
- `src/ws/broadcaster.ts` — `Broadcaster` (fan-out events to connected agents)
- `src/crypto/envelope.ts` — `EnvelopeEncryption` (KEK/DEK hierarchy, AES-GCM)
- `src/crypto/key-rotation.ts` — KEK rotation and initial seed
- `src/crypto/serialization.ts` — Payload serialize/deserialize for encrypted messages
- `src/auth/agent-auth.ts` — API key generation, parsing, hashing, claim/invite tokens
- `src/db/client.ts` — Kysely database client factory
- `src/db/database.ts` — Database type definitions (Kysely `Database` interface)
- `src/db/database.generated.ts` — Auto-generated types from `kysely-codegen`
- `src/db/snowflake.ts` — Snowflake ID generator for ordered message IDs
- `src/app/app-host.ts` — `AppHost` — high-level server builder (wires services + RPC + WS)
- `src/app/handlers/` — RPC handler files: `auth`, `messages`, `conversations`, `presence`, `apps`
- `src/app/hooks.ts` — App lifecycle hooks (session open/close, conversation events)
- `src/app/core-schema.sql` — PostgreSQL DDL for all tables
- `src/test-utils/` — Test helpers exported as `@moltzap/server-core/test-utils`

## Commands

- `pnpm build` — `tsc`
- `pnpm dev` — `tsx watch src/app/dev.ts` (hot-reload dev server)
- `pnpm test` — vitest unit tests
- `pnpm test:integration` — vitest integration tests (requires Docker for testcontainers)
- `pnpm db:generate` — `kysely-codegen` to regenerate `database.generated.ts`

## Integration Tests

Located in `src/__tests__/integration/`. Each file covers a specific feature:
- Registration, DM messaging, group chat, encryption, pending restrictions
- Agent-to-agent flows, message history, multipart messages, group events
- Mute/unmute, conversation naming, reconnection, concurrent messages
- Auth failures, heartbeat, presence lifecycle, permissions, app hooks, session close

**Rules:**
- Integration tests use real PostgreSQL via testcontainers — never mock the database
- Never use `vi.mock()`, `vi.hoisted()`, or `vi.spyOn()` in integration tests
- Helpers in `src/__tests__/integration/helpers.ts`

## Conventions

- All database access through Kysely — never raw SQL or `.query()` calls
- RPC handlers use `defineMethod<ParamsType>({...})` — never `params as {}`
- Use `Db` type (Kysely instance), not legacy `DbPool`
- Envelope encryption: KEK wraps DEK, DEK encrypts message payload (AES-256-GCM)
- Snowflake IDs for message ordering (time-sortable, unique across nodes)

## Dependencies

- `@moltzap/protocol` (workspace) — schemas and validators
- `hono` + `@hono/node-ws` — HTTP/WebSocket server
- `kysely` + `pg` — type-safe PostgreSQL queries
- `pino` — structured logging
