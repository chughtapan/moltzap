# Effect Cleanup Follow-up Spec

## Intent

Clean up the leftover Effect migration debt by upstreaming the shared pieces inside MoltZap itself, cleaning up eval/runtime infrastructure that still lives in temporary or compatibility-shaped code paths, and carrying the same cleanup through `moltzap-arena`: pin the Effect version so downstream packages stop carrying compatibility glue, move config and logging into reusable upstream surfaces, make nanoclaw/evals runtime infrastructure live in the right Effect-native place, make `cc-judge` the clear default and primary evaluation path for supported runtimes, move both MoltZap and arena eval scenarios onto declarative YAML/data over the shared planned-harness path, and make fiber-aware tracing/logging a P0 part of the runtime rather than a one-off experiment.

## Goals

1. Remove remaining Effect-version skew across the MoltZap workspace so shared runtime code can rely on one exact pinned Effect surface without compatibility branches.
2. Upstream shared config, logging, and fiber-tracing responsibilities into MoltZap packages that downstream code throughout the workspace and in `moltzap-arena` can consume directly instead of re-implementing local glue.
3. Finish the Effect-native migration for runtime config and logging so boot paths, long-lived services, request/session flows, and CLI runtime/command surfaces use Effect config/context/layers rather than mixed imperative fallbacks.
4. Remove `console.*` from package runtime code across the targeted workspace packages and the relevant `moltzap-arena` integration/runtime surfaces, routing logging through the shared upstream MoltZap logging surface instead.
5. Remove remaining non-standard logging stacks from the cleanup scope, especially `winston` in `@moltzap/evals`, so the repo converges on the shared MoltZap Pino-plus-Effect logging shape.
6. Clean up eval/runtime infrastructure that is still shaped like a spike or Promise wrapper, especially the nanoclaw path tracked in `moltzap#83`, so the runtime lives behind the correct Effect-native abstraction and the current `nanoclaw-smoke` load-bearing path is removed.
7. Make `cc-judge` shared-contract bundle emission the primary and default evaluation model for the supported eval runtimes, and clean up the remaining native judge/report surfaces so they no longer present themselves as the main path.
8. Collapse generic eval substrate ownership into `cc-judge` wherever the code is not MoltZap- or arena-specific, so `@moltzap/evals` and `@moltzap/arena-evals` shrink to domain-specific runtime/scenario/replay adapters instead of carrying their own bundle schema, codec, scorer bridge, or report stack.
9. Treat fiber-aware tracing/logging as P0 by ensuring core runtime flows emit structured logs with request, session, agent, and fiber context where applicable, and by carrying the proven `Supervisor + Logger` tracing pattern from `moltzap-arena#106` into the downstream arena integration.
10. Collapse the current arena eval entrypoints into one Effect-native core game harness so smoke, scenario, full-game, and bootstrap flows share the same runtime bring-up, artifact retention, workspace seeding, and tracing/logging backbone instead of maintaining parallel harnesses.
11. Move declarative MoltZap eval scenarios out of hard-coded TypeScript catalogs and into YAML/data files, replacing TS-only deterministic callbacks with declarative matcher or assertion forms that can flow through the shared planned-harness path.
12. Move declarative arena scenarios out of hard-coded TypeScript catalogs and into YAML/data files compiled into the same shared planned-harness family, unless a scenario truly requires code-only behavior that cannot be represented declaratively.
13. Preserve the existing simple `cc-judge` prompt/workspace scenario schema for simple prompt/workspace cases, and add a distinct file-backed planned-harness YAML path instead of overloading one generic schema with arena-specific game-driving fields.
14. Upstream generic scenario/workspace-seeding capabilities to `cc-judge` where needed instead of preserving bespoke local helpers for features that are not arena-specific, but do not make wave-one progress depend on teaching the generic `cc-judge` prompt/workspace scenario schema about werewolf-specific fields.
15. Stage arena replay/debugger graduation behind the core harness/logging/eval-surface cleanup and the required `cc-judge` replay unblockers, rather than making it a prerequisite for the first implementation wave.
16. Sequence the work as small, reviewable slices that let version alignment land before broader runtime cleanup removes shims, but hold full MoltZap plus `moltzap-arena` cleanup as the completion bar rather than an optional follow-up.
17. Keep the declarative eval and harness cleanup DRY: generic YAML decoding, planned-harness schema, bundle emission, workspace seeding, and scoring/report ownership should exist in one place, with MoltZap and arena only supplying domain-specific harness config or adapters.

## Non-goals

