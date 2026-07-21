# Spec set — drafting

Deepening documents for the v2 interface spec. Status: DRAFT — these
feed the numbered chapter set (tracked on epic #755; L2 semantics
charter: #765). Normative language is guarantee-level; mechanisms
appear only in sections marked "Implementation notes (non-normative)".
The living architecture views are in `../architecture/`; the
constitution and open-question register are in `/v2/VISION.md`.

| Doc | Covers |
|---|---|
| `identity.md` | L1 — identities and framing; sessions link to identity |
| `contacts.md` | L3 contacts as endpoint-owned trust data; server contacts dissolve |
| `control-plane.md` | registries, transcript storage, op families; request/response only |
| `data-plane.md` | shipping frames: ordering, collectives, PCC; app layer dissolution; the fault-injection/eval seam |
