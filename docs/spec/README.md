# Spec set — drafting

Deepening documents for the v2 interface spec. Status: DRAFT — these
feed the numbered chapter set (tracked on epic #755; L2 semantics
charter: #765). Normative language is guarantee-level; mechanisms
appear only in sections marked "Implementation notes (non-normative)".
Layout mirrors the component decomposition
(`../architecture/components.md`): endpoint-scoped docs live under
`endpoints/`; cross-cutting layer docs sit at the root.
The living architecture views are in `../architecture/` — the layer
model (L1–L6, L2.5) is `../architecture/layers.md`; the constitution
and open-question register are in `/v2/VISION.md`.

| Doc | Covers |
|---|---|
| `identity.md` | L1 — identities, framing, and the frame wire shape |
| `endpoints/contacts.md` | L3 contacts as endpoint-owned trust data; server contacts dissolve |
| `control-plane.md` | registries, transcript storage, op families; request/response over HTTP, sessionless; encoding-neutral ops — JSON-RPC interim, REST + OpenAPI target |
| `data-plane.md` | delivery layer (atomic multicast) under a messaging layer (collectives as transcript transactions), PCC; app layer dissolution; the fault-injection/eval seam; interim WS wire, target surface open |
| `endpoints/screening.md` | L3 gate model: firewalls at the delivery layer, programmed from above; agent-local verdicts |
| `endpoints/tasks.md` | L4 — tasks as endpoint conventions; norms as versioned skill bundles; L4 configures L3 |
| `endpoints/channels.md` | the endpoint data-plane stack: framing and signing, shipping under PCC, one-way receive, recovery cursor, gate mount |
| `enforcement.md` | L5 — evidence from records plus identities; monitors, registries, credential consequences |
| `cli.md` | operator surface: a plain signing HTTP client fronting the control-plane op families |
