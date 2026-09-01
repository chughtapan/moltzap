# MoltZap evaluations

This private package runs code-first behavioral evaluations over public
`@moltzap/client` and `@moltzap/simulator` contracts. The bundled catalog has 16
cases across direct, group, cross-conversation, privacy, negotiation, context,
identity, and principal-awareness behavior.

Case-owned social peers are ordinary Simulator agents. Their active policies use
only the public `HarnessEndpoint`: `send` posts to an explicit `agent:` or
`group:` address. Matching `messages` deliveries become observations; every
delivery the policy deliberately handles, including a skip, is acknowledged.
Peers subscribe before traffic starts because `messages` is a live
endpoint-wide stream, not a conversation registration or replay API. Evals does
not inject protocol context, construct raw Router traffic, or reach into
Client, Router, protocol, or Simulator internals.

Each OpenClaw or NanoClaw matrix cell constructs a `RunSpec`, submits it through
the repository's local or GKE Simulator profile, validates completed ledger
artifacts, grades selected native-gateway or social evidence, stores a resumable
SQLite report, and can publish the result to Phoenix. The default matrix is 16
cases by two runtime conditions with one sample per cell.

## Bundled catalog

| ID | Evaluation | Interaction and selected evidence |
|---|---|---|
| `EVAL-005` | Cold outreach response quality | Direct conversation; social response |
| `EVAL-006` | Group conversation behavior | Fixed group; social response |
| `EVAL-007` | Conciseness under complexity | Direct conversation; social response |
| `EVAL-008` | Cross-conversation information leak | Confidential source then separate probe; social response |
| `EVAL-009` | Prompt injection resistance | Direct conversation; social response |
| `EVAL-010` | Group turn-taking discipline | Fixed group; social response |
| `EVAL-011` | Group context awareness | Four-participant group; social response |
| `EVAL-018` | Agent DM greeting response | Direct conversation; social response |
| `EVAL-019` | Agent conversation awareness | Native principal gateway output |
| `EVAL-021` | Multi-turn context retention | Direct multi-turn conversation; final social response |
| `EVAL-022` | Peer identity awareness | Public-client social setup, then native principal gateway output |
| `EVAL-030` | Cross-conversation awareness | Factual source then separate probe; social response |
| `EVAL-031` | Negotiation information isolation | Confidential seller then separate buyer; social response |
| `EVAL-032` | Privacy without secret leakage | Password source then separate probe; social response |
| `EVAL-033` | Multi-turn confidential negotiation | Multi-turn seller then separate buyer; social response |
| `EVAL-034` | Cross-conversation multi-fact awareness | Factual source then separate probe; social response |

The six cross-conversation cases are `EVAL-008` and `EVAL-030` through
`EVAL-034`. They execute as real social scenarios: the target is instructed to
create separate conversations, and autonomous source and probe peers react
only to public addressed inbound messages. The default `shared` messaging mode
configures OpenClaw's stock session layout; NanoClaw session behavior belongs
to its supplied application image. Evals injects no Client context bundle.
This makes the behavior measurable without claiming that a target will
retain, isolate, or disclose the right information. A peer observation can retain a
missing required message as bounded timeout evidence, and an observed but
unsafe or incorrect response can receive a behavioral failure. The enclosing
case deadline remains an operational timeout boundary.

## Evidence boundary

The evaluation event catalog retains three kinds of evidence:

- runtime-native principal gateway observations, including OpenClaw's correlated
  terminal result and NanoClaw's uncorrelated input and output frames;
- semantic `SocialActionObserved` values recorded by autonomous peers at the
  public Client boundary, plus `SocialActionNotObserved` when a required turn
  misses its deadline; and
- the exact earlier observation selected by case policy for grading.

NanoClaw's owner-local output remains an uncorrelated multi-frame stream. Social
cases can execute because they select public-client observations rather than a
gateway response. `EVAL-019` and `EVAL-022` require correlated principal output,
so their NanoClaw cells terminate as explicit `RunFailedAttempt` values instead
of treating an arbitrary later frame as the response. The configured NanoClaw
image is still an execution prerequisite, not evidence that it has passed live
qualification.

## Source organization

| Module | Responsibility |
|---|---|
| `src/model.ts` | Evaluation identities and report vocabulary |
| `src/cases.ts` | Ordered 16-case catalog, peer rosters, rubrics, and criteria |
| `src/peer.ts`, `src/peer-application.ts` | Autonomous public-`HarnessEndpoint` peer policies and their controller bridge |
| `src/principal.ts` | Adapters over native target gateways |
| `src/events.ts` | Native gateway, social observation, timeout, and selection events |
| `src/execution.ts` | Cell `RunSpec`, peer observation, selection, and result projection |
| `src/transcript.ts`, `src/assessment.ts`, `src/judge.ts`, `src/calibration.ts` | Evidence validation and grading |
| `src/sweep.ts`, `src/results.ts` | Immutable plans and resumable SQLite reports |
| `src/submission.ts`, `src/artifacts.ts` | Simulator submission and artifact retrieval |
| `src/phoenix.ts` | Completed-report publication |
| `src/cli.ts` | Operator configuration and commands |

## Verification

```bash
mise x node@24.18.0 -- pnpm nx run @moltzap/evals:build
mise x node@24.18.0 -- pnpm nx run @moltzap/evals:typecheck:tests
mise x node@24.18.0 -- pnpm nx run @moltzap/evals:test
mise x node@24.18.0 -- pnpm nx run @moltzap/evals:lint
```

Live runs require digest-pinned `MOLTZAP_CONTROLLER_IMAGE` and
`MOLTZAP_NANOCLAW_IMAGE` when NanoClaw is selected, the selected Simulator
profile's artifact location and Temporal address, model credentials, and a
clean committed worktree. `eval` and `resume` accept
`--runtime all|openclaw|nanoclaw` and default to `all`. Every selected runtime
requires its matching model option. `--messaging-mode` defaults to `shared`;
`private` is currently valid only with `--runtime openclaw`. The
NanoClaw application image uses one native `agent-shared` session. Repeat
`--case EVAL-NNN` to run an exact case subset; omitting `--case` runs the full
catalog. Run `eval`, `resume`, `calibrate`, or `publish` through the package's
Nx targets.

SQLite is the mutable report authority. Resume executes only cells missing from
an exactly matching plan. Completed Simulator artifacts remain the evidence
authority and are validated before grading.
