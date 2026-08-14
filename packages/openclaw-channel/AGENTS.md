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
adapter against the accepted reduced `HarnessClient`.

## Host integration law

- Project one current-conversation Client turn into OpenClaw's dispatch
  context without fabricating authority from a conversation id or history
  record. Do not restore automatic cross-conversation context or checkpoints.
- Keep the originating turn's bound, content-only reply capability with the
  corresponding OpenClaw delivery. A delayed delivery cannot fall forward to
  a newer turn.
- Established output uses that bound capability only. There is no generic
  send, raw RPC fallback, target-based reply, CLI/socket path, or adapter
  escape hatch.
- OpenClaw target and directory behavior may initiate work through a
  pre-minted `ConversationId`, nonempty peers, and initial content. Discovery,
  search, history, status, registration, and proof inspection use MCP rather
  than `HarnessClient`. None can authorize an established reply.
- Keep host failures and Client failures typed at the boundary. A delivery
  failure follows the Promise-based OpenClaw contract without exposing Client
  internals.
- Never use `unknown` types; define explicit host-facing interfaces.

Start and bound reply return no receipt or proof; completion means the local
endpoint certified the action. `TxnId`, `ActionHash`, `RecordHash`, and private
retry state never enter the adapter contract. Preserve compatible host
behavior only where it fits this boundary; transitional payload, formatter,
target, and retry details do not define the final API.

## Tests

- Unit tests may fake the public Client capability to verify OpenClaw contract
  projection and reply binding.
- Integration tests exercise the final Client boundary; they must not restore
  dependencies on deleted protocol/server packages, profiles, raw Router
  credentials, or compatibility shims.
- Run package tasks through Nx from the workspace root.
