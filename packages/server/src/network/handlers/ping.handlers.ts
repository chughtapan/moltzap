import { Effect } from "effect";

const pingBody = () => Effect.sync(() => ({ ts: new Date().toISOString() }));

/**
 * Native `network/ping` body. Agent-gated, cap-less, principal-independent: the
 * `NetworkPingAuth` proof only witnesses the agent gate ran; the reply is a
 * server timestamp with no principal read.
 */
export const nativePing = () =>
  pingBody().pipe(Effect.withSpan("nativePing"));
