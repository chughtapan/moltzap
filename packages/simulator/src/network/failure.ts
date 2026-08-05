/** @file Typed failures raised at any network boundary. */

import { Schema } from "effect";

const networkOperation = Schema.Literal(
  "acquire-router",
  "attach-agent",
  "attach-endpoint",
  "disable-link",
  "enable-link",
  "open-conversation",
  "receive",
  "shape-link",
  "socket",
  "stop-router",
  "send",
);
/** Network operation names used by typed failures. */
export type NetworkOperation = typeof networkOperation.Type;

/** An operational failure at a network boundary. */
export class NetworkError extends Schema.TaggedError<NetworkError>()(
  "NetworkError",
  {
    operation: networkOperation,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Network ${this.operation} failed: ${this.detail}`;
  }
}

/**
 * Normalize an implementation failure at the network boundary.
 * @param operation Failed network operation.
 * @param cause Implementation failure.
 * @returns Typed network failure.
 */
export function networkError(
  operation: NetworkOperation,
  cause: unknown,
): NetworkError {
  return NetworkError.make({ operation, detail: String(cause) });
}
