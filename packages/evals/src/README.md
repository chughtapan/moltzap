# Evaluation application boundary

This directory is a private application above `@moltzap/simulator`.
`cli.ts` is its executable entry point. Customer society and scenario
languages compose the simulator package directly instead of depending on an
evaluation-library facade.

The source graph has four layers:

1. `model.ts`, `events.ts`, `principal.ts`, and `peer.ts` define branded
   vocabulary, the complete evidence universe, runtime-native principal
   adapters, and autonomous peer application containers whose Effect policy
   remains evaluation-owned.
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

Enabled attempts use the core `Run.execute` Kubernetes path. Gateway evidence
describes principal interaction with the target runtime. Social evidence
describes traffic committed through the router. Each peer policy runs in its
own application container, and its exact evaluation-owned observation bridge
reports what the peer observed; the bridge never provides a shortcut for
social traffic.

Tests stay beside their owner. Add a failure type only for a state that the
owning API cannot exclude by construction.
