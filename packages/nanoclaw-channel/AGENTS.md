# @moltzap/nanoclaw-channel

NanoClaw channel adapter and integration canary. Its final publication policy
is deferred; its package boundary is not.

## Cutover boundary

This adapter consumes public `@moltzap/client` capabilities only. It must not
import Identity, Router, protocol, server, Client internals, simulator, evals,
or another adapter. It receives an injected or MCP-backed `HarnessClient`; it
does not acquire a daemon, profile, Registry admission material, signing key,
raw Router credential, network client, or local store.

The current channel-core, notification-RPC, direct-server, credential, and
eval-mode connection source is transitional deletion and rewrite input. Do
not expand it, add a compatibility facade, or preserve it through re-exports.
Rebuild the adapter against the final `HarnessClient` only after its four exact
public-interface choices have been admitted.

## Host integration law

- Keep NanoClaw's `ChannelAdapter` entry point and host-relative stub modules
  aligned with the digest-pinned NanoClaw application used by simulator runs.
- Platform ids and messaging-group wiring are host routing data only. They do
  not create MoltZap reply authority.
- Await the host turn so the originating Client turn's bound, content-only
  reply capability cannot outlive or fall forward to a newer turn.
- Established output uses that bound capability only. There is no generic
  send, conversation-id reply, raw RPC fallback, CLI/socket path, or adapter
  escape hatch.
- Preserve the host ordering requirement that metadata is projected before
  inbound content, and continue dropping the local agent's own messages.
- Keep host-shape failures distinct from closed Client failures without
  exposing private reply grants, credentials, or protocol state.

The exact turn context, operation identity/recovery, result representation,
and public search/history methods are deliberately deferred. Preserve current
compatible host behavior as migration evidence, but do not freeze its
transitional payload, formatter, context, target, or retry details as the final
API.

## Tests

- Unit tests may fake the public Client capability to verify NanoClaw
  projection, messaging-group wiring, and turn-bound replies.
- Integration and simulator tests exercise the final Client boundary; they
  must not restore dependencies on deleted protocol/server packages, profiles,
  raw Router credentials, or compatibility shims.
- Run package tasks through Nx from the workspace root.
