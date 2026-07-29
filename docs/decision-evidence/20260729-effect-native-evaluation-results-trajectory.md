# Effect-native evaluation results source-event ledger

This is a curated, non-normative ledger of stored events from Codex
session `019fa613-7f9a-7103-99b0-a42fda0754de`. Timestamps are UTC.
The source format supplies a turn identifier but no separate message
identifier or parent locator, so each event below uses the session,
turn, event kind, and exact timestamp. Tool-mediated answers also cite
their function-call identifier. Excerpts are literal; spelling,
capitalization, and hedges are preserved.

The stored actor role does not independently authenticate a person's
identity. The linked ADR names its accountable decision-maker
separately.

<a id="evaluation-runs-produce-typed-reports-published-to-phoenix"></a>

## Evaluation runs produce typed reports published to Phoenix

[ADR: `20260729-effect-native-evaluation-results.md`](../decisions/20260729-effect-native-evaluation-results.md)

1. **Stored user message.** Locator: Codex session
   `019fa613-7f9a-7103-99b0-a42fda0754de`; turn
   `019faf1e-c5e6-75e0-bb4d-f34439fede45`; message event;
   stored actor role `user`; `2026-07-29T18:24:17.945Z`.

   > what about Everything about disclosure, group behaviour, injection resistance and conversation awareness

2. **Stored user messages.** Locator: the same session; turn
   `019faf25-2a7a-7653-9c20-9a490d4fb829`; message events;
   stored actor role `user`.

   At `2026-07-29T18:31:16.887Z`:

   > we should work the full LLM judge path and then start cleaning up and running these evals

   At `2026-07-29T18:48:36.467Z`:

   > can I update the requierments: can we use some existing evals library to store and manage our bundles instead of doing that manually? I also want to be able to see the results. maybe look at braintrust or promptfoo or whatever else here is free or cheap or self-hostable like our nx cache

   At `2026-07-29T18:53:51.758Z`:

   > maybe also add genkit as a potential alternative? I think openclaw uses that for their own evals but I'm not sure if it's a goodfit

3. **Stored assistant comparison.** Locator: the same session and turn;
   message event; stored actor role `assistant`;
   `2026-07-29T19:00:18.265Z`.

   > The shortlist is now clear:
   >
   > - Phoenix is the closest match to “an eval Nx cache”: a TypeScript client, one self-hosted container, SQLite by default, a proper experiment/results UI, comparisons, traces, and categorical annotations that preserve `passed | failed | undecided`. It is free to self-host, but ELv2/source-available rather than OSI-open.
   > - Braintrust has the cleanest hosted SDK/UI and direct external-result logging, but its free tier retains data only 14 days; self-hosting is enterprise-scale.
   > - Opik is the strongest Apache-2.0 self-hosted choice, but its stack is much heavier.
   > - Promptfoo can ingest precomputed outputs and has a useful local UI, but its native truth model is boolean pass/fail, which would misrepresent `undecided`.
   > - Genkit supports raw external evaluations and local comparisons, but stores local JSON under `.genkit`, requires a running Genkit app, and only compares runs sourced from the same Genkit dataset. That moves us back toward manually managed files plus a second AI runtime.
   > - MLflow is what OpenClaw-adjacent ClawBench actually uses, but its full eval APIs remain Python-first; the TypeScript SDK is mainly tracing.
   >
   > My recommendation is Phoenix for v0.

4. **Stored assistant questions and tool-mediated user answers.**
   Locator: the same session and turn; `request_user_input` call
   `call_8GOvgGo8kYnBNSCNcslZwMlr`; stored question actor role
   `assistant`, `2026-07-29T19:00:28.934Z`; stored answer actor role
   `user`, `2026-07-29T19:03:52.934Z`.

   > Which results platform should v0 standardize on?

   The options were `Phoenix local (Recommended)`, `Braintrust
   hosted`, and `Opik self-hosted`. Stored answer:

   > Phoenix local (Recommended)

   The second question was:

   > How should the full live evaluation command treat the results service?

   The options were `Required for live (Recommended)`, `Optional
   reporter`, and `Explicit publish step`. Stored answer:

   > Explicit publish step

5. **Stored assistant questions and tool-mediated user answers.**
   Locator: the same session and turn; `request_user_input` calls
   `call_zUHRElv25ErkWC4OBCvsAh8e` and
   `call_gfe6Jywy6icbBveIYPUMNubi`; stored question actor role
   `assistant`; stored answer actor role `user`.

   At `2026-07-29T19:09:06.731Z`, the question was:

   > To avoid rebuilding a local result database between grading and Phoenix, where should durable judge testimony first be written?

   At `2026-07-29T19:10:24.665Z`, the stored answer was:

   > None of the above
   >
   > user_note: revert previous decision to merge publish with grading

   The same answer selected `External service only` for:

   > How much of the local Phoenix lifecycle should this package own?

   At `2026-07-29T19:11:18.122Z`, the follow-up question was:

   > How should the separately modeled grade and publish stages hand off the report?

   At `2026-07-29T19:12:34.394Z`, the stored answer was:

   > Generated report artifact

