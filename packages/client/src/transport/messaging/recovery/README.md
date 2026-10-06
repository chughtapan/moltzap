# Messaging recovery

This directory owns local catch-up and Router-restart recovery. It holds each
conversation's protocol traffic until that conversation's recovered position is
safe to use.

Start with `index.ts`. It owns the recovery run: its lifecycle, ingress
dispatch, the catch-up retries it schedules for each conversation, and the
ports its catch-up and re-anchor use. Each conversation recovers on its own,
and the run's traffic, including answers to members' catch-up requests, goes
out through the durable outbox. `catch-up.ts` asks members for history after a
position and answers their requests. `barrier.ts` holds the fences sends wait
behind: one for the engine until a run has fenced each conversation, then one
per conversation until it recovers. Re-anchor lives in `../reanchor/` and
reaches the run only through its `ReanchorRunPort`. Stored rows are verified
in `../history/`, and `../startup.ts` rebuilds the engine's state from the
store when the engine starts.
