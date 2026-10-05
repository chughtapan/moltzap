# Messaging certification

This directory certifies posts. It selects the Router-ordered proposal at
each predecessor, signs and collects action and durability evidence, and
promotes a record once its certificates reach quorum. It also resumes the
dissemination of certified records that the store still owes to peers.

Start with `index.ts`. It accepts Router and recovery ingress, resumes folds
at startup and after each Router recovery, and re-exports the dissemination
resume. `evidence.ts` routes a stable evidence message to the fold it names
and verifies it. `dissemination.ts` re-queues each durable dissemination
obligation. Both are private to this directory; the engine binds the
operations other phases start through `EngineRuntime.phases`.
