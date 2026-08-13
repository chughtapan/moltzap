import * as Socket from "@effect/platform/Socket";
import { Cause, Data, Exit } from "effect";

/** Describes close info. */
export interface CloseInfo {
  readonly code: number;
  readonly reason: string;
}

/** Represents close kind values. */
type CloseKind = Data.TaggedEnum<{
  clean: {
    readonly code: number;
    readonly reason: string;
  };
  endOfStream: Record<never, never>;
  handshakeFailure: {
    readonly underlying: "Open" | "OpenTimeout";
  };
  transportFailure: {
    readonly underlying: "Read" | "Write";
  };
  unknown: Record<never, never>;
}>;

const closeKind = Data.taggedEnum<CloseKind>();

/** Default value for graceful close. */
export const DEFAULT_GRACEFUL_CLOSE: CloseInfo = {
  code: 1000,
  reason: "normal",
};
/** Default value for abnormal close. */
const DEFAULT_ABNORMAL_CLOSE: CloseInfo = {
  code: 1006,
  reason: "abnormal",
};

const NO_STATUS_RECEIVED_CLOSE_CODE = 1005;

function absurd(x: never): never {
  throw new Error(`unreachable CloseKind branch: ${JSON.stringify(x)}`);
}

/**
 * Executes the classify close cause operation.
 * @param cause Failure cause to inspect.
 * @returns The classify close cause result.
 */
function classifyCloseCause(cause: Cause.Cause<Socket.SocketError>): CloseKind {
  for (const failure of Cause.failures(cause)) {
    const kind = classifySocketFailure(failure);
    if (kind !== null) {
      return kind;
    }
  }
  return closeKind.unknown();
}

function classifySocketFailure(failure: unknown): CloseKind | null {
  let kind: CloseKind | null = null;
  if (Socket.SocketCloseError.is(failure)) {
    kind = closeKind.clean({
      code: failure.code,
      reason: failure.closeReason ?? "",
    });
  } else if (failure instanceof Socket.SocketGenericError) {
    kind = classifyGenericSocketError(failure);
  }
  return kind;
}

function classifyGenericSocketError(
  failure: Socket.SocketGenericError,
): CloseKind {
  let kind: CloseKind;
  switch (failure.reason) {
    case "Open":
    case "OpenTimeout":
      kind = closeKind.handshakeFailure({ underlying: failure.reason });
      break;
    case "Read":
    case "Write":
      kind = closeKind.transportFailure({ underlying: failure.reason });
      break;
    default:
      kind = closeKind.unknown();
  }
  return kind;
}

/**
 * Executes the extract close info operation.
 * @param exit Value supplied to the operation.
 * @returns The extract close info result.
 */
export function extractCloseInfo(
  exit: Exit.Exit<void, Socket.SocketError>,
): CloseInfo {
  if (Exit.isSuccess(exit)) {
    return DEFAULT_GRACEFUL_CLOSE;
  }
  const kind = classifyCloseCause(exit.cause);
  switch (kind._tag) {
    case "clean":
      if (kind.code === NO_STATUS_RECEIVED_CLOSE_CODE) {
        return DEFAULT_GRACEFUL_CLOSE;
      }
      return { code: kind.code, reason: kind.reason };
    case "endOfStream":
      return DEFAULT_GRACEFUL_CLOSE;
    case "handshakeFailure":
    case "transportFailure":
    case "unknown":
      return DEFAULT_ABNORMAL_CLOSE;
    default:
      return absurd(kind);
  }
}
