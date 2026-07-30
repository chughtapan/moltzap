/**
 * @file Type canary for the socket endpoint constructor (`network/server-url.ts`).
 *
 * The invariant: `webSocketUrl` appends its route to whatever it is handed, so
 * only a value proven path-free may reach it. If the parameter loosens back to
 * `string`, a caller holding a complete socket endpoint compiles again and
 * dials `/ws/ws` — the failure this brand exists to make unrepresentable.
 */
import { serverBaseUrl, webSocketUrl } from "./server-url.js";

type ExpectFalse<T extends false> = T;
type WebSocketUrlInput = Parameters<typeof webSocketUrl>[0];
type PlainStringIsRejected = ExpectFalse<
  string extends WebSocketUrlInput ? true : false
>;

// Positive control: the same address routed through the constructor compiles.
const routedUrl = webSocketUrl(serverBaseUrl("ws://127.0.0.1:32821/ws"));

/** Retains both the runtime positive control and compile-time negative proof. */
export const serverUrlTypeCanaries: {
  readonly routedUrl: string;
  readonly plainStringIsRejected: PlainStringIsRejected;
} = { routedUrl, plainStringIsRejected: false };
