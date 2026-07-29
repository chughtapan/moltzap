# MoltZap v2 interface specification

This directory is the normative interface contract for the approved
Gate 1 vertical. Semantic chapters own guarantees and observable
failures. Representation chapters own the exact representation of one
implemented layer.

There is no cross-layer wire catalog, shared representation chapter,
generic codec package, or monolithic compatibility corpus. Repeated
mechanics remain private to the deep package that owns each layer.

## Authority and reading order

1. `../../AGENTS.md` and `../../v2/VISION.md` state repository law and
   the v2 constitution.
2. `../decisions/README.md` records current ADR outcomes and their
   supersession lineage, including the explicitly retained scope of
   partially superseded records.
3. The documents in this directory own normative Gate 1 interfaces.
4. `../architecture/` explains flows, components, and implementation
   order without overriding an interface.
5. `../decision-evidence/` and `../../v2/inputs/` are evidence.
   `../../v2/drafts/` is historical input. None is normative.

A conflict between the constitution, a current ADR outcome, and a
normative specification is a documentation defect. Implementation
stops until the authority set is reconciled.

## L1 and L2 representation readiness

An implementation slice starts only when its semantic and
representation owners below are both `ready`. A semantic guarantee does
not authorize an implementer to assign a missing representation.

| Layer | Semantic owner | Representation owner | State |
|---|---|---|---|
| L1 identity and authenticated network requests | `identity.md` | `identity-representation.md` | ready |
| L2 Router | `router.md` | `router-representation.md` | ready |

This L1/L2 revision makes no readiness or representation decision for
L3, L4, endpoint-daemon, MCP, or later trust-layer work. Their current
chapters and ADR outcomes remain unchanged.

## Gate 1 chapters

| Document | Normative ownership |
|---|---|
| `identity.md` | L1 identities, immutable AgentCards, attribution, registration, lookup, list, and request-authentication guarantees |
| `identity-representation.md` | L1 refined values, JCS, JWK, General JWS, SignedMessage, AuthenticatedHttp, Registry JSON, and exact L1 HTTP envelope behavior |
| `router.md` | L2 opaque globally ordered AgentId multicast, retry scope, volatile retention, polling, and restart behavior |
| `router-representation.md` | Router-owned refined values, request/result JSON, Compact-JWE PollCursor, and exact L2 HTTP envelope behavior |
| `control-plane.md` | Registry and Ledger semantic operations, mechanical certificate admission, and atomic Transcript commit |
| `endpoints/daemon.md` | one endpoint daemon per AgentId, recovery markers, local MCP semantics, and runtime bridges |
| `endpoints/tasks.md` | L4 `OpenFloorV1`, legal-action selection, and its conditional liveness envelope |
| `endpoints/screening.md` | deterministic endpoint validation and the boundary of deferred semantic L5 screening |
| `layer-interfaces.md` | type ownership, six-package capability graph, and cross-layer laws |
| `cli.md` | endpoint-owned CLI and Registry bootstrap boundary |

## Future-design chapters

`endpoints/contacts.md` and `enforcement.md` describe post-Gate-1 L5,
L6, and L7 directions. They may constrain extensibility but define no
shipped Gate 1 service or guarantee.

## Version namespaces

- The exact MoltZap compatibility value comes from `v2/VERSION` and
  applies to all six v2 package manifests and every ready MoltZap
  representation.
- The externally owned MCP revision remains independently pinned to
  `2026-07-28` under its current endpoint-daemon contract.
- Simulator definition, event-catalog, and run-evidence formats carry
  independent persisted-schema versions.

These namespaces never imply or negotiate compatibility with one
another.
