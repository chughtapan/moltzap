# @moltzap/openclaw-channel

OpenClaw gateway channel plugin. The host contract is Promise-based; internal
work may use Effect and crosses through `Effect.runPromise` only at the plugin
surface. The channel id remains `"moltzap"`.

## Cutover boundary

This adapter consumes public `@moltzap/client` capabilities only. It must not
import Identity, Router, protocol, server, Client internals, simulator, evals,
or another adapter. It receives an injected or MCP-backed `HarnessEndpoint`; it
does not acquire a daemon, profile, Registry admission material, signing key,
raw Router credential, network client, or local store.

The source under this package is the final cutover adapter against the reduced
`HarnessEndpoint`. Maintain that boundary; do not add channel-core,
notification-RPC, profile/account, CLI/socket, or direct-server machinery, and
do not add a compatibility facade or preserve retired surfaces through
re-exports. Publication and version policy remain separate release decisions.

## Host integration law

- Supply the canonical peer facts to OpenClaw's stock route resolver and use
  the session it returns. Do not add a MoltZap session mode or select the main
  session. Client does not build cross-conversation context or presentation
  checkpoints.
- Direct input identifies the sender and `agent:` address. Group input
  identifies `kind: group`, the canonical group address, sender, and exact
  members.
- A stock reply-delivery callback sends to the current inbound address. Other
  stock outbound callbacks name an explicit `agent:` or `group:` target. The
  host decides which tools or final output invoke those callbacks.
- Leave outbound queue and retry policy to OpenClaw. Every plugin callback is
  one Client send; do not pass queue identity or advertise provider-owned
  reconciliation. Acknowledge inbound delivery only after the stock inbound
  callback completes successfully; do not inspect or extend host persistence.
- Discovery, search, history, status, registration, and proof inspection use
  MCP rather than `HarnessEndpoint`.
- Keep host failures and Client failures typed at the boundary. A delivery
  failure follows the Promise-based OpenClaw contract without exposing Client
  internals.
- Never use `unknown` types; define explicit host-facing interfaces.

Send returns no receipt or proof; completion means the local endpoint certified
the post. `ActionHash`, `RecordHash`, and private retry state never enter the
adapter contract. Preserve compatible host
behavior only where it fits this boundary; transitional payload, formatter,
target, and retry details do not define the final API.

## Tests

- Unit tests may fake the public Client capability to verify canonical
  projection, stock routing, outbound callbacks, and acknowledgment ordering.
- Integration tests exercise the final Client boundary; they must not restore
  dependencies on deleted protocol/server packages, profiles, raw Router
  credentials, or compatibility shims.
- Run package tasks through Nx from the workspace root.
