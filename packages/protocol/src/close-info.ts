import * as Socket from "@effect/platform/Socket";
import { Cause, Data, Exit } from "effect";

export interface CloseInfo {
  readonly code: number;
  readonly reason: string;
}

export type CloseKind = Data.TaggedEnum<{
  Clean: {
    readonly code: number;
    readonly reason: string;
  };
  EndOfStream: {};
  HandshakeFailure: {
    readonly underlying: "Open" | "OpenTimeout";
  };
  TransportFailure: {
    readonly underlying: "Read" | "Write";
  };
  Unknown: {};
}>;

const CloseKind = Data.taggedEnum<CloseKind>();

export const DEFAULT_GRACEFUL_CLOSE: CloseInfo = {
  code: 1000,
  reason: "normal",
};
export const DEFAULT_ABNORMAL_CLOSE: CloseInfo = {
  code: 1006,
  reason: "abnormal",
};

function absurd(x: never): never {
  throw new Error(`unreachable CloseKind branch: ${JSON.stringify(x)}`);
}

export function classifyCloseCause(
  cause: Cause.Cause<Socket.SocketError>,
): CloseKind {
  for (const failure of Cause.failures(cause)) {
    const kind = classifySocketFailure(failure);
    if (kind !== null) return kind;
  }
  return CloseKind.Unknown();
}

function classifySocketFailure(failure: unknown): CloseKind | null {
  if (Socket.SocketCloseError.is(failure)) {
    return CloseKind.Clean({
      code: failure.code,
      reason: failure.closeReason ?? "",
    });
  }
  if (failure instanceof Socket.SocketGenericError) {
    return classifyGenericSocketError(failure);
  }
  return null;
}

function classifyGenericSocketError(
  failure: Socket.SocketGenericError,
): CloseKind {
  switch (failure.reason) {
    case "Open":
    case "OpenTimeout":
      return CloseKind.HandshakeFailure({ underlying: failure.reason });
    case "Read":
    case "Write":
      return CloseKind.TransportFailure({ underlying: failure.reason });
    default:
      return CloseKind.Unknown();
  }
}

export function extractCloseInfo(
  exit: Exit.Exit<void, Socket.SocketError>,
): CloseInfo {
  if (Exit.isSuccess(exit)) {
    return DEFAULT_GRACEFUL_CLOSE;
  }
  const kind = classifyCloseCause(exit.cause);
  switch (kind._tag) {
    case "Clean":
      return { code: kind.code, reason: kind.reason };
    case "EndOfStream":
      return DEFAULT_GRACEFUL_CLOSE;
    case "HandshakeFailure":
    case "TransportFailure":
    case "Unknown":
      return DEFAULT_ABNORMAL_CLOSE;
    default:
      return absurd(kind);
  }
}
