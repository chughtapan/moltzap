# Evaluation application boundary

> **Implementation transition:** The [accepted main-track Kubernetes
> contract](../../../docs/decisions/20260801-main-simulator-runs-container-societies-on-kubernetes.md)
> governs new work. Host `AgentRuntime` acquisition, in-process Effect peers,
> and rerunning a missing cell describe the pre-cutover implementation. The
> target maps each attempt to one start-or-attach `Run.execute` container run.

This directory is a private application above `@moltzap/simulator`.
`cli.ts` is its executable entry point. Customer society and scenario
languages compose the simulator package directly instead of depending on an
evaluation-library facade.

The source graph has four layers:

1. `model.ts`, `events.ts`, `principal.ts`, and `peer.ts` define branded
   vocabulary, the complete evidence universe, runtime-native principal
   adapters, and autonomous Effect peers.
2. `cases.ts` owns the ordered code-defined policies, exact peer rosters, and
   criteria. `execution.ts` interprets one case against one concrete target
   runtime and the production router.
3. `transcript.ts` validates ledger evidence, `assessment.ts` runs
   deterministic criteria and delegates unresolved questions to the
   provider-neutral judge in `judge.ts`, `judge-openai.ts` supplies the
   production judge layer, and `calibration.ts` holds the fixed corpus that
   keeps a live judge honest. `grading.ts` is the curated boundary over all
   five; nothing outside this layer imports the modules directly.
4. `sweep.ts` and `results.ts` own report state, Effect SQL persistence, and
   resume. The `phoenix-*` modules adapt a completed report to the Phoenix
   protocol behind the `phoenix.ts` publication boundary, with every SDK
   Promise entering Effect through `phoenix-client.ts` alone. `cli.ts`
   supplies the platform and concrete service layers once.

Gateway evidence describes principal interaction with the target runtime.
Social evidence describes traffic committed through the router. Peer gateways
only expose autonomous observations; they never provide a shortcut for social
traffic.

Tests stay beside their owner. Add a failure type only for a state that the
owning API cannot exclude by construction.
