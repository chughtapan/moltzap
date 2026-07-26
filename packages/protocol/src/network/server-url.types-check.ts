/**
 * @file Type canary for the socket endpoint constructor (`network/server-url.ts`).
 *
 * The invariant: `webSocketUrl` appends its route to whatever it is handed, so
 * only a value proven path-free may reach it. If the parameter loosens back to
 * `string`, a caller holding a complete socket endpoint compiles again and
 * dials `/ws/ws` — the failure this brand exists to make unrepresentable.
 */
import { serverBaseUrl, webSocketUrl } from "./server-url.js";

// @ts-expect-error a plain string is not proven path-free
webSocketUrl("ws://127.0.0.1:32821/ws");

// Positive control: the same address routed through the constructor compiles.
webSocketUrl(serverBaseUrl("ws://127.0.0.1:32821/ws"));
