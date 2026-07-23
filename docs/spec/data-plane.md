# Data plane

Status: DRAFT (deepening doc; feeds the spec set)

## Purpose & scope

The data plane is the delivery half of the network, split out of the control
plane. It carries network delivery and collective operations — shipping L1
frames under L2 semantics: ordered, with pessimistic concurrency control (PCC),
MULTICAST-only in the first version per the constitution's recorded decision —
and addresses every delivery through a conversation (L2.5). It is the shared
substrate under every agent's harness; everything interpretive lives at
endpoints.

By recorded decision the plane decomposes in two
(`docs/decisions/20260722-data-plane-layering.md`): a **delivery layer** whose
only primitive is atomic multicast — a frame delivered to the conversation's
membership all-or-none, in the conversation's single total order — and a
**messaging layer** above it, where conversations address (L2.5) and
collective operations are transactions over the per-conversation transcript.
Tasks sit above the plane entirely; endpoint firewalls act at the delivery
layer, programmed by the layers above.

Goals: state the plane's duties as guarantees, independent of realization;
record the dissolution of the v1 app layer, power by power; propose the one
centralized middleware that would remain — a fault-injection /
capability-evaluation (measuring agent behavior under controlled adversity)
seam for experiments and evals — pending a recorded maintainer decision (open
question 9). Non-goals: the collective op set, call shape, and the completion /
failure / concurrency / initiation / witness / ordering clusters (owned by the
L2 semantics charter; this doc scopes only the v0 MULTICAST + PCC slice);
control-plane duties (identity, membership administration, the record substrate
itself); endpoint concerns (L3 screening, L4 norms, which op a well-behaved
participant emits next).

## Duties (guarantee level)

- **Delivery.** The plane accepts a signed L1 frame naming a collective
  operation from a conversation member and delivers it to the members the
  envelope addresses; the v0 slice's only operation is MULTICAST to the
  membership. Prompt push is best-effort; convergence is guaranteed
  (timeliness and delivery-status semantics are chartered): a member that
  misses a push recovers the history and reaches the same observed sequence as
  one that never disconnected.
- **Ordering.** Deliveries within a conversation are totally ordered: every
  member observes the same messages in the same order, including members
  transiently unavailable at send time.
- **Turn discipline (PCC).** In the v0 slice the plane admits contributions one
  at a time per conversation, only under the group's agreed next operation and
  next speaker. An endpoint observes that its turn is admitted before it
  generates — agreement precedes generation, not merely delivery.
  Overlapping-collective concurrency is chartered, not decided here.
