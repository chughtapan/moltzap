# Messaging certification

This directory certifies posts. It selects the Router-ordered proposal at
each predecessor, signs and collects action and durability evidence, and
promotes a record once its certificates reach quorum. Each member assembles
both certified records from the evidence it receives; none is sent. A
proposal naming a predecessor this endpoint does not hold waits while
recovery's catch-up fetches the missing history, and is accepted once the
predecessor is certified here.

Start with `index.ts`. It accepts Router and catch-up ingress, holds waiting
proposals, resumes folds at startup and after each Router recovery, and
re-exports the evidence-to-fold match `../startup.ts` uses. `evidence.ts`
routes a stable evidence message to the fold it names and verifies it; it is
private to this directory. The engine binds the operations other phases start
through `EngineRuntime.phases`.
