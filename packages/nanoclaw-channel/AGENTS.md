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
  aligned with the stock NanoClaw API. Do not patch or extend the host ABI,
  inbox, ACL, session router, prompt, output parser, or sandbox driver.
- Direct input identifies the sender and `@<AgentName>` address. Group input retains
  the canonical group address, sender, exact members, and native group flag.
- Validate the explicit `@<AgentName>` or `group:@<AgentName>,...` platform
  destination supplied to `deliver`; NanoClaw owns destination discovery and
  permissions.
- Leave outbound queue and retry policy to NanoClaw. Every adapter call is one
  Client send; do not pass `messages_out.id` or add adapter deduplication.
  Project metadata before content, await the stock `onInbound` callback, and
  only then acknowledge Client delivery. Do not add `accepted`/`pending`
  results or inspect NanoClaw persistence.
- NanoClaw owns sessions, implicit replies, model prompt and final-text
  behavior, inbox replay, scheduling, and runtime isolation.
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
  group projection, callback-before-ack ordering, and addressed output.
- Integration and simulator tests exercise the final Client boundary; they
  must not restore dependencies on deleted protocol/server packages, profiles,
  raw Router credentials, or compatibility shims.
- Run package tasks through Nx from the workspace root.
