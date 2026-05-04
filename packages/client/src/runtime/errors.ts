import { Data } from "effect";
import type { AppCallbackRpcMethodName } from "@moltzap/protocol";

/** Inbound frame failed to parse as JSON or did not match the expected shape. */
export class MalformedFrameError extends Data.TaggedError(
  "MalformedFrameError",
)<{
  readonly raw: string;
  readonly cause?: unknown;
}> {}

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
  readonly method: AppCallbackRpcMethodName;
}> {
  override get message(): string {
    return `Server RPC handler already registered for method: ${this.method}`;
  }
}
