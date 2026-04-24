/**
 * Close-metadata extraction for the WebSocket reader fiber.
 *
 * Responsibility: inspect an `Exit.Exit<void, Socket.SocketError>` produced by
 * `Socket.runRaw(...)` and project it onto a caller-facing `CloseInfo`
 * (WebSocket `{code, reason}`). Spec #222 AC 5.4 requires the real close
 * metadata, not hardcoded constants, when upstream surfaces it; OQ-5 names
 * the defaults to synthesize when it does not.
 *
 * Pure module: no I/O, no Refs, no fibers. Called exactly once per socket
 * lifetime from `MoltZapWsClient`'s reader-fiber `Effect.onExit` hook
 * (`ws-client.ts:386-411` today — post-impl the extraction happens at that
 * same point before calling `onDisconnect(close)`).
 *
 * Error channel: `extractCloseInfo` is total — every possible `Exit` maps to
 * a `CloseInfo`. The defaults below are the resolution of OQ-5 (A). No
 * typed error surface on this module.
 */
import { Cause, Exit } from "effect";
import * as Socket from "@effect/platform/Socket";

/**
 * WebSocket close metadata surfaced to `MoltZapWsClientOptions.onDisconnect`
 * (required arg post-migration — see design doc §Deletions, OQ-6) and to
 * the conformance-adapter's `RealClientCloseEvent`. Mirrors the WHATWG
 * WebSocket `CloseEvent` fields restricted to `{code, reason}` — `wasClean`
 * is derivable from `code` and not worth its own field.
 */
export interface CloseInfo {
  readonly code: number;
  readonly reason: string;
}

/**
 * Discriminated shape the reader-fiber exit falls into. Implementation's
 * `extractCloseInfo` pattern-matches this union and returns the `{code,
 * reason}` projection. Named here so downstream review can check that
 * every branch has an assigned close pair.
 *
 * Exhaustiveness (Principle 4): the `Unknown` branch is the residual for
 * any `SocketError` variant @effect/platform adds in the future. The
 * implementation's pattern-match ends in `default: return absurd(kind)`.
 */
export type CloseKind =
  | {
      /** Graceful `SocketCloseError` — upstream code + reason round-tripped. */
      readonly _tag: "Clean";
      readonly code: number;
      readonly reason: string;
    }
  | {
      /** `Exit.Success` with no close frame observed — socket ended cleanly. */
      readonly _tag: "EndOfStream";
    }
  | {
      /** `SocketGenericError` with reason "Open" / "OpenTimeout". */
      readonly _tag: "HandshakeFailure";
      readonly underlying: "Open" | "OpenTimeout";
    }
  | {
      /** `SocketGenericError` with reason "Read" / "Write" — transport broke. */
      readonly _tag: "TransportFailure";
      readonly underlying: "Read" | "Write";
    }
  | {
      /** Cause did not match any known `SocketError` shape. */
      readonly _tag: "Unknown";
    };

/**
 * OQ-5 resolution defaults. Exported so the implementation, tests, and
 * the conformance-adapter's V7 proof share one source of truth.
 */
export const DEFAULT_GRACEFUL_CLOSE: CloseInfo = {
  code: 1000,
  reason: "normal",
};
export const DEFAULT_ABNORMAL_CLOSE: CloseInfo = {
  code: 1006,
  reason: "abnormal",
};

/** Exhaustiveness sentinel for `CloseKind` switches (Principle 4). */
function absurd(x: never): never {
  throw new Error(`unreachable CloseKind branch: ${JSON.stringify(x)}`);
}

/**
 * Classify a reader-fiber exit cause into `CloseKind`. Total; the
 * `Unknown` branch is the residual for future `SocketError` variants.
 *
 * Logic:
 *   1. If the cause carries a `SocketCloseError` failure (reason ===
 *      "Close"), surface its `code` + `closeReason` as `Clean`.
 *   2. If it carries a `SocketGenericError`, branch on `reason`:
 *        - "Open" / "OpenTimeout" → `HandshakeFailure`
 *        - "Read" / "Write" → `TransportFailure`
 *   3. Anything else (interrupt, unknown defect, no failure) →
 *      `Unknown`. The caller (`extractCloseInfo`) maps this to the
 *      OQ-5 abnormal default.
 */
export function classifyCloseCause(
  cause: Cause.Cause<Socket.SocketError>,
): CloseKind {
  // The reader fiber emits at most one SocketError-shaped failure on
  // close; iterate the `Cause.failures` chunk and route on the first
  // match. `Chunk` is iterable, so a `for…of` walk is sufficient.
  for (const failure of Cause.failures(cause)) {
    if (Socket.SocketCloseError.is(failure)) {
      return {
        _tag: "Clean",
        code: failure.code,
        reason: failure.closeReason ?? "",
      };
    }
    if (Socket.isSocketError(failure)) {
      // SocketGenericError — branch on the four documented reasons and
      // let any future variant fall through to `Unknown`.
      const generic = failure as Socket.SocketGenericError;
      switch (generic.reason) {
        case "Open":
        case "OpenTimeout":
          return { _tag: "HandshakeFailure", underlying: generic.reason };
        case "Read":
        case "Write":
          return { _tag: "TransportFailure", underlying: generic.reason };
        default:
          return { _tag: "Unknown" };
      }
    }
  }
  return { _tag: "Unknown" };
}

/**
 * Project an `Exit` onto `CloseInfo`. Composition of `classifyCloseCause`
 * plus the OQ-5 default map:
 *
 *   Clean              -> { code, reason } from SocketCloseError
 *   EndOfStream        -> DEFAULT_GRACEFUL_CLOSE
 *   HandshakeFailure   -> DEFAULT_ABNORMAL_CLOSE
 *   TransportFailure   -> DEFAULT_ABNORMAL_CLOSE
 *   Unknown            -> DEFAULT_ABNORMAL_CLOSE
 */
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
