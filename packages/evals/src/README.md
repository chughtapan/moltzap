# Evaluation source boundary

The evaluation package is application code above the simulator. It owns
behavioral interpretation while the simulator owns routing, runtime lifecycle,
and durable evidence.

```text
cases.ts ── episodes.ts
   │             │
   └──── events.ts ── simulator ledger
                           │
                       grading.ts
                           │
                        sweep.ts ── report artifact
                           │
                       phoenix.ts
```

`cases.ts` is the single ordered catalog. A case binds its branded identity,
versioned simulator definition, Effect episode, rubric, slices, and nonempty
criteria. A runtime condition remains a code value containing its own
`AgentRuntime`; no shared provider or model vocabulary is imposed.

`episodes.ts` uses controlled endpoints to open conversations, send setup and
probe traffic, and select target deliveries. `events.ts` declares all
evaluation-owned ledger events before a run starts. Role assignments and
selected-response references give evaluation semantics to content-blind
network evidence without copying message content.

`grading.ts` accepts only a validated completed ledger. Its projector checks
case identity, participant roles, topology, ordered messages, canonical
deliveries, and the exact response selection before producing a transcript.
Criteria run deterministic code first. Remaining semantic questions are
assessed together through the `SemanticJudge` service, with the complete
transcript treated as untrusted evidence.

`sweep.ts` persists the closed terminal-attempt universe and the immutable
execution plan. It validates source, case, criterion, judge, condition, and
runtime-configuration identity on resume. Execution is sequential and every
terminal cell is atomically checkpointed before the next cell begins.

`phoenix.ts` is the only Phoenix client boundary. It consumes completed
reports; it does not run agents or change local report state. Its stable
dataset remains case-only, while each condition experiment exposes the native
sanitized runtime configuration and encoded judge policy. `probes.ts` contains
explicit production-network proofs that are useful outside the behavioral
matrix. `cli.ts` composes these capabilities with Effect Layers at the process
edge and requires both live runtime model IDs.

When adding a case:

1. Add its code-valued definition to the ordered catalog.
2. Reuse or add an episode that returns the intended target deliveries.
3. Add a criterion whose deterministic branch only decides facts code can
   establish conclusively.
4. Add structurally authentic semantic calibration examples when the
   criterion can reach the judge.
5. Test evidence rejection as well as expected passing and failing behavior.
