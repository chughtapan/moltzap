# Decision log

Dated records of decisions that shaped this system, in MADR-minimal
form (`YYYYMMDD-short-title.md`). Date-prefixed slugs, never sequence
numbers, avoid merge collisions. Records are never deleted or
renumbered; history remains in git and supersession is explicit.

**Admission is maintainer-gated: the maintainer decides what enters
this log.** Do not add a record without that call.

## Canonical reading guidance

For Gate 1, begin with `AGENTS.md`, `v2/VISION.md`, and the focused
current ADR outcomes—accepted records and the explicitly retained
portions of partially-superseded records. Then use
[the architecture freeze](20260728-gate-1-architecture-freeze.md).
Its updated traceability inventory is the repository-native index of
every frozen decision, normative owner, acceptance category, and
explicit deferral. Follow each row to its layer-owned normative
specification.

This index is reviewed Markdown rather than generated output. Each
record's frontmatter remains authoritative for its status.

Every ADR visibly links to compacted decision provenance in
`docs/decision-evidence/`. That source-event ledger preserves native
locators, literal human and agent excerpts, mechanical repository
effects, and explicit source gaps without reconstructing a rationale.
ADR changes do not land until a fresh teammate, given no file pointers
or inherited session context, passes the blind review gate in root
`AGENTS.md`.

Status has exactly one of these meanings:

- `accepted`: the record's Decision Outcome remains current. Its
  Context, Considered Options, consequences, and implementation
  examples are historical reasoning and may retain vocabulary from the
  design state in which the decision was made. A visible Gate 1 note,
  when present, names the current concrete contract without changing
  the accepted outcome.
- `partially-superseded`: only the portion named in the visible
  Supersession section remains current; follow the replacement before
  relying on the historical body.
- `superseded`: historical context only; the linked replacement is the
  current decision.

When historical prose conflicts with an accepted replacement, the
replacement governs. No decision in this log depends on chat or a local
planning database as continuing authority.

## Records