6. **Stored assistant questions and tool-mediated user answers.**
   Locator: the same session and turn; `request_user_input` call
   `call_ywiK9ZuBGnw3rrlXtr0mFrtm`; stored question actor role
   `assistant`, `2026-07-29T19:24:06.724Z`; stored answer actor role
   `user`, `2026-07-29T19:25:59.185Z`.

   > How should we resolve the current prompt/grader contradictions?

   Stored answer:

   > Match executable prompts (Recommended)

   The second question was:

   > Should the generated report artifact be checkpointed during the 32-attempt live sweep?

   Stored answer:

   > After every attempt (Recommended)

7. **Stored assistant question and tool-mediated user answer.**
   Locator: the same session and turn; `request_user_input` call
   `call_XrHTg2iUPzyLx4ffjoUQdgy4`; stored question actor role
   `assistant`, `2026-07-29T19:27:36.199Z`; stored answer actor role
   `user`, `2026-07-29T19:28:05.770Z`.

   > What model provenance should the full OpenClaw/NanoClaw baseline require?

   Stored answer:

   > None of the above
   >
   > user_note: runtime configs must be explicit? each runtime has it's own way of configuring models? we should capture those rather than normalize them

8. **Stored assistant questions and tool-mediated user answers.**
   Locator: the same session and turn; `request_user_input` call
   `call_078UVUHQLG6u6Cap0Zz11IZN`; stored question actor role
   `assistant`, `2026-07-29T19:33:03.016Z`; stored answer actor role
   `user`, `2026-07-29T19:52:42.493Z`.

   The three questions asked where native sanitized runtime
   configuration belongs, how an interrupted report resumes, and what
   evaluation evidence remains committed. Stored answers:

   > Runtime contract (Recommended)
   >
   > Resume pending (Recommended)
   >
   > None of the above
   >
   > user_note: I don't thikn results belong here

9. **Stored user messages about live-result semantics.** Locator: the
   same session; turn `019faebc-99c9-77b0-b3af-f738c08d45c1`;
   message events; stored actor role `user`.

   At `2026-07-29T16:37:03.739Z`:

   > okay, finish this; if you find bugs, oen them on github.

   At `2026-07-29T16:44:02.345Z`:

   > if nanoclaw fails it fails; you don't have to force evals to pass; we just have to document whats happening

10. **Stored assistant plan.** Locator: the same session; turn
    `019faf25-2a7a-7653-9c20-9a490d4fb829`; message event; stored
    actor role `assistant`; `2026-07-29T20:08:17.572Z`.

    > # Effect-native evaluation pipeline with Phoenix results
    >
    > - First, add an accepted ADR recording this plan before changing code. It will select Phoenix, document Genkit and the other evaluated alternatives, and define the typed judging, report, provenance, and publication boundaries.
    > - Keep scenarios, criteria, sweeps, and runtime conditions as TypeScript/Effect values. The simulator ledger remains canonical raw evidence; a validated local report is the resumable grading handoff; Phoenix manages datasets, experiments, comparisons, and visible results.
    > - Run the complete 16-case suite once against OpenClaw and once against NanoClaw: 32 sequential attempts, 52 subject-agent turns, and at most 28 semantic judge calls.
    > - Make breaking API cleanups directly. Do not retain the compatibility suite, captured run Effects, or Vitest-based live runners.
    >
    > [omitted: the detailed Simulator core, Evaluation domain, Grading and judge, Execution and storage, Phoenix publication and alternatives, Test and live acceptance, and Assumptions sections]

11. **Stored user messages approving execution.** Locator: the same
    session; turn `019faf82-bbd0-7240-a7c6-dd62a0bb1a5c`; message
    events; stored actor role `user`.

    At `2026-07-29T20:13:28.642Z`:

    > Implement the plan.

    At `2026-07-29T20:13:50.017Z`:

    > this plan is your goal now

Repository effect at compaction: the linked ADR was added before
implementation changes, this source-event ledger and the
human-maintained decision-log index entry were added, and tracked
result evidence was removed. Simulator and evaluation implementation
was in progress. These are mechanical repository events, not
quotations.

Source gaps, stated plainly:

- The source events record the user's questions, option selections,
  corrections, and approval of the complete assistant-authored plan.
  They do not state independent human rationale for the detailed
  schemas, retry counts, timeout, model configuration, module
  placement, or Phoenix field mapping proposed in that plan.
- The comparison claims in event 3 and the detailed implementation
  choices in event 10 are assistant-authored research and engineering
  proposals. The later user messages approve the plan; they do not
  separately attribute authorship of each rationale.
- Irrelevant tool outputs, private system and developer instructions,
  hidden reasoning, environment diagnostics, and the plan's
  implementation-detail body are omitted. No credential values are
  retained.
