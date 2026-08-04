# Gate 1 implementation plan

{/* @bake-constants: V2_PROTOCOL_VERSION */}

Status: **HARNESS AUTHORITY REVIEWED — IMPLEMENTATION READINESS VARIES BY OWNER**

The complete approved L1 and L2 handoff is
[`l1-l2-implementation-ask.md`](./l1-l2-implementation-ask.md). That
document remains the durable L1/L2 implementation ask. The Harness
implementation boundary is recorded in
[`harness-implementation-slate.md`](./harness-implementation-slate.md).
This page records the repository-wide order and prevents later work
from racing ahead of its authority.

Normative behavior lives in `v2/VISION.md`, current ADR outcomes, and
`docs/spec/`. This plan never overrides them.

## Outcome

Gate 1 produces one stack with:

- an L1 Registry and AuthenticatedHttp boundary;
- an L2 content-blind Router with a private global order;
- an L3 Ledger for mechanically admitted atomic Transcript commits;
- one `moltzapd` per named local profile slot;
- one portable simulator driving the production capabilities;
- one testbed acquiring the stack and adding faults; and
- OpenClaw and NanoClaw as consumers of the selected `HarnessClient` semantic
  shape after its exact branch-owned contracts are admitted.

The L1/L2 authority remains unchanged. The Harness decisions rename the
later package and daemon, move all local operations behind MCP, and add
the shared client-facing semantics described below. They do not assign
a missing L3 or backing-specific raw representation.

## Non-negotiable boundaries

- Registry, Router, Ledger, and each Harness daemon are independent
  processes.
- Router and Ledger are siblings. Harness backings coordinate them.
- Router sees only attributed L1 addressing and opaque body bytes.
- L3 owns conversations, retries, recovery, certificates, and durable
  actions.
- Endpoints decide validity. Ledger checks complete certificates
  mechanically.
- One TranscriptRecord is atomically committed for all fixed members or
  for none.
- The local daemon-to-runtime MCP surface is not a network plane.
- Registration and active operations share one daemon but use separate
  MCP paths. There is no bespoke CLI authority.
- Production and clean-slate backings target the same semantic
  `HarnessClient` consumer shape. Their exact branch-owned contracts must be
  admitted before compile-time compatibility is checked; there is no runtime
  selection.
- Runtime context belongs to `HarnessClient`; content notification and
  reply authority remain distinct.
- At most one live reply authority exists for a conversation.
- Model output is conversation start with initial content or turn-bound reply;
  there is no generic established-conversation send, and this boundary assigns
  no new START mechanics to another backing.
- Each layer owns a separate representation chapter and private
  mechanisms.
- V2 contains exactly six deep packages and imports nothing from
  `packages/*`.
- Simulator and testbed are never production dependencies.
- Application code imposes no TLS, URL-scheme, certificate, or
  trusted-proxy policy. Deployment owns channel protection and preserves
  signed request components.

## Package and process shape

| Package | Depends on | Production process |
|---|---|---|
| `identity` | none | `moltzap-registry` |
| `router` | `identity` | `moltzap-router` |
| `transcript` | `identity`, Router contracts | `moltzap-ledger` |
| `harness` | `identity`, `router`, `transcript` | `moltzapd` |
| `simulator` | public `identity` and `HarnessClient` capabilities | none |
| `testbed` | all five | none |

The authority slice renames `v2/transport` to `v2/router`,
`@moltzap/v2-transport` to `@moltzap/v2-router`, and
`moltzap-directory` to `moltzap-registry`. It updates all manifests,
project references, workspace checks, and documentation atomically.

`v2/VERSION`, every v2 package manifest, and the ready MoltZap
representations advance together to `2026.729.1`. MCP and simulator
persisted-schema versions remain independent. The requested ACG upgrade
is omitted from this work.

## Gate 0 — reconcile and review authority

Before product code:

1. admit the four focused 2026-07-29 ADRs and their source-faithful
   trajectory;
2. update every superseded or partially superseded record, the decision
   index, and the Gate 1 trace manifest;
3. reconcile agent law, constitution, normative specs, and architecture
   orientation;
4. remove the superseded cross-layer wire profile;
5. land the package vocabulary and version changes above;
6. pass documentation, architecture, build, type, and lint checks;
7. freeze the exact candidate as a commit;
8. run the six-question blind teammate review from a fresh isolated
   context; and
9. obtain maintainer acceptance of that result.

Any semantic correction creates a new candidate and requires a
different fresh reviewer. No implementation commit may be based only on
chat or on the unreviewed candidate.

The Harness authority follows the same admission, traceability, and
blind-review gate through its four focused 2026-08-01 ADRs.

## Gate 1 — immutable simulator source baseline

The simulator port uses only the landed SHA recorded in
`v2/inputs/simulator-handoff-20260728.md`. Until that manifest names a
reconstructible, tracked, constitution-aligned source commit and the
handoff checks pass, simulator source work remains blocked.

The port preserves the code-first `Simulator.define` surface, closed
EventCatalog, typed run-evidence RunLedger, scoped runtime roster, and
private lifecycle engine. It replaces v1-facing types with v2 public
capabilities. RunLedger never substitutes for the product Transcript.

## Gate 2 — implement L1 in readability-reviewed slices

The governing contracts are `docs/spec/identity.md` and
`docs/spec/identity-representation.md`.

The slices are:

1. refined identity values and strict canonical base64url;
2. private JCS and JOSE adapters, AgentCard, and SignedMessage;
3. the deep AuthenticatedHttp boundary;
4. Registry client, PostgreSQL repository, migrations, and server;
5. `moltzap-registry` process composition; and
6. black-box, integration, property, interoperability-example, and
   type-canary coverage owned by L1.

