# Evaluation source boundary

This folder turns each behavioral case into three pieces of ordinary code:

- `episodes.ts` contains Effect programs over the run-scoped network service
- `evaluation-events.ts` declares customer-owned grading semantics
- `grading-*.ts` and `graders.ts` contain exact-class ledger projections and code checks
- `evaluations.ts` closes each program and grader over a versioned definition
  and caller-supplied runtime

`descriptions.ts` preserves the human intent of each case without becoming an
input format. `index.ts` exposes the suite factory, OpenClaw and Effect
suites, and their stable result types.
