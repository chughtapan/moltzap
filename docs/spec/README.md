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

## Implementation readiness

An implementation slice starts only when its semantic and
representation owners below are both `ready`. A semantic guarantee does
not authorize an implementer to assign a missing representation.

| Domain | Semantic owner | Representation owner | State |
|---|---|---|---|
| L1 identity and authenticated network requests | `identity.md` | `identity-representation.md` | ready |
| L2 Router | `router.md` | `router-representation.md` | ready |
| L3 Transcript and Ledger | `control-plane.md` | not yet admitted | semantic contract ready; implementation remains blocked on representation |
| Harness daemon process and retained raw MCP | `harness/daemon.md` | retained clean-slate MCP contract | profile-slot topology, transport, raw START/reply, and grant-listen mechanics ready |
| Harness management MCP | `management.md` | backing-owned closed tool Schemas and errors | names, ownership, and pagination selected; missing status/search/history representations, agent/conversation search projections, and empty-query behavior are not ready |
| Harness ingress | `harness/ingress.md` | retained grant event plus backing-owned content-only event | grant delivery ready; content-only observation is not ready where its backing has no admitted method and Schema |
| Harness model output | `harness/output.md`, `harness/tasks.md` | retained raw START/reply representations | direct raw operations ready; payload-only projection is not ready when several legal actions require an unselected mapping |
| Harness runtime client | `harness/client.md` | exact Effect signatures plus backing-owned MCP representations | semantic shape selected; exact method/stream/result/error types, context reconstruction dependencies, plural-action reply mapping, and the separately owned production contract are not ready |

No implementation may infer a missing L3 or backing-specific MCP
representation or action-selection rule from the Harness contract.

## Implementation decision ownership

The accepted implementation decisions remain split by their owning
domain rather than collected into a new shared contract:

| Decision family | Current ADR | Normative owner | Freeze acceptance |
|---|---|---|---|
| Registry bootstrap admission | [Registry bootstrap admission](../decisions/20260729-registration-is-registry-bootstrap-admission.md) | `identity.md` — Registration and AuthenticatedHttp; `identity-representation.md` — HTTP request framing and ownership | `ID`, `WIRE` |
| Closed public APIs and deep Effect capabilities | [Deep Effect capabilities](../decisions/20260729-identity-and-router-expose-deep-effect-capabilities.md) | `identity.md` — Public package boundary, Signing and verification, AuthenticatedHttp, Registry capability, Private Effect RPC, and Error contract; `router.md` — Public package boundary and Effect capability and private RPC; `layer-interfaces.md` — Identity and Router construction handoffs | `ARCH`, `ID`, `L2` |
| Effect Schema boundary parsing | [Deep Effect capabilities](../decisions/20260729-identity-and-router-expose-deep-effect-capabilities.md) | `identity-representation.md` and `router-representation.md` — Canonical JSON; the owning semantic chapters' configuration sections | `ARCH`, `ID`, `L2`, `WIRE` |
| Effect Config loading | [Deep Effect capabilities](../decisions/20260729-identity-and-router-expose-deep-effect-capabilities.md) | `identity.md` — Registry configuration; `router.md` — Configuration | `ARCH`, `ID`, `L2` |
| Private Effect RPC context and errors | [Deep Effect capabilities](../decisions/20260729-identity-and-router-expose-deep-effect-capabilities.md) | `identity.md` — Private Effect RPC; `router.md` — Effect capability and private RPC; `layer-interfaces.md` — Identity and Router construction handoffs | `ARCH`, `ID`, `L2` |
| Fixed primitive and derived enclosing limits | [Fixed or derived limits](../decisions/20260729-representation-limits-are-fixed-or-derived.md) | `identity-representation.md` — SignedMessage and Registry routes; `router-representation.md` — Representation limits; `router.md` — Operational bounds | `ID`, `L2`, `WIRE` |
| Documentation-only numbered-layer notation | [Deep Effect capabilities](../decisions/20260729-identity-and-router-expose-deep-effect-capabilities.md) | `v2/AGENTS.md` — Implementation rules; `layer-interfaces.md` — Acceptance criteria | `ARCH` |
| L1/L2-only revision scope | [Layer-owned representations](../decisions/20260729-representations-are-layer-owned.md) | this page — Implementation readiness; `v2/VISION.md` — Gate 1 profile | `DOC`, `DEFER` |
| One profile-slot Harness daemon and MCP-only operation | [One profile-slot daemon](../decisions/20260801-harness-is-one-profile-slot-daemon.md) | `harness/daemon.md`; `management.md` | `ARCH`, `MCP`, `DEFER` |
| Client-owned runtime context and compile-time compatibility | [HarnessClient owns runtime context](../decisions/20260801-harness-client-owns-runtime-context.md) | `harness/client.md`; `management.md` | `ARCH`, `MCP`, `DEFER` |
| Content notifications independent from reply grants | [Inbound notifications](../decisions/20260801-inbound-notifications-separate-content-from-grants.md) | `harness/ingress.md`; `harness/client.md` | `MCP`, `L3`, `DEFER` |
| Conversation start and turn-bound payload-only reply | [Model output](../decisions/20260801-model-output-is-start-or-bound-reply.md) | `harness/output.md`; `harness/tasks.md` | `MCP`, `L3`, `PROTO`, `DEFER` |