1. Rewriting MoltZap protocol contracts or repeating the larger transport/runtime migration that already landed.
2. Introducing a new third-party observability stack or vendor integration as part of this cleanup.
3. Test-pyramid work, CI-speed work, TestClock follow-ups, or other test-infrastructure debt that is not required to land the runtime cleanup safely.
4. Functional gameplay bugs, rules/spec conformance bugs, or broader product-behavior debt in `moltzap-arena`.
5. Expanding the generic `cc-judge` prompt/workspace scenario schema with werewolf-specific game-driving fields as a prerequisite for this cleanup wave.
6. Making arena replay/debugger graduation a blocker for landing the core harness/logging/eval-surface cleanup slices.
7. Replacing or breaking the existing simple `cc-judge` prompt/workspace YAML path for consumers whose scenarios already fit that model.

## Invariants

1. Shared runtime concerns belong upstream in MoltZap packages, not duplicated in downstream consumers.
2. Config loading and logger initialization must stay typed and fail fast at process boundaries rather than silently defaulting deep inside the runtime.
3. Fiber-aware tracing/logging must compose through Effect context/layers and must not depend on hidden ambient mutable state outside the Effect runtime.
4. Runtime logging should converge on the existing upstream MoltZap Pino-plus-Effect logger shape rather than ad hoc `console.*` calls or package-local logger styles.
5. Cleanup work must reduce compatibility code, not replace one shim layer with another differently-shaped shim layer.
6. Full-workspace adoption is the default: packages do not get excluded just because the cleanup is inconvenient, and downstream `moltzap-arena` adoption is part of done rather than a later integration task.
7. Eval/runtime infrastructure should live in stable runtime modules, not in spike-named harness files that production or eval flows depend on.
8. The eval surface should describe one clear default model: supported runtime modes emit `cc-judge`-consumable bundles through the primary path, and any retained legacy judging code must be explicitly demoted.
9. Existing operator-facing logging should remain recognizable enough that rollout does not destroy current debugging workflows.
10. Generic eval substrate belongs in `cc-judge`; repo-local eval packages should own only domain-specific scenario execution, runtime adaptation, artifact retention, and replay/event modeling that `cc-judge` cannot define generically.
11. Cross-repo consumers must use supported `cc-judge` package surfaces, not hard-coded build paths, local `dist/` imports, or clone-specific filesystem assumptions.
12. If `moltzap-arena` consumes `cc-judge` replay/debugger surfaces, those surfaces must be real, exported, and implemented rather than stub-only references.
13. `moltzap-arena` should have one core harness for agent-driven game execution; multiple CLI entrypoints may remain, but they should be thin mode selectors over the same core harness rather than separate implementations.
14. Arena scenario definitions should be data first. TypeScript scenario code is allowed only for irreducibly procedural cases that cannot be represented through the supported declarative scenario/workspace format.
15. Static workspace seeding such as skill files, identities, and similar agent fixture material should use shared scenario/workspace mechanisms rather than bespoke package-local helpers wherever those mechanisms can express the need.
16. For this cleanup wave, arena declarative data should feed the shared planned-harness/bundle substrate without requiring the generic `cc-judge run` scenario schema to absorb game-specific fields first.
17. Arena replay/debugger work may remain under the same umbrella epic, but it must be sequenced after the core harness/logging collapse and may not block the first implementation wave.
18. The existing simple `cc-judge` prompt/workspace scenario schema should remain valid for prompt/workspace consumers; the new planned-harness YAML surface is additive and must not be a disguised replacement.
19. Declarative scenario convergence should happen at the `RunPlan + HarnessSpec` boundary, with harness-specific config carried as a discriminated payload rather than flattened into one universal schema that mixes prompt-workspace and arena-game fields.
20. Generic eval infrastructure should have one owner. Temporary bridges are allowed only as migration scaffolding and must compile into the upstream `cc-judge` substrate rather than becoming second permanent loaders, schemas, or bundle codecs inside MoltZap or arena.

## Acceptance criteria

