# Messaging recovery

This directory owns local catch-up and Router-restart recovery. It blocks
normal protocol traffic until the recovered position is safe to use.

Start with `index.ts`. It is the private facade for recovery lifecycle,
catch-up, and ingress coordination. The messaging engine uses that facade,
and the engine and outbound path also share the readiness barrier in
`barrier.ts`. Re-anchor lives in `../reanchor/`, and the state a recovery run
shares with it lives in `../recovery-session/`. Stored rows are verified in
`../history/`, and `../startup.ts` rebuilds the engine's state from the store
when the engine starts.
