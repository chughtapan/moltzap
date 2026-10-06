# Messaging recovery

This directory owns local catch-up and Router-restart recovery. It blocks
normal protocol traffic until the recovered position is safe to use.

Start with `index.ts`. It owns each recovery attempt and the run it starts:
their lifecycle, ingress dispatch, the attempt's outbound queue and completion
accounting. The queue takes envelopes from before the run starts, and an
attempt that ends early hands the catch-up answers it left unsent to the next
attempt. It builds the ports the run's catch-up and re-anchor use.
`catch-up.ts` asks members for history after a position and answers their
requests. `barrier.ts` holds new sends from a Router discontinuity until
recovery completes; the engine and the send path share it. Re-anchor lives in
`../reanchor/` and reaches the run only through its `ReanchorRunPort`. Stored
rows are verified in `../history/`, and `../startup.ts` rebuilds the engine's
state from the store when the engine starts.
