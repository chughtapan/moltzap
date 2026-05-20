# @moltzap/client

Client SDK for MoltZap: WebSocket transport, RPC service object, channel-core
inbound handling, runtime utilities, CLI binary (`moltzap`). Plus the
`@moltzap/client/channel-base` subpath for shared channel-adapter scaffolding.

See `ARCHITECTURE.md` (and `docs/architecture/*.md`) for flow diagrams.

## Key Files

- `src/service.ts` — `MoltZapService` (high-level RPC + conversation state)
- `src/channel-core.ts` — `MoltZapChannelCore` (inbound dispatch + admission)
- `src/ws-client.ts` — `MoltZapWsClient` (low-level WS + JSON-RPC transport)
- `src/auth.ts` — `registerAgent`
- `src/channel-base/` — `@moltzap/client/channel-base` subpath (see below)
- `src/cli/` — `moltzap` CLI binary
- `src/runtime/`, `src/test/`, `src/test-utils/` — subpath modules

## Channel-base subpath

Exports from `@moltzap/client/channel-base`:

- `LeaseAlreadyConsumed` — canonical TaggedError; one definition site across
  all three channels.
- `projectLeaseInvalid` / `catchLeaseInvalid` — wire-error projection (server's
  `data.reason === "LeaseInvalid"` or forward-compat `data._tag` discriminant).
- `LeaseStore<HostKey, T>` — generic per-key lease tracker (nanoclaw uses
  `LeaseStore<string, string>` keyed by JID, peek-style for stale-entry-on-retry).
- `LeaseGuard` — per-dispatch single-shot dup-reply detection (openclaw uses
  one per inbound message, replaces the `consumedLeaseAt` closure).
- `formatCrossConv` / `formatGroupBlock` / `getGroupFields` — markup-
  parameterized formatters (`"json-header"` for openclaw, `"xml-system-reminder"`
  for nanoclaw).

Detail doc: `docs/architecture/channel-base.md`.

## Commands

- `pnpm build` — `tsc`
- `pnpm test` — vitest unit tests
- `pnpm test:integration` — integration tests (PGlite-backed; see globalSetup)

## Test Tiers

| File | Type | What it covers |
|------|------|----------------|
| `src/__tests__/channel-base/lease.test.ts` | Unit | `LeaseAlreadyConsumed` projection from wire errors, `catchLeaseInvalid` Effect-pipe |
| `src/__tests__/channel-base/lease-guard.test.ts` | Unit | `LeaseGuard` single-shot consume + `consumedAt` semantics (fast-check property) |
| `src/__tests__/channel-base/lease-store.test.ts` | Unit | `LeaseStore<HostKey, T>` peek/take per-host semantics |
| `src/__tests__/channel-base/format-cross-conv.test.ts` | Unit | Markup-parameterized cross-conv formatter (`"json-header"` + `"xml-system-reminder"`) |
| `src/__tests__/channel-base/format-group-block.test.ts` | Unit | Group-block formatter + `getGroupFields` predicate |
| `src/__tests__/conformance/suite.test.ts` | Conformance | Channel-base cross-channel invariants (shared with openclaw/nanoclaw/claude-code conformance) |
| `src/channel-core.test.ts`, `src/channel-core-context.test.ts`, `src/channel-core-dispatch.test.ts` | Unit | `MoltZapChannelCore` inbound dispatch + admission |
| `src/service.test.ts`, `src/ws-client.test.ts`, `src/auth.test.ts` | Unit | RPC service, WS transport, agent registration |
| `src/runtime/*.test.ts` | Unit | Runtime utilities (frame parsing, subscribers, close-info, errors) |
| `src/cli/**/*.test.ts` | Unit | CLI binary commands (`register`, `send`, `messages`, `conversations`, config, profile, transport) |
| `src/__tests__/service/**/*.integration.test.ts` | Integration | PGlite-backed service flows (context, core, dedup, history, socket lifecycle/rendering/validation) |
| `src/cli/__tests__/cli-multi-agent.int.test.ts` | Integration | Multi-agent CLI scenarios |