- [ ] The workspace uses one exact pinned `effect` version across the MoltZap packages in scope for this cleanup, and the current skew is removed rather than tolerated with compatibility code.
- [ ] Remaining runtime compatibility glue that exists only to tolerate Effect-version skew or duplicate upstream runtime helpers is removed across the targeted workspace packages.
- [ ] Shared upstream MoltZap surfaces exist for config, logging, and fiber-tracing concerns that downstream packages across the workspace and `moltzap-arena` can consume without re-implementing the same setup.
- [ ] Server boot paths and long-lived runtime entrypoints use Effect-native config loading/layer composition instead of mixed imperative config loaders and direct env fallbacks.
- [ ] CLI runtime and command execution stay Effect-native end to end, with command output/logging paths aligned to the shared MoltZap logging/config surface rather than ad hoc `console.*` and direct env reads.
- [ ] Core logging paths use a shared Effect-backed logger surface that supports structured annotations and fiber/request/session context propagation.
- [ ] `@moltzap/evals` no longer depends on `winston`, and its runtime logging is migrated onto the shared MoltZap logging surface.
- [ ] The nanoclaw eval/runtime path tracked in `moltzap#83` is cleaned up into the correct Effect-native runtime abstraction, rather than remaining a load-bearing smoke harness wrapped by Promise bridges.
- [ ] `packages/evals/src/e2e-infra/nanoclaw-smoke.ts` is deleted or reduced to a non-load-bearing artifact; the real eval/runtime path no longer depends on a spike-named smoke file.
- [ ] The primary eval runner and CLI no longer default `openclaw` to shared-contract while leaving `nanoclaw` on a legacy scoring path; supported runtimes use `cc-judge` shared-contract output as the default and primary evaluation model.
- [ ] Native local judge/report code in `packages/evals/src/e2e-infra/llm-judge.ts` and `report.ts`, plus related CLI/docs/package-export surfaces, are either demoted behind an explicit legacy boundary or removed if no supported flow still needs them.
- [ ] Public docs and package exports no longer present `@moltzap/evals` as an “LLM judge” product first; they reflect the `cc-judge`-first model and the intended runtime abstraction surface.
- [ ] `@moltzap/evals` no longer defines and owns a parallel judgment-bundle schema/codec surface where `cc-judge` already owns the generic contract; bundle construction and serialization consume the upstream `cc-judge` surface directly.
- [ ] `@moltzap/arena-evals` no longer scores runs by dynamic-importing `cc-judge` build artifacts from clone-specific filesystem paths; it consumes supported package surfaces instead.
- [ ] Any remaining code in `@moltzap/evals` and `@moltzap/arena-evals` is demonstrably domain-specific: MoltZap runtime/scenario execution, arena gameplay/scenario harnesses, arena-specific replay/event adapters, or durable run-retention semantics.
- [ ] The prerequisite order is explicit and starts with the `cc-judge` package export and `effect`-alignment unblockers required by this cleanup's shared surfaces.
- [ ] `cc-judge` is pinned to the exact `effect` surface required by the shared typed eval/logging contracts before MoltZap and arena consume those contracts cross-repo; no compatibility shim remains solely to tolerate `cc-judge` version skew.
- [ ] `cc-judge` exposes a supported file-backed planned-harness input path distinct from the existing simple prompt/workspace scenario loader, or MoltZap and arena use a short-lived bridge that compiles YAML into that same planned-harness substrate without taking long-term ownership of generic bundle or harness schema logic locally.
- [ ] If arena debugging remains under this cleanup umbrella, the needed `cc-judge` replay/analyze/report surfaces are exported and implemented in a later staged slice; that work does not block the first implementation wave for the core harness/logging/eval-surface cleanup.
- [ ] Declarative MoltZap eval scenarios are loaded from YAML or another supported data format rather than the current TypeScript catalog, and the current TS-only deterministic pass/fail callbacks are replaced with declarative matcher or assertion forms unless a documented exceptional case remains.
- [ ] The current arena eval entrypoints are reduced to thin mode selectors over one shared Effect-native harness; duplicated bring-up logic across the current smoke/full-game/scenario/bootstrap paths is removed.
- [ ] Arena scenarios that are declarative in nature are loaded from YAML or another supported data format and compiled into the shared planned-harness path rather than hard-coded in `scenarios.ts`; only irreducibly procedural cases remain in code.
- [ ] The first cleanup wave does not depend on extending the generic `cc-judge` prompt/workspace scenario schema with arena-specific game-driving fields.
- [ ] The existing simple `cc-judge` prompt/workspace YAML path remains supported for scenarios that already fit it; planned-harness YAML is added as a second path rather than by stretching the simple schema to cover every domain.
- [ ] Static workspace fixture injection for arena agents is either expressed through supported `cc-judge` scenario/workspace features or upstreamed there as a generic capability, rather than remaining a bespoke arena helper.
- [ ] There is no permanent duplicate ownership of generic YAML loading, harness-plan decoding, bundle schema/codec, workspace seeding, or judge/report plumbing across `cc-judge`, `@moltzap/evals`, and `@moltzap/arena-evals`; any short-lived migration bridge is removed once the upstream path lands.
- [ ] Arena harness logic is folded into the core harness/runtime cleanup lane and is no longer treated as a separate local eval platform with its own generic infrastructure surface.
- [ ] Targeted workspace runtime code and relevant `moltzap-arena` runtime/integration code no longer use `console.*` for logging, status, or error reporting; those paths are routed through the shared MoltZap logging surface instead.
- [ ] Fiber-aware tracing/logging is present in the P0 flows for RPC handling, app-session admission/hooks, and transport connection lifecycle, and the downstream arena debug path proven in `moltzap-arena#106` is adopted rather than left as a spike-only artifact.
- [ ] The implementation plan is split into ordered slices, starting with version alignment and ending only when the full MoltZap plus `moltzap-arena` cleanup scope is complete.
- [ ] Verification covers version-alignment safety, config boot behavior, and log-context propagation across asynchronous/fiber boundaries for every package and downstream integration surface touched by the cleanup.