Use maintained standards libraries behind narrow private adapters. Do
not implement custom JSON canonicalization, JOSE, HTTP message
signatures, structured headers, PostgreSQL drivers, or a generic wire
framework.

Each slice must:

- satisfy its normative acceptance criteria;
- keep expected failures typed and closed;
- validate untrusted data at the boundary;
- expose a deep domain API rather than library objects;
- run its focused Nx checks; and
- pass a human readability and vocabulary review before the next slice.

## Gate 3 — implement L2 in readability-reviewed slices

The governing contracts are `docs/spec/router.md` and
`docs/spec/router-representation.md`.

The slices are:

1. Router-owned refined values and opaque PollCursor;
2. Router client contracts and authenticated requests;
3. one bounded global SignedMessage ring and coupled retry index;
4. sender verification and positive immutable AgentCard cache;
5. initial and continuation polling with request-scoped waiters;
6. `moltzap-router` process composition; and
7. concurrency, retention, restart, cursor, fault, property, and
   black-box coverage owned by L2.

The Router keeps bounded volatile process state, not durable state. It
stores one copy per accepted SignedMessage and no per-recipient queue,
cursor record, session, database, public sequence value, or delivery
wrapper.

Every slice has the same focused verification and human readability
review gate as L1.

## Gate 4 — Harness implementation boundary

The Harness work proceeds in narrow slices:

1. rename `v2/endpoint` to `v2/harness`, the package to
   `@moltzap/v2-harness`, and the daemon to `moltzapd` without retaining
   public Endpoint aliases;
2. after their backing-owned representations are admitted, expose registration
   and active management/runtime tools through one daemon's MCP server,
   including paginated `search_*` tools, without inventing empty-query behavior
   or agent/conversation result values in Harness, and remove the bespoke CLI
   boundary;
3. after the exact `HarnessClient` Effect signatures and portable errors are
   admitted, define the clean-slate Tag, Layer, and MCP client; add the
   bidirectional compile-time canary only after the production contract lands
   on `main`;
4. keep content notification independent from reply authority, enforce
   one live authority per conversation, and assemble current and
   cross-conversation context in `HarnessClient`;
5. expose conversation start with initial content and, for an unambiguous or
   owner-mapped action, a payload-only reply bound to the live turn, with no
   generic established-conversation send and no new cross-backing START
   contract; and
6. adapt OpenClaw and NanoClaw only through `HarnessClient`.

Existing production and clean-slate protocol, Ledger, recovery, and MCP
mechanics remain in place unless one of those decisions explicitly
changes them. Missing L3 or backing-specific raw representations remain
blocked rather than being invented by this plan.

## Future end-to-end proof

Testbed acquires the one production stack, supervises external
processes, supplies public-capability substitutes where a focused test
requires them, and injects faults from outside. It does not insert a
second Router or Ledger into production code.

The final proof covers:

- Registry uniqueness, idempotency, signer continuity, persistence,
  replay protection, and outage behavior;
- Router total order, byte identity, retry retention, cursor
  continuation, feed gaps, restart fencing, resource bounds, and
  Registry-cache behavior;
- Ledger atomicity, signer-set mechanics, dense offsets, hash chain,
  restart, and ambiguous append recovery;
- START and OpenFloorV1 safety and conditional liveness;
- Harness restart, lost notifications,
  reply recovery, and cross-conversation concurrency;
- the accepted MCP contract;
- simulator determinism and run-evidence integrity; and
- after the exact client contract is admitted, OpenClaw and NanoClaw as
  `HarnessClient`-only consumers.

Publishing, deployment, cutover, and v1 retirement are separate work.

## Verification rules

Run tasks through Nx with the workspace package manager. At minimum,
the candidate or affected slice runs:

- architecture and v1-import guards;
- generated-document drift checks;
- Markdown and Mermaid checks;
- affected builds, typechecks, lints, and tests;
- package export and dependency checks; and
- any new integration or black-box targets introduced by the slice.

A passing command that discovers no intended source or test is a
failure. Preserve the exact failing evidence and fix the gate rather
than treating a vacuous result as success.

## Completion criteria

The L1/L2 implementation is complete only when:

- every implemented surface has a current semantic and representation
  owner;
- every accepted ADR has valid lineage, provenance, manifest trace, and
  an accepted blind review;
- all six packages share the exact current compatibility value;
- no v2 source imports v1 or violates the six-package DAG;
- Registry and Router satisfy their fault, restart, and recovery
  contracts;
- all focused and end-to-end checks pass non-vacuously; and
- each implementation slice has a recorded human readability review.

The Harness implementation additionally requires compile-time
structural compatibility between its independent clients and proof that
runtime adapters neither import nor construct Harness backing
internals.

## Explicit deferrals

Router replication and Byzantine sequencing; persistent or
per-recipient Router state; end-to-end encryption and key distribution;
L1 rotation, revocation, and recovery; dynamic membership;
non-unanimous certificates; append takeover and disputes; L6/L7/L8
services; hostile-local-process security; event replay; deployment,
publishing, and all later-layer implementation. Exact new Harness
configuration, lifecycle, persistence, cursor, buffering, resource
limit, retry, overload, and raw-wire rules remain deferred unless they
are already owned by a current contract.

Production adoption of `HarnessClient` and removal of the production line's
legacy local surfaces remain `main`-owned dependencies rather than v2
authority.
