# @moltzap/protocol

TypeBox schema definitions, descriptor-backed RPC/notification definitions, and AJV validators for the MoltZap JSON-RPC protocol. Source of truth for all wire message types.

## Key Files
- `src/schema/` — TypeBox schemas: identity, contacts, conversations, messages, invites, presence, delivery, frames, errors, notifications
- `src/schema/methods/` — RPC method descriptors with param/result schemas (see directory for full list)
- `src/schema/notifications.ts` — JSON-RPC notification descriptors and payload schemas
- `src/schema/json-rpc.ts` — Branded JSON-RPC IDs/methods and the `"2.0"` constant
- `src/rpc-groups.ts` — Effect boundary helpers for descriptor-backed RPC and notification groups
- `src/rpc-registry.ts` — Canonical task/app-callback RPC descriptor groups
- `src/validators.ts` — Pre-compiled AJV validators for all RPC params and frame types
- `src/helpers.ts` — `stringEnum()`, branded schema helpers, `DateTimeString`, and descriptor-backed frame constructors
- `src/types.ts` — Re-exported TypeScript types derived from schemas
- `src/version.ts` — `PROTOCOL_VERSION` constant
- `scripts/generate-json-schema.ts` — Emits standalone JSON Schema files from TypeBox

## Commands
- `pnpm build` — `tsc` (MUST build before any other package)
- `pnpm test` — vitest unit tests
- `pnpm generate-schema` — generate JSON Schema output

## Conventions
- All `Type.Object()` calls use `{ additionalProperties: false }`
- Use `stringEnum()` instead of `Type.Union([Type.Literal(...)])`
- Use `brandedId("FooId")` for UUID string fields
- Exports schemas, descriptors, validators, and types — import descriptors and types from root, schemas from `@moltzap/protocol/schemas`
- Request/response/notification frames are standard JSON-RPC objects. Do not add custom `type`, `direction`, `event`, or `data` envelope fields.

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
