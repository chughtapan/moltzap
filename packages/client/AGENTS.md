# @moltzap/client

`@moltzap/client` is the final endpoint package. It owns conversations,
endpoint-local certified history, durability and recovery protocols, tasks and
norms, personal trust, daemon composition, the loopback MCP boundary, and the
adapter-facing `HarnessClient` capability.

The package may depend only on the public `@moltzap/identity` and
`@moltzap/router` capabilities. Keep Identity and Router representations at
their owning boundaries; Client must not re-export their wire internals or
expose Registry/Router clients, credentials, signing authority, store handles,
private reply grants, or protocol folds to runtimes.

## Current cutover boundary

The source currently under this package is transitional v1 deletion and
rewrite input. It is not the final Client interface and must not be expanded,
wrapped, or preserved through a compatibility facade. In particular, do not
add new work to the existing service object, channel-core abstraction,
notification catalog, profile acquisition, protocol/server proxy, bespoke
CLI, Unix socket, or generic-send paths.

Safe work before the final interface gate is limited to:

- relocating the admitted Identity and Router capabilities;
- implementing endpoint-history semantics behind private Client boundaries;
- deleting obsolete Transcript and testbed scaffolding; and
- removing retired v1 machinery whose replacement does not depend on a
  deferred public choice.

Do not rewrite adapters, freeze Client-dependent simulator behavior, or expose
new Client signatures until the four choices below have an admitted owner.

## Stable Client law

Every admissible final `HarnessClient` shape has these invariants:

- one scoped client represents one registered local `AgentId` and owns one
  active inbound subscription;
- conversation start atomically includes nonempty initial content;
- inbound turns derive from complete certified records and carry separate live
  reply authority;
- an established-conversation reply is a content-only capability bound to the
  turn that created it;
- history, catch-up, a conversation identifier, or a later turn cannot create
  or replace reply authority;
- success means that the returning endpoint durably stores a complete
  certified record; and
- no public method, MCP tool, adapter escape hatch, CLI command, or simulator
  input provides generic established-conversation send.

The exact public interface remains deliberately blocked on four decisions:

1. explicit operation identity versus a named Client-owned durable recovery
   operation;
2. current-conversation-only turns versus bounded, filtered
   cross-conversation context and checkpoints;
3. complete certified-record results versus compact receipts with a named
   public proof-retrieval operation; and
4. MCP-only search/history versus matching typed `HarnessClient` methods.

Do not infer any of these answers from the transitional implementation. Keep
compatible type canaries only as migration evidence; never turn them into a
compatibility shim or claim that they define the final surface.

## Daemon boundary

`moltzapd` is one explicitly configured process for one local `AgentId` and
one state directory. It owns the endpoint store, signing authority, network
composition, and one loopback Streamable HTTP `/mcp` listener. There are no
named profiles, profile selectors, dynamic daemon discovery, bespoke CLI,
stdio bridge, Unix RPC socket, product Ledger, Transcript service, or second
MCP listener.

Runtime code receives MCP or an injected `HarnessClient`; it never receives
raw Router credentials or constructs Registry, Router, endpoint-store, daemon,
or protocol machinery.

## Code and tests

- Keep Effect resources scoped and expose closed typed errors at public
  boundaries; never leak raw decoder failures, credentials, or private
  protocol state.
- Tests for new behavior pin the stable laws above, not deleted v1 shapes or a
  guessed deferred interface.
- Run package tasks through Nx from the workspace root.