## Assumptions

1. "Upstream" in this work means shared MoltZap packages and abstractions in this repository, not a third-party or external upstream repository.
2. The cleanup scope is intentionally thorough across all MoltZap workspace packages that still carry version-skew glue, config/logging duplication, or `console.*` runtime logging, plus the dependent `moltzap-arena` integration surfaces that still duplicate the same concerns.
3. Effect version pinning should be exact rather than caret-ranged so compatibility failures show up in CI and review rather than downstream installs.
4. Fiber tracing/logging P0 means structured context propagation in core runtime flows, not a full observability-product rollout.
5. `moltzap#83` is in scope for this cleanup: eval/runtime infrastructure that still depends on `nanoclaw-smoke` should be moved into the correct runtime layer or deleted, not left as a permanent wrapper around spike code.
6. The open eval-surface cleanup lane tracked in `moltzap#145`, `#149`, and `#151` is aligned with this cleanup and should be absorbed rather than treated as a separate island: the end-state is `cc-judge` as the default eval model plus a simplified runtime surface.
7. `moltzap-arena#106` is the controlling downstream evidence for the tracing requirement: it proves `Supervisor + Logger` can expose the required fiber state externally and should be graduated from spike into real integration/runtime cleanup.
8. The user's `#105` note is historical context for the tracing requirement; the controlling requirement for this spec is the explicit P0 fiber-tracing/logging goal above together with `moltzap-arena#106`.
9. The arena AppHost / Effect backlog planned under `moltzap-arena#117` is already shipped via closed follow-ons `#73`, `#76`, `#77`, `#78`, `#79`, and `#80`; this cleanup should not duplicate that lane unless a concrete regression is found.
10. The logging shape to converge on is the existing MoltZap upstream pattern already present in `packages/server/src/logger.ts` and `packages/client/src/cli/runtime.ts`: Pino as the sink, Effect logger/context as the integration surface.
11. Collapsing generic eval substrate into `cc-judge` will require coordinated upstream work there, because the current `cc-judge` package surface does not yet expose all of the bundle/replay/debugger APIs MoltZap and arena currently reach for.
12. The current `cc-judge` package also carries its own older `effect` version, so direct cross-repo reuse of Effect-typed surfaces should be treated as part of the cleanup rather than ignored.
13. The current arena harness split is real: full-game, scenario, and agent-bootstrap flows currently live in separate entrypoints and should be unified into one core harness even if multiple scripts remain for operator convenience.
14. `cc-judge` already supports declarative YAML/JSON scenarios and workspace files; arena should prefer that substrate instead of maintaining a TypeScript-only scenario catalog unless a case is provably non-declarative.
15. For this cleanup wave, the declarative arena data boundary should be an arena-owned YAML/data schema that compiles into the shared `cc-judge` planned-harness substrate, rather than a wave-one expansion of the generic `cc-judge` prompt/workspace scenario schema.
16. Arena replay/debugger cleanup remains part of the broader umbrella only as a staged follow-on slice after the core harness/logging/eval cleanup and the necessary `cc-judge` replay export/implementation work.
17. The intended prerequisite order is: `cc-judge` export and `effect` unblockers, then bundle/logging ownership migration, then arena harness unification plus declarative scenario migration, then the staged replay/debugger slice if it remains in scope.
18. The easiest migration path is additive rather than replacement-oriented: keep the existing simple `cc-judge` prompt/workspace scenario loader for simple cases, and add a second planned-harness YAML path aligned to `RunPlan + ExecutionHarness`.
19. MoltZap evals should migrate to declarative YAML/data before arena because their current scenario model is already mostly data and only needs TS callback checks replaced with declarative matcher or assertion forms.
20. If a short-lived repo-local YAML bridge is needed before `cc-judge` lands the generic planned-harness loader, that bridge should compile into the same upstream planned-harness substrate and be removed once `cc-judge` owns the generic file-backed path.
21. "DRY" is a hard constraint for this lane: shared eval infrastructure should be upstreamed once and consumed from there, not reintroduced as parallel repo-local abstractions after migration.
22. The default rollout stance for logging cleanup is to preserve current key fields and message semantics while adding tracing/fiber context as additive structured fields, rather than broad output-shape churn.

## Open questions
None. The current default is to preserve key fields and message semantics while adding tracing and fiber context as additive structured fields.