The Gate 1 freeze manifest owns the stable `G1-DEC-NNN` rows and is the
authoritative mapping from these families to acceptance evidence. This
table is a discovery aid, not a second decision manifest.

## Gate 1 chapters

| Document | Normative ownership |
|---|---|
| `identity.md` | L1 identities, immutable AgentCards, attribution, Registry bootstrap, registered-agent AuthenticatedHttp, exact public Effect capability and error contracts, Registry configuration, lookup, and list |
| `identity-representation.md` | L1 refined values, JCS, JWK, General JWS, SignedMessage, Registry-owned bootstrap framing, AuthenticatedHttp, Registry JSON, derived bounds, and exact L1 HTTP envelope behavior |
| `router.md` | L2 opaque globally ordered AgentId multicast, exact public Effect capability and error contracts, private RPC, configuration and fit laws, retry scope, volatile retention, polling, and restart behavior |
| `router-representation.md` | Router-owned refined values, request/result JSON, Compact-JWE PollCursor, derived representation limits, and exact L2 HTTP envelope behavior |
| `control-plane.md` | control-plane process separation and common HTTP laws, Registry operation orientation, Ledger semantic operations, mechanical certificate admission, and atomic Transcript commit |
| `harness/daemon.md` | one profile-slot `moltzapd`, registration and active MCP paths, recovery, and process ownership |
| `harness/client.md` | public `HarnessClient`, client-owned context, and turn-bound reply |
| `harness/ingress.md` | retained MCP receive contract, content/grant separation, one live authority per conversation, and transient delivery |
| `harness/output.md` | conversation start, payload-only turn reply, absence of generic send, and retained backing-owned START mechanics |
| `harness/tasks.md` | L4 `OpenFloorV1`, backing-private legal-action selection, and its conditional liveness envelope |
| `harness/screening.md` | deterministic Harness validation and the boundary of deferred semantic L5 screening |
| `management.md` | registration, status, paginated `search_*`, conversation-history tools, and unresolved owner-defined search projections |
| `layer-interfaces.md` | type ownership, six-package capability graph, identity/Router construction handoffs, and cross-layer laws |

## Future-design chapters

`harness/contacts.md` and `enforcement.md` describe post-Gate-1 L5,
L6, and L7 directions. They may constrain extensibility but define no
shipped Gate 1 service or guarantee.

## Version namespaces

- The exact MoltZap compatibility value comes from `v2/VERSION` and
  applies to all six v2 package manifests and every ready MoltZap
  representation.
- The externally owned MCP revision remains independently pinned to
  `2026-07-28` under the current Harness-daemon contract.
- Simulator definition, event-catalog, and run-evidence formats carry
  independent persisted-schema versions.

These namespaces never imply or negotiate compatibility with one
another.
