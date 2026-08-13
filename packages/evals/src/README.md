# Evaluation application boundary

This directory is a private application above the public `@moltzap/client` and
`@moltzap/simulator` surfaces. `cli.ts` is its executable entry point.

The retained evaluation path has four parts:

1. `model.ts`, `events.ts`, and `principal.ts` define evaluation vocabulary,
   native principal-gateway evidence, and the OpenClaw and NanoClaw adapters.
2. `cases.ts` owns the ordered native-gateway case policy and criteria;
   `execution.ts` runs it against one concrete target runtime.
3. `transcript.ts`, `assessment.ts`, `judge.ts`, and `calibration.ts` validate
   gateway evidence and grade the selected target output.
4. `sweep.ts`, `results.ts`, and the `phoenix-*` modules own resumable reports
   and publication. `cli.ts` supplies platform and service layers once.

The package does not provide raw protocol peers or infer network evidence.
Future social cases should be built only when their required behavior has a
public Client or Simulator owner.
