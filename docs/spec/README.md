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
choice it consumes is ready. The reduced Client boundary, private protocol,
daemon management representation, and Simulator compatibility cuts are ready.

| Slice | Normative owners | State |
|---|---|---|
| Relocate Identity to `packages/identity` and rename it `@moltzap/identity` | `identity.md`, `identity-representation.md`, `layer-interfaces.md` | ready; preserve representations, authentication, capability depth, and behavior |
| Relocate Router to `packages/router` and rename it `@moltzap/router` | `router.md`, `router-representation.md`, `layer-interfaces.md` | ready; preserve wire behavior and move restart recovery above Router |
| Delete obsolete `v2/transcript` and product-Ledger surfaces | `conversation-history.md`, `control-plane.md`, `layer-interfaces.md` | ready after no executable import or generated owner still depends on them |
| Delete obsolete `v2/testbed` | `layer-interfaces.md` | ready; simulator owns the surviving system-driver and fault-test responsibilities |
| Endpoint history, durability, catch-up, and Router re-anchor | `conversation-history.md`, `harness/tasks.md`, `router.md` | ready; Client owns the exact canonical evidence, nested transport, fixed limits, genesis anchor, and private hashes |
| Daemon process and one state-dependent `/mcp` | `harness/daemon.md`, `management.md` | ready; process configuration, SQLite ownership, extension listen adapter, and closed management DTO semantics are exact |
| `HarnessClient` and adapter migration | `harness/client.md`, `harness/output.md`, `harness/ingress.md`, `management.md` | ready; caller-minted `ConversationId`, current-action turns, `void` completion, and MCP-only management |
| Simulator and eval migration | `layer-interfaces.md` | ready; compatible facades and `RunLedger` remain, five conflicting surfaces are removed, and all sixteen eval definitions run without Client-injected cross-conversation context |

Client and simulator work must not use compatibility shims or semantic
reinterpretation. The five incompatible simulator contracts are removal input,
not retained behavior.

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
| `management.md` | State-dependent MCP catalog and MCP-only registration, status, search, history, and proof inspection |
| `harness/tasks.md` | `OpenFloorV1` unanimous action validity and its separation from durability completion |
| `harness/output.md` | Caller-identified atomic START, content-only bound reply, `void` local-durability completion, and no generic send |
| `harness/ingress.md` | One-current-action turns, certified-content/reply-authority separation, and transient receive behavior |
| `harness/client.md` | Exact reduced public runtime capability and management-absence boundary |
| `harness/screening.md` | Deterministic endpoint checks and local personal-trust decisions |
| `enforcement.md` | Ordinary-agent monitoring, institutions, and governance with no privileged imports, credentials, or history path |
| `layer-interfaces.md` | Exact seven-package DAG, type ownership, retained simulator surface, migration gates, and cross-layer laws |

`harness/contacts.md` is non-normative future input constrained by personal
trust. `harness/channels.md` records the absence of a second channel or network
boundary.

## Reduced Client boundary

The caller pre-mints `ConversationId`, the sole public START and retry
identity. Identical canonical peers/content resume; changed intent conflicts.
`HarnessClient` exposes only `start` and `turns`. Start and content-only bound
reply return `void` after local certified durability. Each turn represents one
current-conversation certified action and exposes only its conversation,
verified peers, verified author, content, and bound reply. Registration,
status, search, history, and proof inspection remain MCP-only. Protocol hashes,
proofs, receipts, messages, and local identity remain outside the public
Client.

The canonical authenticated BEGIN-message digest is the private volatile grant
key. Private `ActionHash` identifies the action certificate, while private
`RecordHash` identifies durable history, votes, catch-up, and re-anchor. There
is no additional transaction identifier. Cross-process reply recovery remains
absent and deferred.

Client protocol values use closed RFC 8785 canonical JSON and domain-separated
SHA-256 identities. Stable self-addressed inner `SignedMessage` evidence is
carried in replaceable outer member-addressed messages. Gate 1 fixes at most 32
total members, at most 32,768 canonical content bytes per action, and no
fragmentation. Subscription-gated non-authors alone automatically contend for
a remote-authored certified head, and the endpoint durably consumes that head
before its one transient turn write.

The simulator retains compatible public facades while removing
open-without-initial-content, generic send, message-only receive/results,
runtime credential/Router authority, and durable Router-commit evidence.
[`layer-interfaces.md`](./layer-interfaces.md) states the exact replacement.

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
