/** @file Typed failures raised at simulator network boundaries. */

import { Schema } from "effect";

const networkOperation = Schema.Literal(
  "acquire-router",
  "attach-endpoint",
  "disable-link",
  "enable-link",
  "receive",
  "shape-link",
  "socket",
  "send",
  "stop-router",
);
/** Network operation names used by typed failures. */
export type NetworkOperation = typeof networkOperation.Type;

/** An operational failure at a simulator network boundary. */
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
 * Normalize an implementation failure at the network boundary. Error causes
 * contribute their message alone so one operation reads the same way whether
 * the boundary raised a thrown Error or a plain description.
 * @param operation Failed network operation.
 * @param cause Implementation failure.
 * @returns Typed network failure.
 */
export function networkError(
  operation: NetworkOperation,
  cause: unknown,
): NetworkError {
  return NetworkError.make({
    operation,
    detail: cause instanceof Error ? cause.message : String(cause),
  });
}
