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

/**
 * `MoltZapWsClient.handleServerRpc` was called twice for the same method.
 * Multiple registrations would silently shadow each other; the typed error
 * forces the duplicate registration to surface at the call site.
 */
export class DuplicateServerRpcHandlerError extends Data.TaggedError(
  "DuplicateServerRpcHandlerError",
)<{
  readonly method: string;
}> {
  override get message(): string {
    return `Server RPC handler already registered for method: ${this.method}`;
  }
}
