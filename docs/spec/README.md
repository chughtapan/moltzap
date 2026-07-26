# Spec set — drafting

Deepening documents for the v2 interface spec. Status: DRAFT — these
feed the numbered chapter set (tracked on epic #755; collective-semantics
charter: #765). Normative language is guarantee-level; mechanisms
appear only in sections marked "Implementation notes (non-normative)".
Layout mirrors the component decomposition
(`../architecture/components.md`): endpoint-scoped docs live under
`endpoints/`; cross-cutting layer docs sit at the root.

**Reading guide — three depths for three readers.**

1. **Orientation** (anyone): `../architecture/layers.md` — the
   end-to-end flows and the per-layer provides/configures table; then
   `../architecture/components.md` for the component view. The
   constitution and open-question register are `../../v2/VISION.md`.
2. **Design detail** (contributors to the design): the per-layer docs
   in the table below, plus the decision log
   (`../decisions/README.md`) — the authority for what is decided;
   open questions live in each doc's own register and
   `../../v2/VISION.md`.
3. **Building** (implementers): `layer-interfaces.md` — the nouns,
   five ports, and laws — plus
   `../architecture/first-implementation.md`, the hypothesis for
   round one.

| Doc | Covers |
|---|---|
| `identity.md` | L1 — identities, attribution, and the message wire shape |
| `data-plane.md` | the L2/L3 realization: ordered multicast delivery of messages, actions realized by protocols; the collective transaction; the fault-injection/eval seam; interim WS wire, target surface open |
| `endpoints/channels.md` | the endpoint data-plane stack: message construction and signing, sending under PCC, one-way receive, resume position, gate mount |
| `endpoints/tasks.md` | L4 — tasks as application protocols; norms as versioned skill bundles, published upward as guarantees |
| `endpoints/screening.md` | L5 personal trust: the firewall hooks and their recorded phasing; agent-local verdicts |
| `endpoints/contacts.md` | L5 contacts as endpoint-owned trust data — the v0 stopgap behind the hooks |
| `enforcement.md` | L6/L7 — social oversight and institutional trust: monitors as deterministic contracts, policy attached to identity |
| `layer-interfaces.md` | the standardized noun vocabulary, the five ports, layers as law sets, and the Effect realization |
| `control-plane.md` | registries and the ledger (transcript store), op families; request/response over HTTP, sessionless; encoding-neutral ops — JSON-RPC interim, REST + OpenAPI target |
| `cli.md` | operator surface: a plain signing HTTP client fronting the control-plane op families |
