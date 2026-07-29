# MoltZap v2 interface specification

This directory is the normative interface contract for the approved
Gate 1 vertical. It states observable guarantees and failure outcomes.
Mechanism belongs in explicitly non-normative implementation notes or
in `../architecture/first-implementation.md`.

## Authority and reading order

1. `../../AGENTS.md` and `../../v2/VISION.md` state repository law and
   the v2 constitution.
2. `../decisions/README.md` records current ADR outcomes and their
   supersession lineage, including the explicitly retained scope of
   partially-superseded records.
3. The documents in this directory own the normative Gate 1
   interfaces. A decision is not implemented until its owning spec is
   consistent with it.
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
does not yet assign every byte-level constant needed for an independent
implementation. In particular, phrases such as “fixed numeric map
keys” constrain the final profile; they do not authorize an implementer
to choose those values.

The first Phase 2A contract change must create and accept
`docs/spec/wire-profile.md` as the single normative catalog for:

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
protocol, simulator-port, client, and server implementation are
blocked. This is a pre-code Gate 1 contract freeze, not a post-Gate-1
deferral.

## Gate 1 chapters

| Document | Normative ownership |
|---|---|
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

## Version namespaces

- The exact MoltZap compatibility value comes from `v2/VERSION` and
  applies to all six v2 package manifests and MoltZap-owned wire.
- The externally owned MCP revision is independently pinned to
  `2026-07-28`.
- Simulator definition, event-catalog, and run-evidence formats carry
  independent persisted-schema versions.

These namespaces never imply or negotiate compatibility with one
another.
