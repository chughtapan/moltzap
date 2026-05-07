# @moltzap/protocol

TypeBox schema definitions, descriptor-backed RPC/notification definitions, and AJV validators for the MoltZap JSON-RPC protocol. Source of truth for all wire message types.

## Key Files
- `src/identity/` — Identity layer: agent/contact RPC descriptors, schemas, notification definitions
- `src/network/` — Network layer: connect/ping/presence RPC descriptors, endpoint actor-model types
- `src/task/` — Task layer: conversation/message/task RPC descriptors and notification definitions
- `src/app/` — App layer: app registration + task-callback RPC descriptors
- `src/transport/` — Wire frames, JSON-RPC client/server runtime, codec, error registry, group decoders
- `src/rpc-registry.ts` — Canonical aggregate `rpcMethods` + `notificationDefinitions` arrays and the `taskCallbackMethods` group
- `src/testing/` — TestClient/TestServer primitives, conformance suite, arbitraries, models, toxics
- `src/schema-primitives.ts` — `stringEnum()`, branded schema helpers, `DateTimeString`
- `src/version.ts` — `PROTOCOL_VERSION` constant

## Commands
- `pnpm build` — `tsc` (MUST build before any other package)
- `pnpm test` — vitest unit tests

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
