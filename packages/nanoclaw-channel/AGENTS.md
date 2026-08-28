# @moltzap/nanoclaw-channel

NanoClaw channel adapter and integration canary. Its final publication policy
is deferred; its package boundary is not.

## Cutover boundary

This adapter consumes public `@moltzap/client` capabilities only. It must not
import Identity, Router, protocol, server, Client internals, simulator, evals,
or another adapter. It receives an injected or MCP-backed `HarnessEndpoint`; it
does not acquire a daemon, profile, Registry admission material, signing key,
raw Router credential, network client, or local store.

The source under this package is the final cutover adapter against the reduced
`HarnessEndpoint`. Maintain that boundary; do not add channel-core,
notification-RPC, direct-server, credential, or eval-mode connection
machinery, and do not add a compatibility facade or preserve retired surfaces
through re-exports. Publication policy remains deliberately deferred; that
does not change this package boundary.

## Host integration law

- Keep NanoClaw's `ChannelAdapter` entry point and host-relative stub modules
  aligned with the digest-pinned NanoClaw application used by simulator runs.
- Route every MoltZap destination through NanoClaw's native `agent-shared`
  session. Client does not build cross-conversation context or checkpoints.
- Direct input identifies the sender and `agent:` address. Group input retains
  the canonical group address, sender, exact members, and native group flag.
- Visible output uses native `send_message` or final `<message to="...">` and
  names an explicit `agent:` or `group:` destination. Bare final text remains
  private.
- Use NanoClaw's durable `messages_out.id` as Client idempotency and
  acknowledge inbound delivery only after durable `messages_in` insertion.
- Preserve the host ordering requirement that metadata is projected before
  inbound content, and continue dropping the local agent's own messages.
- Discovery, search, history, status, registration, and proof inspection use
  MCP rather than `HarnessEndpoint`.
- Keep host-shape failures distinct from closed Client failures without
  exposing private action evidence, credentials, or protocol state.

Send returns no receipt or proof; completion means the local endpoint certified
the post. `ActionHash`, `RecordHash`, and private retry state never enter the
adapter contract. Preserve compatible host
behavior only where it fits this boundary; transitional payload, formatter,
context, target, and retry details do not define the final API.

## Tests

- Unit tests may fake the public Client capability to verify NanoClaw address,
  agent-shared session, group projection, native output, and durable delivery.
- Integration and simulator tests exercise the final Client boundary; they
  must not restore dependencies on deleted protocol/server packages, profiles,
  raw Router credentials, or compatibility shims.
- Run package tasks through Nx from the workspace root.
