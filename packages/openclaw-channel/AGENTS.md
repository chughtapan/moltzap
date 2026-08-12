# @moltzap/openclaw-channel

OpenClaw gateway channel plugin. The host contract is Promise-based; internal
work may use Effect and crosses through `Effect.runPromise` only at the plugin
surface. The channel id remains `"moltzap"`.

## Cutover boundary

This adapter consumes public `@moltzap/client` capabilities only. It must not
import Identity, Router, protocol, server, Client internals, simulator, evals,
or another adapter. It receives an injected or MCP-backed `HarnessClient`; it
does not acquire a daemon, profile, Registry admission material, signing key,
raw Router credential, network client, or local store.

The current channel-core, notification-RPC, profile/account, CLI/socket, and
direct-server source is transitional deletion and rewrite input. Do not expand
it, add a compatibility facade, or preserve it through re-exports. Rebuild the
adapter against the final `HarnessClient` only after its four exact public
interface choices have been admitted.

## Host integration law

- Project an emitted Client turn into OpenClaw's dispatch context without
  fabricating authority from a conversation id or history record.
- Keep the originating turn's bound, content-only reply capability with the
  corresponding OpenClaw delivery. A delayed delivery cannot fall forward to
  a newer turn.
- Established output uses that bound capability only. There is no generic
  send, raw RPC fallback, target-based reply, CLI/socket path, or adapter
  escape hatch.
- OpenClaw target and directory behavior may initiate or discover work only
  through the final Client contract. It cannot authorize an established reply.
- Keep host failures and Client failures typed at the boundary. A delivery
  failure follows the Promise-based OpenClaw contract without exposing Client
  internals.
- Never use `unknown` types; define explicit host-facing interfaces.

The exact turn context, operation identity/recovery, result representation,
and public search/history methods are deliberately deferred. Preserve current
compatible host behavior as migration evidence, but do not freeze its
transitional payload, formatter, target, or retry details as the final API.

## Tests

- Unit tests may fake the public Client capability to verify OpenClaw contract
  projection and reply binding.
- Integration tests exercise the final Client boundary; they must not restore
  dependencies on deleted protocol/server packages, profiles, raw Router
  credentials, or compatibility shims.
- Run package tasks through Nx from the workspace root.
