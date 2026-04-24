/**
 * Unit tests for the close-metadata classifier.
 *
 * Spec #222 §5.4 (V7): the reader-fiber `onExit` path projects an
 * `Exit.Exit<void, Socket.SocketError>` onto a `CloseInfo`. The OQ-5
 * default map fans across five `CloseKind` branches; the live
 * integration tests in `ws-client.test.ts` cover the `Clean` branch
 * via real WebSocket close frames. This file covers the remaining
 * branches by feeding synthetic `Exit` values directly to
 * `extractCloseInfo`, with no transport in play.
 *
 * The five branches map onto two `CloseInfo` constants —
 * `DEFAULT_GRACEFUL_CLOSE` for `EndOfStream` and `DEFAULT_ABNORMAL_CLOSE`
 * for the three failure branches — plus the round-tripped `{code,
 * reason}` from `Clean`. Each branch gets a separate test so a
 * mutation that collapses the map (e.g. always returns
 * `DEFAULT_GRACEFUL_CLOSE`) trips a specific assertion.
 */
import { describe, expect, it } from "vitest";
import { Cause, Exit } from "effect";
import * as Socket from "@effect/platform/Socket";
import {
  classifyCloseCause,
  DEFAULT_ABNORMAL_CLOSE,
  DEFAULT_GRACEFUL_CLOSE,
  extractCloseInfo,
} from "./close-info.js";

describe("extractCloseInfo — OQ-5 default map", () => {
  it("EndOfStream (Exit.Success) → DEFAULT_GRACEFUL_CLOSE", () => {
    const exit = Exit.succeed<void>(undefined);
    expect(extractCloseInfo(exit)).toEqual(DEFAULT_GRACEFUL_CLOSE);
  });

  it("Clean (SocketCloseError) → {code, reason} round-tripped", () => {
    const err = new Socket.SocketCloseError({
      reason: "Close",
      code: 1001,
      closeReason: "going away",
    });
    const exit = Exit.fail(err);
    expect(extractCloseInfo(exit)).toEqual({
      code: 1001,
      reason: "going away",
    });
  });

  it("Clean with no closeReason → empty-string reason (no synthesized text)", () => {
    const err = new Socket.SocketCloseError({
      reason: "Close",
      code: 1000,
    });
    const exit = Exit.fail(err);
    expect(extractCloseInfo(exit)).toEqual({ code: 1000, reason: "" });
  });

  it("HandshakeFailure (Open) → DEFAULT_ABNORMAL_CLOSE", () => {
    const err = new Socket.SocketGenericError({
      reason: "Open",
      cause: new Error("boom"),
    });
    const exit = Exit.fail(err);
    expect(extractCloseInfo(exit)).toEqual(DEFAULT_ABNORMAL_CLOSE);
  });

  it("HandshakeFailure (OpenTimeout) → DEFAULT_ABNORMAL_CLOSE", () => {
    const err = new Socket.SocketGenericError({
      reason: "OpenTimeout",
      cause: new Error("timeout"),
    });
    const exit = Exit.fail(err);
    expect(extractCloseInfo(exit)).toEqual(DEFAULT_ABNORMAL_CLOSE);
  });

  it("TransportFailure (Read) → DEFAULT_ABNORMAL_CLOSE", () => {
    const err = new Socket.SocketGenericError({
      reason: "Read",
      cause: new Error("ECONNRESET"),
    });
    const exit = Exit.fail(err);
    expect(extractCloseInfo(exit)).toEqual(DEFAULT_ABNORMAL_CLOSE);
  });

  it("TransportFailure (Write) → DEFAULT_ABNORMAL_CLOSE", () => {
    const err = new Socket.SocketGenericError({
      reason: "Write",
      cause: new Error("EPIPE"),
    });
    const exit = Exit.fail(err);
    expect(extractCloseInfo(exit)).toEqual(DEFAULT_ABNORMAL_CLOSE);
  });

  it("Unknown (interrupt with no SocketError failure) → DEFAULT_ABNORMAL_CLOSE", () => {
    // An interrupted reader fiber emits a Cause with no failure; the
    // classifier must route it to `Unknown`, not collapse to graceful.
    const exit = Exit.failCause(Cause.interrupt(0 as never));
    expect(extractCloseInfo(exit)).toEqual(DEFAULT_ABNORMAL_CLOSE);
  });
});

describe("classifyCloseCause", () => {
  it("Clean preserves the upstream code + closeReason", () => {
    const err = new Socket.SocketCloseError({
      reason: "Close",
      code: 4321,
      closeReason: "custom",
    });
    const cause = Cause.fail(err);
    expect(classifyCloseCause(cause)).toEqual({
      _tag: "Clean",
      code: 4321,
      reason: "custom",
    });
  });
});
