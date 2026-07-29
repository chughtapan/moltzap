# Phase 2A wire-profile source-event ledger

This is a curated, non-normative ledger of stored events from the
GitHub repository `chughtapan/moltzap`. Timestamps are UTC. A GitHub
issue or issue comment has a native numeric or comment identifier and
a stored author account; those are the locators used below. Excerpts
are literal; spelling, capitalization, backticks, and hedges are
preserved.

The stored author account does not independently authenticate a
person's identity, and several retained events are agent-authored
comments posted under a maintainer's account. Where such a comment
quotes a directive from a session that is not checked in, that is
recorded as an agent event containing a quotation, never as a stored
user event. The linked ADR names its accountable decision-maker
separately.

The origin of the Phase 2A requirement itself is not in this ledger.
It is in
[`20260728-gate-1-engineering-review-trajectory.md`](../decision-evidence/20260728-gate-1-engineering-review-trajectory.md#20260728-network-wire-is-http-post-polling),
which retains the stored user events selecting closed schemas and the
HTTP POST polling carrier.

<a id="20260729-wire-profile-assigns-every-gate-1-byte"></a>

## The wire profile assigns every Gate 1 byte

[ADR: `20260729-wire-profile-assigns-every-gate-1-byte.md`](../decisions/20260729-wire-profile-assigns-every-gate-1-byte.md)

1. **Stored issue body.** Locator: repository `chughtapan/moltzap`;
   issue `#888`; author account `chughtapan`;
   `2026-07-29T04:39:56Z`.

   > | Phase 2A byte catalog | `docs/spec/wire-profile.md` plus accepted ADR and passing vectors. *"No product, protocol, simulator-port, client, or server implementation starts before this change lands and its vectors pass"* | `docs/spec/wire-profile.md` does not exist |

2. **Stored issue body, decomposition table.** Locator: the same
   issue and event.

   > | 5 | architect | 4 | Phase 2A: author `docs/spec/wire-profile.md` — the complete byte catalog — plus its accepted ADR. This is the long pole and the plan's explicit implementation block |

   and

   > Rows 5 and 6 are where the real cost sits. Row 5 is architecture work at roughly 5x compression, not a feature row.

3. **Stored issue comment quoting a user directive.** Locator:
   repository `chughtapan/moltzap`; issue `#888`; comment
   `5113370780`; author account `chughtapan`;
   `2026-07-29T04:48:40Z`. The comment is agent-authored orchestration
   prose posted under the maintainer account; the quoted directive is
   attributed to a session that is not checked in.

   > ## Phases 2 and 2A dispatched — plan gate overridden by user directive
   >
   > User: `no; finish impl`. The concern that the approved plan gates Phase 2 / 2A / implementation behind Phase 1's exit artifact was raised once and overridden. Proceeding on the user's sequencing.

   and, from the same comment's dispatch table:

   > | [#892](https://github.com/chughtapan/moltzap/issues/892) | architect | `architect-892` | `docs/spec/wire-profile.md` byte catalog plus its accepted ADR |

4. **Stored issue body.** Locator: repository `chughtapan/moltzap`;
   issue `#892`; author account `chughtapan`;
   `2026-07-29T04:47:17Z`.

   > Create `docs/spec/wire-profile.md` plus one focused accepted ADR under `docs/decisions/` following the record rules in `AGENTS.md` (MADR-minimal frontmatter, `date` matching the filename, a visible `Decision provenance` link to `docs/decision-evidence/`).
   >
   > The catalog assigns every value, **without implementation-local defaults**:

   The same body then lists eleven categories. Retained verbatim,
   `[omitted: the surrounding prose of the issue]`:

   > - complete AgentName grammar and every textual identifier prefix;
   > - X.509 subject/SAN mapping, MoltZap extension OIDs and criticality, routing encoding, issuer/attestation chain, validity fields, DER constraints;
   > - numeric keys for every closed CBOR map, exact tagged success/error maps, and schemas for START, BEGIN, ACK, action-proposal, final-signature, commit-notice, and reconciliation messages;
   > - per L3 protocol-message kind: its L1 sender, explicit recipient AgentId set, canonical ordering, and whether self-delivery is represented by including the sender;
   > - COSE algorithms, protected and unprotected label sets, `crit` behavior, external AAD, and literal domain-separation contexts for L1 and L3;
   > - every identifier/hash derivation preimage, length, ordering rule, and literal domain constant, including START IDs and reply retry identity;
   > - the canonical operation-equality preimage for every idempotent route, explicitly excluding fresh per-attempt RFC 9421 authentication metadata;
   > - PollCursor bytes, versioning, authentication/integrity, and rejection rules;
   > - exact HTTP content types, success/error status mapping, RFC 9421 signature labels and serialization, Router `initial`/`retry` send discriminants, current-instance fields, route result tags;
   > - exact MCP JSON Schemas for discovery, both tools, tool results, extension capability, subscription filter/acknowledgment, turn-ready, and graceful close.

5. **Stored issue body, constraint on the architect.** Locator: the
   same issue and event.

   > *"Treat 'fixed' wire fields in the semantic specs as constraints on this catalog, never permission for an implementer to assign values."*
   >
   > [omitted: the list of chapters to read]
   >
   > You are not revising the frozen design. You are completing the one boundary it deliberately left open.

6. **Stored issue body, scope of the corpus.** Locator: the same
   issue and event.

   > This is an architect artifact: the catalog document and its ADR. The vector corpus (two independent encoders requiring byte equality, one negative vector per rejection class, both decoders verified, CI rejecting an empty corpus) is a separate implement-staff sub-issue that depends on this one. Do not write the vectors here; do specify exactly what they must cover, so the implementer has no latitude.

Repository effect: `docs/spec/wire-profile.md` was created, the linked
ADR was added, `docs/spec/README.md` and `docs/decisions/README.md`
gained the corresponding entries, and the Gate 1 freeze traceability
inventory gained one row. These are mechanical repository events, not
quotations.

Source gaps, stated plainly:

- No retained source event assigns any individual byte-level value.
  Every constant in `docs/spec/wire-profile.md` — the OID arc, the
  identifier prefixes, the AgentName length bounds, the CBOR map key
  numbers, the union discriminants, the domain constants, the HTTP
  status mapping, the RFC 9421 label and parameter order, the JSON
  Schema shapes, and the vector fixture material — was proposed by the
  architect agent in the session that authored the candidate. The
  maintainer named in `decision-makers` admits them by accepting the
  ADR. The event ledger records no independent human selection of any
  of those values.
- The session that produced the directive quoted in event 3 is not
  checked in. Searches covered the `chughtapan/moltzap` issue and pull
  request threads for issues `#877`, `#888`, `#889`, `#890`, `#891`,
  and `#892`. The agent-authored comment is the only retained artifact
  of that exchange, and it is retained as an agent event containing a
  quotation rather than as a stored user message.
- No retained event states a reason, alternative, reversal, deferral,
  urgency, or revisit trigger for any specific value assignment. The
  `Rationale` paragraphs in the catalog and the alternatives named in
  the ADR are agent-authored engineering argument in the candidate,
  not a compaction of a stored human statement.
- Event 3's comment itself records that the approved plan's Phase 1
  gate was raised as a concern and overridden. That is what the
  comment states. No retained event records why.
