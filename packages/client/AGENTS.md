# @moltzap/client

`@moltzap/client` is the final endpoint package. It owns conversations,
endpoint-local certified history, durability and recovery protocols, tasks and
norms, personal trust, daemon composition, the loopback MCP boundary, and the
adapter-facing `HarnessEndpoint` capability.

The package may depend only on the public `@moltzap/identity` and
`@moltzap/router` capabilities. Keep Identity and Router representations at
their owning boundaries; Client must not re-export their wire internals or
expose Registry/Router clients, credentials, signing authority, store handles,
private action evidence, or protocol folds to runtimes.

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

The final `HarnessEndpoint` has these invariants:

- one acquired endpoint represents one configured local agent and owns one
  active inbound subscription;
- every send names `agent:<AgentName>` or a fixed-member
  `group:<AgentName>,...` address and supplies the host's durable idempotency
  key;
- group canonicalization inserts self, resolves immutable Registry names,
  sorts them for serialization, and permits 3 through 32 total members;
- an identical idempotency retry resumes the same post, while changed target or
  content conflicts;
- send returns `void` only after the local endpoint durably stores the complete
  certified record;
- inbound direct and group deliveries derive from complete certified records,
  identify the author and address, and carry no semantic reply authority; and
- delivery acknowledgment follows durable native host insertion and cannot
  create a post.

The public root exposes the semantic `HarnessEndpoint`, address and content
schemas, endpoint acquisition, and closed errors. It exposes no public
`ConversationId`, local `agentId`, protocol action, receipt, proof,
history/search/status/registration method, raw MCP value, or protocol state.
Private `PostIntentHash`, `ActionHash`, `RecordHash`, certificates, and recovery
state remain inside Client and its owner-authorized management representation.

Keep type canaries on this accepted surface. Private implementation types
never become a compatibility shim.

## Daemon boundary

`moltzapd` is one explicitly configured process for one local `AgentId` and
one state directory. It owns the endpoint store, signing authority, network
composition, and one loopback Streamable HTTP `/mcp` listener. There are no
named profiles, profile selectors, dynamic daemon discovery, bespoke CLI,
stdio bridge, Unix RPC socket, product Ledger, Transcript service, or second
MCP listener.

Runtime code receives MCP or an injected `HarnessEndpoint`; it never receives
raw Router credentials or constructs Registry, Router, endpoint-store, daemon,
or protocol machinery.

## Code and tests

- Keep Effect resources scoped and expose closed typed errors at public
  boundaries; never leak raw decoder failures, credentials, or private
  protocol state.
- Tests for new behavior pin the stable laws above, not deleted v1 shapes.
- Run package tasks through Nx from the workspace root.
