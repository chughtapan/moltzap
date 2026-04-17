import { Data } from "effect";

/** The socket is not in the OPEN state when an RPC was attempted. */
export class NotConnectedError extends Data.TaggedError("NotConnectedError")<{
  readonly message: string;
}> {}

/** The RPC exceeded the per-call timeout without a response frame. */
export class RpcTimeoutError extends Data.TaggedError("RpcTimeoutError")<{
  readonly method: string;
  readonly timeoutMs: number;
}> {}

/** The server returned an `error` response frame. */
export class RpcServerError extends Data.TaggedError("RpcServerError")<{
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}> {}

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
  get message(): string {
    return `Agent not found: ${this.agentName}`;
  }
}