- **Transactional collectives.** A collective operation is one transactional
  unit over the conversation's transcript: the record represents one
  ALL-TO-ALL — MPI-style, every member contributes and every member
  receives — as that operation, never as a sequence of independent messages.
  Endpoints drive the exchange under PCC using the delivery primitive; the
  plane contributes the primitive and the representation, nothing more. The
  vocabulary and its semantics are chartered (#765).
- **Attribution in transit.** Frames arrive carrying the L1 attribution they
  were emitted with, verifiable by the recipient; the plane never mints,
  alters, or strips it.
- **Admission.** At admission the plane verifies, at minimum, that the
  frame's attribution verifies per L1, its sender identity exists
  and is active, and the sender is a member of the conversation the
  envelope addresses; failing frames are refused before durability.
  Recorded decision: admission checks nothing relationship-shaped
  beyond membership — the router has no reachability role.
- **Content-blindness.** Routing and admission read envelope fields only, never
  bodies. End-to-end encryption stays a preserved possibility.
- **Records handoff.** Durable-then-deliver: no frame fans out before it is
  durable in the record substrate (control-plane-side; the record L5 reads).
- **Addressing (L2.5).** A conversation id is the routing handle — an opaque
  group handle. Membership changes are delivered in-band, ordered against
  message flow. Read-back is scoped by membership and envelope fields; the
  exact fields are chartered.

## Wire surface

**Not defined yet** (this doc's open question 10). By recorded decision an interim
realization keeps v1's WebSocket machinery, replaceable without spec change
(`docs/decisions/20260722-data-plane-layering.md`; details and the known
deviation: Implementation notes). What is decided bounds any future
definition (`docs/decisions/20260721-physical-plane-split.md`,
`docs/decisions/20260721-sessionless-network.md`,
`docs/decisions/20260721-single-credential.md`,
`docs/decisions/20260722-data-plane-layering.md`): data-plane traffic rides
its own surface, never the control endpoint; delivery is one-way — no
response rides the delivery path, and an endpoint's responses,
acknowledgments included, are first-class send calls; the plane keeps no per-endpoint
connection or session state, so whatever shape delivery takes must be
resumable from a position the endpoint owns; every call is signed with the
caller's card key and carries the protocol version; and frames cross the
surface byte-exact (`identity.md`). Turn-signal carriage is the charter's
ground (#765); whatever its shape, turn state is per-conversation
coordination state that expires by a bounded timeout, never by disconnect —
no connection state exists to observe.

## The eval middleware (proposed)

Proposed, pending a recorded maintainer decision (this doc's open question 9): at most
one centralized middleware exists — a fault-injection / capability-evaluation
seam for experiments and evals, explicitly not a production app layer.

- **May observe:** envelope-level delivery events and op lifecycle (accepted,
  ordered, delivered), with timing; terminal-state vocabulary is deferred to
  the charter's completion / failure clusters; body observation follows the
  deployment's encryption posture (open, below).
- **May inject:** only faults inside the failure envelope the L2 semantics
  already tolerate — delay, missed push (recoverable by catch-up), disconnect,
  partition, an unresponsive counterparty. Injected faults are
  indistinguishable, to production semantics, from natural ones.
- **May never:** mint or alter attribution, rewrite or reorder committed order,
  mutate membership, author policy verdicts, or carry standing policies.
- **Production never depends on it:** no guarantee here is conditioned on its
  presence; it is absent by default, and when present its configuration is part
  of the experiment's recorded run configuration (the run artifact the
  experiment publishes).

## Reuse (where directed; non-normative)

Recorded (maintainer comment on #765, 2026-07-21 — labeled architecture
guidance, not normative interface text): the v1 dispatch-lease turn discipline
is reused as the PCC instrument inside delivery semantics — an instrument, not
an interface: no lease concept appears on the wire surface or in normative
guarantees (sketch in Implementation notes). Proposed, pending a recorded
decision: the v1 conversation machinery (participant sets, subscription-scoped
delivery) as the L2.5 addressing primitive, and the v1 conformance pattern —
adversity as a suite-invocation parameter, plus scripted-counterparty faults —
as the shape of the proposed eval middleware's injection surface.

## Dissolution notes

The app layer dissolves: no app principals, no manifests, no hooks, no reverse
callbacks. Destinations, power by power:

| v1 power | Destination |
|---|---|
| Message-authorize hook (per-message forward/block verdict) | Abolished. The plane delivers; inbound screening is endpoint L3. |
| Verdict-derived recipient sets (per-message visibility filter) | Membership and envelope-level addressing; exact fields chartered (open). |
| Dispatch-authorize hook (moderator grants/denies/holds a turn) | Dissolved into PCC delivery semantics; which op/speaker comes next is an L4/skill concern. |
| Admission deny ejecting the participant | Abolished. Admission outcomes never mutate membership; membership changes are their own in-band ordered events. |
| Task-create hook, TaskMasters, network-side task records | Tasks are endpoint conventions with no network representation; conversations stand alone, bound to no task or app. |
| App manifests, app principals, reverse-callback extension surface | Gone entirely; the proposed eval middleware would be the only centralized seam (this doc's open question 9). |
| Moderator lease notifications and moderator-scoped lease reads | Die with the moderator principal; member-facing delivery-status semantics chartered (open). |
| Lease-derived presence ("working") | Presence semantics chartered (open). |
| Fail-closed blocking when an app is unreachable | Gone; no network-side gatekeeper exists to be unreachable. |

## Implementation notes (non-normative)

Interim wire: the v1 WebSocket machinery carries the plane for now — ship as
a JSON-RPC request; delivery is a fire-and-forget call on the connection's
reverse RPC channel (v1 labels it a notification, but the frame carries an id
and its void acknowledgment is discarded). That carriage deviates from the
one-way delivery bound: the fix restores a strict id-less notification, any
acknowledgment becoming a separate send call. The interim socket also binds
identity at connect with a bearer key and carries mixed traffic. The v1
machinery is a migration baseline, not a compliant realization: the
sessionless, single-credential, and plane-split bounds stay normative, and
these gaps are what the migration closes. Transitional mechanism, not
interface: the sessionless guarantees govern (recovery is position-resumable;
the connection is never semantic state), and replacement needs no spec change.

Maintainer sketch: the plane's realization is a per-conversation ordered
transcript plus dispatch leases implementing the PCC discipline. Frames are
transcript entries; the lease is the turn instrument, bracketing the durable
append (claim, append, finalize; rollback on failure), with a TTL that never
expires a claim mid-append and disconnect cleanup that never rolls back a
committed entry. Gaps observed in the v1 realization, recorded for salvage:
sequence assigned at insert start breaks gap-free catch-up under concurrent
commits; no per-conversation exclusivity invariant on active leases; lease
state in-memory and single-node (whether this is a gap is contingent on open
question 5); grant coalescing lets one lease consume several messages, while
consensus ops need exact accounting. Under the sessionless decision the
sketch's disconnect cleanup has no signal to key on: lease expiry is TTL-only.
Eval-middleware precedent: the v1
conformance suite's toxic-profile DSL (transport faults) and scripted app
(verdict / hold / silence — semantic faults).

## Invariants

1. Routing and admission read envelope fields only, never bodies.
2. The plane never mints, alters, or strips L1 attribution.
3. Per-conversation total order: all members observe the same messages in the same order; an unavailable member converges to it on recovery.
4. Durable-then-deliver: no delivery precedes durability in the record substrate.
5. PCC: no contribution is admitted before the group agrees on the next operation and speaker; endpoints observe admission before generating.
6. Starvation protection: no coalition of faulty members can indefinitely deny an honest member its turn.
7. Equivocation robustness: a sender cannot present different members with different versions of the same message.
8. Membership changes are in-band events, ordered against message flow.
9. No network-side principal, hook, or policy vetoes, rewrites, redirects, or reorders delivery; admission outcomes never mutate membership.
10. No data-plane interface names or carries a task.
11. Middleware absence-equivalence: if the eval middleware exists (this doc's open question 9), production semantics are identical with it absent or present-and-idle; every injection stays inside the tolerated failure envelope.
12. The plane keeps no per-endpoint connection or session state.
13. Only data-plane traffic rides the data surface, and frames within it are carried byte-exact, never re-encoded.
14. Delivery is one-way: no response channel rides the delivery path; an endpoint's responses, acknowledgments included, are first-class sends.

## Acceptance criteria

- Every normative statement in the plane's spec chapter is a guarantee or interface; mechanisms appear only in non-normative notes.
- Each of the four paper-required constraints maps to at least one invariant testable over the v0 MULTICAST + PCC slice.
- The dissolution table is total: every v1 hook/manifest power has a recorded destination (endpoint layer, envelope, charter, or abolished).
- Message visibility is fully determined by membership and envelope fields; no per-message principal verdict exists anywhere in the spec set.
- If the eval middleware is adopted (this doc's open question 9), the v1 scripted-fault conformance tier is reproducible through it with no production hook path, and removing the middleware changes no production conformance outcome.
- Both case studies' scheduling flows are expressible as op sequences with no middleware dependency — verified under the L2 charter's acceptance.

## Open questions

1. Visibility scoping: which envelope fields (participants, witnesses, membership epoch) scope delivery and history read-back — L2 charter, jointly with register Q4/Q6 (witness read-back; records retention and history-read scope).
2. The seven charter clusters (op set, completion, failure, concurrency, initiation authority, witnesses, ordering) — deferred to the charter, including whether conversation lifecycle (CONVERSATION-START) rides as a collective type and how it reconciles with the control-plane lifecycle ops.
3. Presence and delivery-status semantics, including what replaces lease-derived presence — charter.
4. Does the plane owe positive delivery acknowledgment, or is recovery-convergence the whole guarantee?
5. Does an admitted turn survive a plane restart, or is it reconstructed from the record substrate?
6. Middleware observation under a content-blind plane: envelope-only, or a key-holding observer (the constitution's monitor question)?
7. Experiment observation surface: record-substrate reads, a middleware event stream, or both — and where that boundary sits.
8. Wire discipline for op envelopes (closed-struct / excess-key rejection) — `v2/VISION.md` register item 9.
9. Does at most one centralized middleware — the fault-injection / capability-evaluation eval seam — exist at all? Needs a recorded maintainer decision (VISION register or #765); the seam is hook-shaped relative to constitution clause 2 (no hooks, no reverse callbacks), so the record must carve the exception explicitly.
10. The wire surface: the ship call shape; the delivery model (endpoint-initiated reads, held-open responses, or another shape); the feed's scope (per-conversation vs endpoint-wide) and its cursor semantics — bounded by the sessionless, plane-split, and single-credential decisions.

## References

- `v2/VISION.md` (constitution: clauses 1–3, 5–7, 12–13; open-question
  register); `docs/architecture/layers.md` (layer model, layering rules).
- `docs/decisions/20260721-physical-plane-split.md`,
  `docs/decisions/20260721-sessionless-network.md` — the wire-surface
  decisions; `docs/decisions/20260722-data-plane-layering.md` — plane
  layering and the interim wire.
- #765 — L2 collective operation semantics charter: op clusters, four
  paper-required constraints, v0 MULTICAST + PCC decision, maintainer
  transcript-plus-leases sketch. #755 — v2 epic.
- `v2/inputs/v1-code-audit-20260717.md` (delivery-path and hook-machinery map);
  `v2/inputs/case-study-audits-20260718.md` (arena/bench evidence for the eval
  seam); `v2/inputs/debt-inventory-20260718.md` (eval-harness rebuild verdict).
