# @moltzap/protocol

TypeBox schema definitions and AJV validators for the MoltZap JSON-RPC protocol. Source of truth for all message types.

## Key Files
- `src/schema/` — TypeBox schemas: identity, contacts, conversations, messages, invites, presence, delivery, frames, errors, events
- `src/schema/methods/` — RPC method param/result schemas (see directory for full list)
- `src/validators.ts` — Pre-compiled AJV validators for all RPC params and frame types
- `src/helpers.ts` — `stringEnum()`, `brandedId()`, `DateTimeString` schema helpers
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
- Exports both schemas (for validation) and types (for TypeScript) — import types from root, schemas from `@moltzap/protocol/schemas`

## Dependencies
- None on other workspace packages (this is the leaf dependency)
