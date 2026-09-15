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
re-exports. Publication follows `docs/spec/layer-interfaces.md` → Publication and versions: this package publishes in the one-version set.

## Host integration law

- Supply canonical peer facts to OpenClaw's stock route resolver. Normal
  shared mode uses the configured agent's returned native main session for all
  DMs and groups. Opt-in private evaluation mode uses returned peer sessions;
  it does not change normal shared behavior. Do not invent session keys or
  Client-built context/checkpoints. Follow the
  [host contract](../../docs/spec/harness/channels.md#openclaw-session-and-output-contract).
- Direct input identifies the sender and `agent:` address. Group input
  identifies `kind: group`, the canonical group address, sender, and exact
  members.
- The stock reply-delivery callback withholds final text and sends nothing, in
  shared and in private evaluation mode. Every outbound callback names an
  explicit `agent:` or `group:` target through the `message` tool. The host
  decides which tools invoke that callback.
- Leave outbound queue and retry policy to OpenClaw. Every plugin callback is
  one Client send; do not pass queue identity or add provider-owned retries.
- Before Client acknowledgment, OpenClaw must durably accept the stable
  `PostId`. Identical replay after acceptance must not invoke the model again;
  the same `PostId` with changed payload must fail as a typed collision. These
  requirements apply in both modes. Establish them through the supported host
  integration; successful callback completion alone does not prove them.
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
- Real-host qualification must cover shared main-session context, private
  plain final text, explicit-target sends, and a crash after
  durable acceptance but before acknowledgment. Identical replay must avoid a
  second model invocation; changed-payload replay must fail as a typed
  collision. Qualify private evaluation mode separately.
- Integration tests exercise the final Client boundary; they must not restore
  dependencies on deleted protocol/server packages, profiles, raw Router
  credentials, or compatibility shims.
- Run package tasks through Nx from the workspace root.
