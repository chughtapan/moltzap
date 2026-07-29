# MoltZap v2 interface specification

This directory is the normative interface contract. Its Gate 1 chapters
define the approved first vertical; explicitly indexed accepted
post-Gate-1 chapters bind later targets without changing Gate 1 completion.
Every chapter states observable guarantees and failure outcomes. Mechanism
belongs in explicitly non-normative implementation notes or in
`../architecture/first-implementation.md` unless a current ADR makes a
mechanism part of a named normative profile.

`wire-profile.md` is the Gate 1 exception: an exact byte contract is
mechanism by nature, and Gate 1 requires it to be normative precisely so
that no implementer assigns a value the guarantees left open. The accepted
post-Gate-1 distributed profile likewise fixes named deployment mechanisms;
its owning ADRs and chapter state their scope.

## Authority and reading order

1. `../../AGENTS.md` and `../../v2/VISION.md` state repository law and
   the v2 constitution.
2. `../decisions/README.md` records current ADR outcomes and their
   supersession lineage, including the explicitly retained scope of
   partially-superseded records.
3. The documents in this directory own the normative Gate 1 interfaces
   and explicitly indexed accepted post-Gate-1 targets. A decision is not
   implemented until its owning spec is consistent with it.
4. `../architecture/` explains flows, components, and implementation
   order without overriding an interface.
5. `../decision-evidence/` and `../../v2/inputs/` are evidence;
   `../../v2/drafts/` is historical input. None is normative.

A conflict between the constitution, a current ADR outcome, and a
normative spec is a documentation defect; readers must not resolve it
by precedence or inference.

## Completeness boundary

The repository-native architecture freeze establishes semantic
ownership, allowed operations, guarantees, and failure behavior. It
does not itself assign every byte-level constant needed for an
independent implementation. In particular, phrases such as “fixed
numeric map keys” constrain the final profile; they do not authorize
an implementer to choose those values.

`wire-profile.md` is that catalog. It is accepted and normative, and
it is the single owner of:

- the exact AgentName grammar and textual identifier prefixes;
- X.509 fields, extensions, OIDs, criticality, routing encoding, and
  attestation-chain validation;
- numeric CBOR maps, closed result/tag maps, and every protocol-message
  schema, including the L1 sender and explicit recipient set for each
  L3 message kind and whether the sender is included;
- COSE algorithms, protected and unprotected labels, critical headers,
  external AAD, and domain-separation bytes;
- identifier, digest, ConversationId, TxnId, RecordHash, and
  reply-retry preimages and constants;
- the canonical operation-equality preimage for every idempotent route,
  excluding fresh per-attempt RFC 9421 authentication metadata;
- PollCursor encoding and integrity protection, Router send
  `initial`/`retry` discriminants, and current-instance result fields;
- HTTP status/content-type mappings and the closed route error
  taxonomy;
- the exact MCP tool, result, extension, notification, and subscription
  JSON Schemas.

That catalog requires positive and negative golden vectors produced by
at least two independent implementations. Only manifest/project
scaffolding may precede its accepted ADR and green vectors. Product,
protocol, simulator-port, client, and server implementation remain
blocked until those vectors pass. This is a pre-code Gate 1 contract
freeze, not a post-Gate-1 deferral.

## Gate 1 chapters

| Document | Normative ownership |
|---|---|
| `wire-profile.md` | every byte-level constant: identifier forms, AgentName grammar, X.509 profile, deterministic CBOR and COSE, protocol-message and route schemas, derivations, cursors, HTTP binding, MCP JSON Schemas, and the vector-corpus requirements |
| `identity.md` | L1 identities, immutable AgentCards, attribution, registration, and request authentication |
| `data-plane.md` | L2 globally ordered AgentId multicast and bounded HTTP polling |
| `control-plane.md` | Registry and Ledger operations, mechanical certificate admission, and atomic Transcript commit |
| `endpoints/daemon.md` | one endpoint daemon per AgentId, recovery markers, local MCP, and runtime bridges |
| `endpoints/tasks.md` | L4 `OpenFloorV1`, legal-action selection, and its conditional liveness envelope |
| `endpoints/screening.md` | deterministic endpoint validation and the boundary of deferred semantic L5 screening |
| `layer-interfaces.md` | type ownership, six-package capability graph, and cross-layer laws |
| `cli.md` | the endpoint-owned CLI and Registry bootstrap boundary |

## Future-design chapters

`endpoints/contacts.md` and `enforcement.md` describe post-Gate-1 L5,
L6, and L7 directions. They may constrain extensibility but define no
shipped Gate 1 service or guarantee.

## Accepted post-Gate-1 chapters

These chapters bind a later target without changing Gate 1 completion:

| Document | Normative ownership |
|---|---|
| [Distributed society execution](distributed-society-execution.md) | one-container-per-agent distributed cohorts, exact readiness and dispatch, Kubernetes/Kueue and GKE reference behavior, Temporal/controller boundaries, late-bound OpenClaw artifacts, and Pod enrollment |

Implementation of a post-Gate-1 chapter still requires its prerequisite
Gate 1 capabilities and a separately selected implementation scope.

## Version namespaces

- The exact MoltZap compatibility value comes from `v2/VERSION` and
  applies to all six v2 package manifests and MoltZap-owned wire.
- The externally owned MCP revision is independently pinned to
  `2026-07-28`.
- Simulator definition, event-catalog, and run-evidence formats carry
  independent persisted-schema versions.

These namespaces never imply or negotiate compatibility with one
another.
