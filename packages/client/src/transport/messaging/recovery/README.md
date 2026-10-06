# Messaging recovery

This directory owns local catch-up and Router-restart recovery. It blocks
normal protocol traffic until the recovered position is safe to use.

Start with `index.ts`. It owns the recovery run: its lifecycle, ingress
dispatch, outbound queue and completion accounting. It builds the ports the
run's catch-up and re-anchor use. It also runs catch-up for one conversation
outside a recovery run, when certification finds a proposal naming a
predecessor this endpoint does not hold. `catch-up.ts` asks members for history after
a position and answers their requests. `barrier.ts` holds new sends from a
Router discontinuity until recovery completes; the engine and the send path
share it. Re-anchor lives in `../reanchor/` and reaches the run only through
its `ReanchorRunPort`. Stored rows are verified in `../history/`, and
`../startup.ts` rebuilds the engine's state from the store when the engine
starts.
