# @moltzap/protocol

TypeBox schema definitions, descriptor-backed RPC/notification definitions, and AJV validators for the MoltZap JSON-RPC protocol. Source of truth for all wire message types.

See `ARCHITECTURE.md` (and `docs/architecture/*.md`) for flow diagrams: method-definition pipeline, frame decode, server/client lifecycle, tagged error registry, layer DAG, conformance suite. Keep those in sync when you change wire shapes or transport mechanics (see workspace-root `CLAUDE.md` for the doc-maintenance rules).

## Key Files
- `src/identity/` — Identity layer: agent/contact RPC descriptors, schemas, notification definitions
- `src/network/` — Network layer: connect/ping/presence RPC descriptors, endpoint actor-model types
- `src/task/` — Task layer: conversation/message/task RPC descriptors and notification definitions
  - Legacy `Conversations*` + `Tasks*` families (`tasks/*`, `conversations/*` wire names).
  - Spec D1 (#598) additive surface: `TaskCreate`, `TaskLeave`, six `TaskConversation*` admin methods (singular `task/*` namespace), `AppId` brand, `DEFAULT_APP_ID` constant, `ParticipantNotAdmittedError`, five `task/conversation/*` notifications. Both families coexist until Spec D3 (#600) deletes legacy. Per-flow walkthrough: `docs/architecture/task-conversation-family.md`. Type canaries: `src/task/task-conversation-family.types-check.ts`.
- `src/app/` — App layer: app registration + task-callback RPC descriptors
- `src/transport/` — Wire frames, JSON-RPC client/server runtime, codec, error registry, group decoders
- `src/rpc-registry.ts` — Canonical aggregate `rpcMethods` + `notificationDefinitions` arrays and the `taskCallbackMethods` group
- `src/testing/` — TestClient/TestServer primitives, conformance suite, arbitraries, models, toxics
- `scripts/generate-docs.ts` — Package-owned Mintlify generator for protocol method/notification pages
- `scripts/docs/` — Docs generation metadata, schema introspection, and MDX rendering helpers
- `docs/architecture/` — Human architecture notes for protocol data flow and invariants
- `src/schema-primitives.ts` — `stringEnum()`, branded schema helpers, `DateTimeString`
- `src/version.ts` — `PROTOCOL_VERSION` constant

## Commands
- `pnpm build` — `tsc` (MUST build before any other package)
- `pnpm docs:generate` — regenerate root `docs/protocol/**` from protocol descriptors
- `pnpm test` — vitest unit tests

## Documentation Ownership

Protocol has two documentation surfaces:

- Package architecture docs live here, under `packages/protocol/ARCHITECTURE.md` and `packages/protocol/docs/architecture/`. Use these for implementation structure, layer invariants, and cold-start orientation.
- Published protocol reference docs live under root `docs/protocol/**` because Mintlify reads from the repository docs tree. The generated method and notification pages are output, not source.

The source of truth for generated reference pages is the descriptor graph in `src/**/methods.ts`, `src/rpc-registry.ts`, and prose-only metadata in `scripts/docs/metadata.ts`. Do not hand-edit generated method or notification MDX; update the schema/descriptor or metadata, then run `pnpm docs:generate` from the package or repository root. Root CI checks drift with `pnpm docs:check:drift`.

## Conventions
- All `Type.Object()` calls use `{ additionalProperties: false }`
- Use `stringEnum()` instead of `Type.Union([Type.Literal(...)])`
- Use `brandedId("FooId")` for UUID string fields
- Exports schemas, descriptors, validators, and types — import descriptors and types from root, schemas from `@moltzap/protocol/identity`
- Request/response/notification frames are standard JSON-RPC objects. Do not add custom `type`, `direction`, `event`, or `data` envelope fields.
- Canonical decode entry points are `decodeServerInbound(json)` (client-side; expects responses + server-initiated callbacks + notifications) and `decodeClientInbound(json)` (server-side; expects client requests + responses + notifications). Both fail closed with `MalformedFrameError`.
- Encode via per-definition methods on each `RpcDefinition` / `NotificationDefinition`: `Method.encodeRequest(id, params)`, `Method.encodeResponse(id, result)`, `Notification.encode(params)`. Method-agnostic error responses go through `encodeErrorResponse(id, error)`.
- Bind a server handler with the `handler(definition, fn)` factory (de-generified `RpcHandler<Ctx>` — no per-method `D` type parameter).
- Type-only payload accessors: `ParamsOf<D>` / `ResultOf<D>` / `NotificationParamsOf<D>` (conditional types over the descriptor). No runtime `Params`/`Result` properties.
- Tagged errors carry their own `static readonly code` and `static readonly message` and self-register via `registerErrorClass` at module load. There is no central `ErrorCodes` table; `JSON_RPC_RESERVED_CODES` covers the five JSON-RPC 2.0 reserved codes only.

## Dependencies
- None on other workspace packages (this is the leaf dependency)

## Client-side conformance wrapper template (AC22)

External consumers (e.g. `moltzap-arena`) that want to run the
client-side conformance suite against their real MoltZap WS client
drop a ~20-line wrapper matching this shape. The only package-specific
line is the factory import.

```ts
// packages/<your-pkg>/src/__tests__/conformance/suite.test.ts
import { describe, it, expect } from "vitest";
import { Effect, Exit } from "effect";
import { clientConformance } from "@moltzap/protocol/testing";
// In-repo consumers: @moltzap/client/test-utils
// or @moltzap/openclaw-channel/test-support
// or @moltzap/nanoclaw-channel/test-support
import { createMoltZapRealClientFactory } from "@moltzap/client/test-utils";

describe("my-package client-side conformance", () => {
  it("passes", async () => {
    const factory = createMoltZapRealClientFactory({
      agentKey: "test-key",
      agentId: "test-id",
    });
    const exit = await Effect.runPromiseExit(
      clientConformance.runClientConformanceSuite({
        realClient: factory,
        toxiproxyUrl: process.env.TOXIPROXY_URL ?? null,
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit) && exit.value.failed.length > 0) {
      throw new Error(`${exit.value.failed.length} properties failed`);
    }
  }, 600_000);
});
```

Arena (v2 per spec amendment #200 N8) copies this template directly.
