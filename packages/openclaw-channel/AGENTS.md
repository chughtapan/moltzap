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

- Project every Client delivery into OpenClaw's resolved native main session.
  Client does not build cross-conversation context or presentation checkpoints.
- Direct input identifies the sender and `agent:` address. Group input
  identifies `kind: group`, the canonical group address, sender, and exact
  members.
- Visible output uses OpenClaw's native `message` tool and names an explicit
  `agent:` or `group:` target on every send. Plain final text remains private.
- Use OpenClaw's durable outbound queue identifier as Client idempotency and
  acknowledge inbound delivery only after native durable acceptance.
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

- Unit tests may fake the public Client capability to verify OpenClaw address,
  session, native-message, and delivery-acknowledgment behavior.
- Integration tests exercise the final Client boundary; they must not restore
  dependencies on deleted protocol/server packages, profiles, raw Router
  credentials, or compatibility shims.
- Run package tasks through Nx from the workspace root.
