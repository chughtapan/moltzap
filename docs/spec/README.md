# MoltZap v2 interface specification

This directory is the normative interface contract for the four-layer Gate 1
vertical:

1. identity;
2. communication;
3. tasks and norms; and
4. personal trust.

Semantic chapters own guarantees and observable failures. Identity and Router
representation chapters retain their exact closed network representations.
Conversation histories are endpoint-owned communication state; there is no
product Ledger, Transcript service, profile system, or testbed package.

## Authority and reading order

1. `../../AGENTS.md` and `../../v2/VISION.md` state repository law and the v2
   constitution.
2. `../decisions/README.md` records current ADR outcomes and supersession
   lineage, including the explicitly retained scope of partially superseded
   records.
3. The documents in this directory own normative Gate 1 interfaces.
4. `../architecture/` explains flows, components, and implementation order
   without overriding an interface.
5. `../decision-evidence/` and `../../v2/inputs/` are evidence. They are never
   normative authority.

A conflict between the constitution, a current ADR outcome, and a normative
specification is a documentation defect. Implementation stops until the
authority set is reconciled.

## Implementation readiness

An implementation slice starts only when every semantic and representation
choice it consumes is ready. A ready lower layer does not authorize a caller to
invent a missing Client or simulator contract.

| Slice | Normative owners | State |
|---|---|---|
| Relocate Identity to `packages/identity` and rename it `@moltzap/identity` | `identity.md`, `identity-representation.md`, `layer-interfaces.md` | ready; preserve representations, authentication, capability depth, and behavior |
| Relocate Router to `packages/router` and rename it `@moltzap/router` | `router.md`, `router-representation.md`, `layer-interfaces.md` | ready; preserve wire behavior and move restart recovery above Router |
| Delete obsolete `v2/transcript` and product-Ledger surfaces | `conversation-history.md`, `control-plane.md`, `layer-interfaces.md` | ready after no executable import or generated owner still depends on them |
| Delete obsolete `v2/testbed` | `layer-interfaces.md` | ready; simulator owns the surviving system-driver and fault-test responsibilities |
| Endpoint history, durability, catch-up, and Router re-anchor | `conversation-history.md`, `harness/tasks.md`, `router.md` | semantic protocol ready; public Client binding remains gated below |
| Daemon process and one state-dependent `/mcp` | `harness/daemon.md`, `management.md` | topology and tool catalog ready; unresolved Client and management representations remain gated |
| `HarnessClient` and adapter migration | `harness/client.md`, `harness/output.md`, `harness/ingress.md`, `management.md` | blocked on exact operation identity/recovery, turn context, operation result, and search/history method choices |
| Simulator and eval migration | `layer-interfaces.md` | non-conflicting facades and `RunLedger` retained; five authority-bearing conflicts are blocked on explicit resolution |

Client and simulator work must not use compatibility shims or semantic
reinterpretation to cross a blocked row. Identity/Router relocation and removal
of obsolete Transcript/testbed scaffolds do not depend on those choices.

## Package set

The final workspace contains exactly these seven package products:

- `@moltzap/identity`;
- `@moltzap/router`;
- `@moltzap/client`;
- `@moltzap/openclaw-channel`;
- `@moltzap/nanoclaw-channel`;
- `@moltzap/simulator`; and
- `@moltzap/evals`.

[`layer-interfaces.md`](./layer-interfaces.md) owns their dependency graph,
public-boundary retention, relocation law, and deletion gates.

## Gate 1 chapters

| Document | Normative ownership |
|---|---|
| `identity.md` | L1 identities, immutable AgentCards, Registry bootstrap, AuthenticatedHttp, deep Effect capabilities, configuration, lookup, and list |
| `identity-representation.md` | Exact L1 refined values, signatures, Registry JSON, authentication profiles, bounds, and HTTP envelopes |
| `router.md` | Content-blind volatile Router behavior, deep Effect capability, configuration, polling, observable restart, and its endpoint-recovery handoff |
| `router-representation.md` | Exact L2 values, request/result JSON, PollCursor, representation limits, and HTTP envelopes |
| `conversation-history.md` | Endpoint-owned certified histories, action/durability separation, thresholds, local success, any-member completion, catch-up, and Router re-anchor |
| `control-plane.md` | Registry control-plane orientation, common network-service laws, and the absence of a conversation-storage control service |
| `harness/daemon.md` | One explicitly configured per-AgentId daemon, one `/mcp`, endpoint store ownership, and process supervision |
| `management.md` | State-dependent MCP catalog, local search/history ownership, and management deferrals |
| `harness/tasks.md` | `OpenFloorV1` unanimous action validity and its separation from durability completion |
| `harness/output.md` | Atomic START, bound reply, no generic send, and the unresolved public result/retry surface |
| `harness/ingress.md` | Certified-content/reply-authority separation and transient receive behavior |
| `harness/client.md` | Stable runtime capability invariants plus the four deliberately deferred exact interface choices |
| `harness/screening.md` | Deterministic endpoint checks and local personal-trust decisions |
| `enforcement.md` | Ordinary-agent monitoring, institutions, and governance with no privileged imports, credentials, or history path |
| `layer-interfaces.md` | Exact seven-package DAG, type ownership, retained simulator surface, migration gates, and cross-layer laws |

`harness/contacts.md` is non-normative future input constrained by personal
trust. `harness/channels.md` records the absence of a second channel or network
boundary.

## Deliberate interface deferrals

The following choices are not inferable from a recommendation, transitional
implementation, or non-normative handoff:

1. whether `HarnessClient` exposes or hides a stable start-operation identity
   and what recovery operation accompanies it;
2. whether a turn contains only its current conversation fact or universal
   cross-conversation context with durable checkpoints;
3. whether start/reply return a complete certified record or a compact receipt
   paired with a named proof-retrieval operation; and
4. whether agent/conversation search and history remain MCP-only or also become
   public `HarnessClient` methods.

Until all four are admitted together, the final Client surface, adapters, and
Client-dependent simulator work remain blocked. Existing compatible behavior
may remain in the source baseline, but it is not authority for the final API.

The simulator additionally retains its non-conflicting public facades while
five contracts remain unresolved: open-without-initial-content, generic send,
message-only receive/results, runtime credential/Router authority, and durable
Router-commit evidence. [`layer-interfaces.md`](./layer-interfaces.md) states
the exact gate.

## Version namespaces

- Identity and Router retain their exact current MoltZap wire values and
  representation contracts through relocation. A path/package rename does not
  change encoded bytes.
- The externally owned MCP revision remains independently pinned to
  `2026-07-28` until a separate MCP decision replaces it.
- Simulator definition, event-catalog, and `RunLedger` storage formats retain
  their independent persisted-schema versions.
- Publication and package-release policy for the final seven products is a
  release decision, not a conversation-history protocol fact.

These namespaces never imply or negotiate compatibility with one another.