| Decision | Date | Status | Superseded by |
|---|---|---|---|
| [Harness is one profile-slot daemon](20260801-harness-is-one-profile-slot-daemon.md) | 2026-08-01 | accepted | — |
| [HarnessClient owns runtime context](20260801-harness-client-owns-runtime-context.md) | 2026-08-01 | accepted | — |
| [Inbound notifications separate content from reply grants](20260801-inbound-notifications-separate-content-from-grants.md) | 2026-08-01 | accepted | — |
| [Model output is start or bound reply](20260801-model-output-is-start-or-bound-reply.md) | 2026-08-01 | accepted | — |
| [Principal I/O uses runtime-native gateways](20260729-principal-io-uses-runtime-gateways.md) | 2026-07-29 | accepted | — |
| [Evaluation runs produce typed reports published to Phoenix](20260729-effect-native-evaluation-results.md) | 2026-07-29 | partially-superseded | [Principal runtime gateways](20260729-principal-io-uses-runtime-gateways.md) |
| [Representation limits are fixed or derived](20260729-representation-limits-are-fixed-or-derived.md) | 2026-07-29 | accepted | — |
| [Identity and Router expose deep Effect capabilities](20260729-identity-and-router-expose-deep-effect-capabilities.md) | 2026-07-29 | accepted | — |
| [Registration is Registry bootstrap admission](20260729-registration-is-registry-bootstrap-admission.md) | 2026-07-29 | accepted | — |
| [V2 authority lives with V2](20260729-v2-authority-lives-with-v2.md) | 2026-07-29 | accepted | — |
| [L1 and L2 representations are layer-owned](20260729-representations-are-layer-owned.md) | 2026-07-29 | accepted | — |
| [Identity uses JCS, JOSE, and AuthenticatedHttp](20260729-identity-uses-jcs-jose-authenticated-http.md) | 2026-07-29 | partially-superseded | [Registry bootstrap admission](20260729-registration-is-registry-bootstrap-admission.md) |
| [Router order is opaque](20260729-router-order-is-opaque.md) | 2026-07-29 | accepted | — |
| [One wire profile assigns every Gate 1 byte](20260729-wire-profile-assigns-every-gate-1-byte.md) | 2026-07-29 | superseded | [Layer-owned representations](20260729-representations-are-layer-owned.md) |
| [ADRs link source events and require blind review](20260728-adrs-link-source-events-and-require-blind-review.md) | 2026-07-28 | accepted | — |
| [Gate 1 starts with a repository-native architecture freeze](20260728-gate-1-architecture-freeze.md) | 2026-07-28 | partially-superseded | [V2 authority](20260729-v2-authority-lives-with-v2.md), [L1/L2 layer-owned representations](20260729-representations-are-layer-owned.md), [JCS, JOSE, and AuthenticatedHttp](20260729-identity-uses-jcs-jose-authenticated-http.md), [Registry bootstrap admission](20260729-registration-is-registry-bootstrap-admission.md), [deep Effect capabilities](20260729-identity-and-router-expose-deep-effect-capabilities.md), [fixed or derived limits](20260729-representation-limits-are-fixed-or-derived.md), [opaque Router order](20260729-router-order-is-opaque.md), [Harness profile-slot daemon](20260801-harness-is-one-profile-slot-daemon.md), [HarnessClient runtime context](20260801-harness-client-owns-runtime-context.md), [inbound content and grants](20260801-inbound-notifications-separate-content-from-grants.md), [start or bound reply](20260801-model-output-is-start-or-bound-reply.md) |
| [Gate 1 fixes the layer boundaries and fault model](20260728-layer-boundaries-and-fault-model.md) | 2026-07-28 | accepted | — |
| [Gate 1 fixes one immutable identity profile and Registry bootstrap](20260728-gate-1-identity-profile.md) | 2026-07-28 | partially-superseded | [JCS, JOSE, and AuthenticatedHttp](20260729-identity-uses-jcs-jose-authenticated-http.md), [Registry bootstrap admission](20260729-registration-is-registry-bootstrap-admission.md) |
| [Gate 1 uses closed HTTP POST operations and bounded Router polling](20260728-network-wire-is-http-post-polling.md) | 2026-07-28 | partially-superseded | [JCS, JOSE, and AuthenticatedHttp](20260729-identity-uses-jcs-jose-authenticated-http.md), [Registry bootstrap admission](20260729-registration-is-registry-bootstrap-admission.md), [opaque Router order](20260729-router-order-is-opaque.md) |
| [Ledger performs mechanical atomic Transcript commit](20260728-transcript-is-mechanical-atomic-commit.md) | 2026-07-28 | accepted | — |
| [Gate 1 uses OpenFloorV1 with fixed membership and unanimity](20260728-open-floor-v1.md) | 2026-07-28 | accepted | — |
| [The endpoint daemon exposes modern MCP over loopback HTTP](20260728-endpoint-daemon-speaks-modern-mcp.md) | 2026-07-28 | partially-superseded | [Harness profile-slot daemon](20260801-harness-is-one-profile-slot-daemon.md), [HarnessClient runtime context](20260801-harness-client-owns-runtime-context.md), [inbound content and grants](20260801-inbound-notifications-separate-content-from-grants.md) |
| [The model surface is start_conversation, reply, and listen](20260728-model-surface-is-start-reply-listen.md) | 2026-07-28 | partially-superseded | [Start or bound reply](20260801-model-output-is-start-or-bound-reply.md), [HarnessClient runtime context](20260801-harness-client-owns-runtime-context.md), [inbound content and grants](20260801-inbound-notifications-separate-content-from-grants.md) |
| [V2 has six deep packages and one Moltzap version](20260728-six-deep-packages-one-version.md) | 2026-07-28 | partially-superseded | [Opaque Router order](20260729-router-order-is-opaque.md), [Harness profile-slot daemon](20260801-harness-is-one-profile-slot-daemon.md) |
| [V2 owns one simulator as the system driver](20260728-simulator-is-the-system-driver.md) | 2026-07-28 | partially-superseded | [HarnessClient runtime context](20260801-harness-client-owns-runtime-context.md) |
| [The simulator is code-first with a closed event catalog](20260727-code-first-simulator-kernel.md) | 2026-07-27 | partially-superseded | [Principal runtime gateways](20260729-principal-io-uses-runtime-gateways.md), [Simulator system driver](20260728-simulator-is-the-system-driver.md), [six packages and one version](20260728-six-deep-packages-one-version.md), [opaque Router order](20260729-router-order-is-opaque.md) |
| [Registration is out of band; the plane knows one caller](20260727-registration-is-out-of-band.md) | 2026-07-27 | superseded | [Registry bootstrap admission](20260729-registration-is-registry-bootstrap-admission.md), [Harness profile-slot daemon](20260801-harness-is-one-profile-slot-daemon.md) |
| [Attribution binds to the message, not the request](20260726-attribution-binds-to-the-message.md) | 2026-07-26 | partially-superseded | [JCS, JOSE, and AuthenticatedHttp](20260729-identity-uses-jcs-jose-authenticated-http.md) |
| [The engine dispatches to the harness after the grant](20260726-the-engine-dispatches.md) | 2026-07-26 | partially-superseded | [Inbound content and grants](20260801-inbound-notifications-separate-content-from-grants.md), [HarnessClient runtime context](20260801-harness-client-owns-runtime-context.md), [start or bound reply](20260801-model-output-is-start-or-bound-reply.md) |
| [The firewall starts as MCP middleware; logic deferred](20260724-firewall-starts-as-mcp-middleware.md) | 2026-07-24 | superseded | [Endpoint daemon](20260728-endpoint-daemon-speaks-modern-mcp.md), [model surface](20260728-model-surface-is-start-reply-listen.md) |
| [L7 is institutional policy attached to identity](20260724-l7-is-policy-attached-to-identity.md) | 2026-07-24 | superseded | [Layer boundaries and fault model](20260728-layer-boundaries-and-fault-model.md) |
| [Monitors are deterministic contracts; judgment is testimony](20260724-monitors-are-deterministic-contracts.md) | 2026-07-24 | accepted | — |
| [The firewall is the agent's boundary: two directions](20260724-firewall-two-directions.md) | 2026-07-24 | partially-superseded | [Inbound content and grants](20260801-inbound-notifications-separate-content-from-grants.md), [start or bound reply](20260801-model-output-is-start-or-bound-reply.md) |
| [Norms are MCP-served skill bundles (initial hypothesis)](20260724-norms-are-mcp-skill-bundles.md) | 2026-07-24 | superseded | [OpenFloorV1](20260728-open-floor-v1.md), [model surface](20260728-model-surface-is-start-reply-listen.md) |
| [Collectives are ledger transactions](20260724-collectives-are-ledger-transactions.md) | 2026-07-24 | partially-superseded | [Mechanical Transcript commit](20260728-transcript-is-mechanical-atomic-commit.md), [OpenFloorV1](20260728-open-floor-v1.md) |
| [Directory read serves cards](20260723-directory-serves-cards.md) | 2026-07-23 | partially-superseded | [JCS, JOSE, and AuthenticatedHttp](20260729-identity-uses-jcs-jose-authenticated-http.md) |
| [Protocol version: the package version, carried per request](20260723-protocol-version-carriage.md) | 2026-07-23 | superseded | [Six packages and one version](20260728-six-deep-packages-one-version.md), [HTTP POST network wire](20260728-network-wire-is-http-post-polling.md) |
| [The eval seam is a testbed data-plane implementation](20260723-eval-plane-is-testbed.md) | 2026-07-23 | partially-superseded | [Six packages and one version](20260728-six-deep-packages-one-version.md), [simulator system driver](20260728-simulator-is-the-system-driver.md) |
| [Conversation lifecycle rides in-band at L3](20260723-lifecycle-rides-l3.md) | 2026-07-23 | partially-superseded | [OpenFloorV1](20260728-open-floor-v1.md), [model surface](20260728-model-surface-is-start-reply-listen.md) |
| [Interim request-signature profile](20260723-interim-signature-profile.md) | 2026-07-23 | superseded | [JCS, JOSE, and AuthenticatedHttp](20260729-identity-uses-jcs-jose-authenticated-http.md), [Registry bootstrap admission](20260729-registration-is-registry-bootstrap-admission.md) |
| [The eight-layer stack](20260723-eight-layer-stack.md) | 2026-07-23 | partially-superseded | [Layer boundaries and fault model](20260728-layer-boundaries-and-fault-model.md) |
| [The spec set lives on main](20260722-spec-lives-on-main.md) | 2026-07-22 | superseded | [V2 authority](20260729-v2-authority-lives-with-v2.md) |
| [Data-plane layering: atomic multicast, transactional collectives](20260722-data-plane-layering.md) | 2026-07-22 | partially-superseded | [Layer boundaries](20260728-layer-boundaries-and-fault-model.md), [HTTP POST network wire](20260728-network-wire-is-http-post-polling.md), [mechanical Transcript commit](20260728-transcript-is-mechanical-atomic-commit.md) |
| [Control-plane encoding: neutral spec, JSON-RPC interim, REST + OpenAPI target](20260722-control-plane-encoding.md) | 2026-07-22 | superseded | [HTTP POST network wire](20260728-network-wire-is-http-post-polling.md) |
| [One credential: the card key authenticates everything](20260721-single-credential.md) | 2026-07-21 | partially-superseded | [JCS, JOSE, and AuthenticatedHttp](20260729-identity-uses-jcs-jose-authenticated-http.md) |
| [The network is sessionless](20260721-sessionless-network.md) | 2026-07-21 | partially-superseded | [Opaque Router order](20260729-router-order-is-opaque.md) |
| [The planes split at the transport](20260721-physical-plane-split.md) | 2026-07-21 | partially-superseded | [Opaque Router order](20260729-router-order-is-opaque.md), [Harness profile-slot daemon](20260801-harness-is-one-profile-slot-daemon.md) |
| [X.509 card container](20260721-x509-card-container.md) | 2026-07-21 | superseded | [JCS, JOSE, and AuthenticatedHttp](20260729-identity-uses-jcs-jose-authenticated-http.md) |
| [Native principal-shaped card](20260721-native-principal-shaped-card.md) | 2026-07-21 | partially-superseded | [JCS, JOSE, and AuthenticatedHttp](20260729-identity-uses-jcs-jose-authenticated-http.md) |
| [v2 lives top-level](20260721-v2-lives-top-level.md) | 2026-07-21 | partially-superseded | [Six packages and one version](20260728-six-deep-packages-one-version.md), [V2 authority](20260729-v2-authority-lives-with-v2.md), [opaque Router order](20260729-router-order-is-opaque.md), [Harness profile-slot daemon](20260801-harness-is-one-profile-slot-daemon.md) |
| [AGENTS.md is the single source](20260721-agents-md-single-source.md) | 2026-07-21 | accepted | — |
| [The network is a router](20260720-the-network-is-a-router.md) | 2026-07-20 | partially-superseded | [Layer boundaries](20260728-layer-boundaries-and-fault-model.md), [mechanical Transcript commit](20260728-transcript-is-mechanical-atomic-commit.md) |
