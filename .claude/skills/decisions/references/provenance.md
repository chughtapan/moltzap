# Compacting a decision trajectory

A trajectory is the source-event ledger an ADR cites. These rules are the
part no script can check: `check-shape.ts` verifies that a provenance link
resolves, never that an excerpt is faithful or that a motive was not
invented. Read them before writing or editing one.


- A compacted trajectory is a source-faithful event ledger, never
  normative authority or a reconstructed explanation. One trajectory
  may support several ADRs; link the relevant stable heading rather
  than duplicating it.
- Every retained event identifies the source system, source session,
  native message or event locator, enclosing turn and parent locator
  when the source provides them, UTC timestamp, stored actor role, and
  a literal excerpt. If a source has no message ID, cite the session,
  turn, event kind, and exact timestamp instead of inventing one.
  Preserve spelling, punctuation, hedges, questions, and option labels.
  Mark every omission or normalization; never silently strengthen or
  repair the source.
- Include the public agent question or options when needed to interpret
  a terse human reply. A reply such as `A`, `B`, `1`, `sure`, or
  `okay` has no meaning beyond the directly preceding retained prompt.
  Record agent proposals as agent events and repository changes as
  separate mechanical events.
- Do not infer motives, rationale, confidence, urgency, causality, or
  mental state. Record uncertainty, time pressure, reasons,
  alternatives, reversals, deferrals, and revisit triggers only when a
  cited source event states them. Absence is a source gap, not an
  invitation to explain the human.
- `decision-makers` names the humans accountable for the call. The
  field does not prove that the session account authored every rationale
  in the ADR. The named decision-maker reviews the event linkage when
  admitting the ADR. Agents remain recommenders, questioners, or
  scribes unless a human explicitly delegates decision authority.
- Compact the material public exchange, not a raw transcript export or
  hidden model reasoning. Do not commit secrets, personal data, private
  research, system prompts, irrelevant third-party text, or
  authentication-bound session URLs as the sole evidence. State
  omissions and redactions.
- If an original session cannot be located, record a source-gap report.
  Git commits and ADR prose may establish repository history, but they
  do not reconstruct a missing conversation or human rationale.
  Preserve later source discoveries as dated corrections.
- Treat an ADR as a revisable human choice rather than self-justifying
  prose. A recorded provisional call or source gap is a reason to ask
  the named human to reconsider; it is not permission for an agent to
  ignore a current outcome.
