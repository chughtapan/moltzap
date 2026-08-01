# Evaluation application boundary

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
3. `grading.ts` validates ledger evidence, runs deterministic criteria, and
   delegates unresolved questions to the semantic judge.
4. `sweep.ts`, `results.ts`, and `phoenix.ts` own report state, Effect SQL
   persistence, resume, and external materialization. `cli.ts` supplies the
   platform and concrete service layers once.

Gateway evidence describes principal interaction with the target runtime.
Social evidence describes traffic committed through the router. Peer gateways
only expose autonomous observations; they never provide a shortcut for social
traffic.

Tests stay beside their owner. Add a failure type only for a state that the
owning API cannot exclude by construction.
