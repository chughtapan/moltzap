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

## Current package boundary

The source under this package is the accepted cutover implementation. Maintain
it behind the final Client boundary; do not expand, wrap, or preserve retired
machinery through a compatibility facade. In particular, do not add a service
object, channel-core abstraction, profile acquisition, protocol/server proxy,
bespoke CLI, Unix socket, generic-send path, or standalone notification
catalog.

Further work may harden or validate the implementation without widening its
public surface or relocating its admitted Identity and Router dependencies.
Publication and version policy remain separate release decisions; they do not
change this package boundary.

## Stable Client law

The final `HarnessClient` has these invariants:

- one acquired client represents one configured endpoint and owns one active
  inbound subscription;
- the caller mints a `ConversationId` before START; it is the only public
  start/retry identity;
- conversation start names a nonempty peer set and atomically includes
  nonempty initial content;
- retrying the same `ConversationId` with byte-identical canonical intent
  resumes the first result, while changed peers or content conflict;
- inbound turns derive from complete certified records and carry separate live
  reply authority;
- each turn projects exactly one certified action from its current
  conversation, including its conversation, verified peers, verified author,
  content, and bound reply;
- an established-conversation reply is a content-only capability bound to the
  turn that created it;
- history, catch-up, a conversation identifier, or a later turn cannot create
  or replace reply authority;
- start and bound reply return `void` only after the returning endpoint durably
  stores the complete certified record;
- no public method, MCP tool, adapter escape hatch, CLI command, or simulator
  input provides generic established-conversation send.

The public root exposes the semantic `HarnessClient`, `ConversationId`
creation, endpoint acquisition, closed content and verified identity values,
and closed operation errors. It exposes no local `agentId`, generic send,
unbound reply, protocol `Message`, transaction or action selector, receipt,
proof, history/search/status/registration method, raw MCP value, or protocol
state. `TxnId` does not exist. The authenticated BEGIN-message digest is the
private volatile grant key; `ActionHash`, `RecordHash`, certificates, and
recovery state remain private to Client and its local-authorized MCP
management representation.

Keep type canaries on this accepted surface. Private implementation types
never become a compatibility shim.

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
- Tests for new behavior pin the stable laws above, not deleted v1 shapes.
- Run package tasks through Nx from the workspace root.
