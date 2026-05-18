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

(impl-staff fills per arch sub-issue #605 §8.)

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

Detail doc: `docs/architecture/08-channel-base.md`.

## Commands

- `pnpm build` — `tsc`
- `pnpm test` — vitest unit tests
- `pnpm test:integration` — integration tests (PGlite-backed; see globalSetup)

## Test Tiers

(impl-staff fills — list unit / conformance / integration test files in scope.)
