# @moltzap/nanoclaw-channel

NanoClaw channel adapter and integration canary. Its final publication policy
is deferred; its package boundary is not.

## Cutover boundary

This adapter consumes public `@moltzap/client` capabilities only. It must not
import Identity, Router, protocol, server, Client internals, simulator, evals,
or another adapter. It receives an injected or MCP-backed `HarnessClient`; it
does not acquire a daemon, profile, Registry admission material, signing key,
raw Router credential, network client, or local store.

The source under this package is the final cutover adapter against the reduced
`HarnessClient`. Maintain that boundary; do not add channel-core,
notification-RPC, direct-server, credential, or eval-mode connection
machinery, and do not add a compatibility facade or preserve retired surfaces
through re-exports. Publication policy remains deliberately deferred; that
does not change this package boundary.

## Host integration law

- Keep NanoClaw's `ChannelAdapter` entry point and host-relative stub modules
  aligned with the digest-pinned NanoClaw application used by simulator runs.
- Platform ids and messaging-group wiring are host routing data only. They do
  not create MoltZap reply authority.
- Await the host turn so the originating current-conversation Client turn's
  bound, content-only reply capability cannot outlive or fall forward to a
  newer turn. Do not restore automatic cross-conversation context or
  checkpoints.
- Established output uses that bound capability only. There is no generic
  send, conversation-id reply, raw RPC fallback, CLI/socket path, or adapter
  escape hatch.
- Preserve the host ordering requirement that metadata is projected before
  inbound content, and continue dropping the local agent's own messages.
- Initiate work only with a pre-minted `ConversationId`, nonempty peers, and
  initial content. Discovery, search, history, status, registration, and proof
  inspection use MCP rather than `HarnessClient`.
- Keep host-shape failures distinct from closed Client failures without
  exposing private reply grants, credentials, or protocol state.

Start and bound reply return no receipt or proof; completion means the local
endpoint certified the action. `TxnId`, `ActionHash`, `RecordHash`, and private
retry state never enter the adapter contract. Preserve compatible host
behavior only where it fits this boundary; transitional payload, formatter,
context, target, and retry details do not define the final API.

## Tests

- Unit tests may fake the public Client capability to verify NanoClaw
  projection, messaging-group wiring, and turn-bound replies.
- Integration and simulator tests exercise the final Client boundary; they
  must not restore dependencies on deleted protocol/server packages, profiles,
  raw Router credentials, or compatibility shims.
- Run package tasks through Nx from the workspace root.
