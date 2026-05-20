/**
 * @file Client error taxonomy.
 *
 * Every error in the client SDK is a `Data.TaggedError`. Callers
 * pattern-match on `._tag`. The package's failure modes cluster into
 * three propagation classes:
 *
 * 1. **Transport-layer** — `NotConnectedError`, `RpcTimeoutError`,
 *    `RpcServerError` (from `@moltzap/protocol`). Raised by
 *    `MoltZapWsClient.sendRpc` and reach the caller of the RPC.
 *    `MalformedFrameError` is the exception: it never escapes the
 *    socket reader fiber (logged and dropped, sampled 1-in-50).
 *
 * 2. **Service-layer** — `AgentNotFoundError` (this file),
 *    `RegisterAgentError` (`auth.ts`). Raised by `MoltZapService`
 *    helpers when a higher-level concern fails (name lookup,
 *    registration). Reach the caller.
 *
 * 3. **Dispatch-layer** — `DispatchAdmissionTimedOut`,
 *    `DispatchLeaseExpired` (`channel-core-errors.ts`). Fail closed
 *    inside `MoltZapChannelCore.dispatchAdmission` / `dispatchWithLease`
 *    and do NOT propagate to `InboundHandler`: admission timeouts
 *    deny the message, lease expiry logs and discards the handler
 *    result. The lease times out server-side independently.
 *
 * The CLI layer adds two of its own (`ServiceInputError`,
 * `SocketRequestError`) for daemon-socket faults. Those never escape
 * the CLI process.
 */
import { Data } from "effect";

// `MalformedFrameError` is now protocol-side (`@moltzap/protocol`); both
// client and server share the same class. Re-exported here for the
// existing client-package import surface.
export { MalformedFrameError } from "@moltzap/protocol";

/** A name→agent lookup returned no results. */
export class AgentNotFoundError extends Data.TaggedError("AgentNotFoundError")<{
  readonly agentName: string;
}> {
  override get message(): string {
    return `Agent not found: ${this.agentName}`;
  }
}
