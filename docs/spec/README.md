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
   `../architecture/components.md` for the process view. The
   constitution and open-question register are `/v2/VISION.md`.
2. **Design detail** (contributors to the design): the per-layer docs
   in the table below, plus the decision log
   (`../decisions/README.md`) — the authority for what is bound vs
   hypothesis vs open.
3. **Building** (implementers): `layer-interfaces.md` — the nouns,
   five ports, and laws — plus
   `../architecture/first-implementation.md`, the hypothesis for
   round one.

| Doc | Covers |
|---|---|
| `layer-interfaces.md` | the standardized payload vocabulary, the five ports, layers as law sets, and the Effect realization |
| `identity.md` | L1 — identities, framing, and the frame wire shape |
| `endpoints/contacts.md` | L5 contacts as endpoint-owned trust data; server contacts dissolve |
| `control-plane.md` | registries, transcript storage, op families; request/response over HTTP, sessionless; encoding-neutral ops — JSON-RPC interim, REST + OpenAPI target |
| `data-plane.md` | the L2/L3 realization: ordered multicast delivery under transactional messaging; app layer dissolution; the fault-injection/eval seam; interim WS wire, target surface open |
| `endpoints/screening.md` | L5 personal trust: the firewall mechanism, keyed off any communication layer; agent-local verdicts |
| `endpoints/tasks.md` | L4 — tasks as application protocols; norms as versioned skill bundles, published upward as guarantees |
| `endpoints/channels.md` | the endpoint data-plane stack: framing and signing, sending under PCC, one-way receive, resume position, gate mount |
| `enforcement.md` | L6/L7 — social oversight and institutional trust: monitors, registries, credential consequences |
| `cli.md` | operator surface: a plain signing HTTP client fronting the control-plane op families |
