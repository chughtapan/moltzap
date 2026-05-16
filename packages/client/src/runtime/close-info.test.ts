/**
 * Unit tests for the close-metadata classifier.
 *
 * Spec #222 §5.4 (V7): the reader-fiber `onExit` path projects an
 * `Exit.Exit&lt;void, Socket.SocketError>` onto a `CloseInfo`. The OQ-5
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
import * as fc from "fast-check";
import { expect, it } from "vitest";
import { Cause, Exit } from "effect";
import * as Socket from "@effect/platform/Socket";
import {
  classifyCloseCause,
  DEFAULT_ABNORMAL_CLOSE,
  DEFAULT_GRACEFUL_CLOSE,
  extractCloseInfo,
} from "./close-info.js";

const PROPERTY_RUNS = 25;

it("property: Clean close cause preserves code and reason", () => {
  expect.hasAssertions();
  fc.assert(
    fc.property(
      fc.integer({ min: 1000, max: 4999 }),
      fc.string(),
      (code, reason) => {
        const close = classifyCloseCause(
          Cause.fail(
            new Socket.SocketCloseError({
              reason: "Close",
              code,
              closeReason: reason,
            }),
          ),
        );
        expect(close).toEqual({ _tag: "Clean", code, reason });
      },
    ),
    { numRuns: PROPERTY_RUNS },
  );
});

it("EndOfStream maps to DEFAULT_GRACEFUL_CLOSE", () => {
  const exit = Exit.succeed<void>(undefined);
  expect(extractCloseInfo(exit)).toEqual(DEFAULT_GRACEFUL_CLOSE);
});

it("Clean SocketCloseError round-trips code and reason", () => {
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

it("Clean with no closeReason uses empty-string reason", () => {
  const err = new Socket.SocketCloseError({
    reason: "Close",
    code: 1000,
  });
  const exit = Exit.fail(err);
  expect(extractCloseInfo(exit)).toEqual({ code: 1000, reason: "" });
});

it("HandshakeFailure Open maps to DEFAULT_ABNORMAL_CLOSE", () => {
  const err = new Socket.SocketGenericError({
    reason: "Open",
    cause: new Error("boom"),
  });
  const exit = Exit.fail(err);
  expect(extractCloseInfo(exit)).toEqual(DEFAULT_ABNORMAL_CLOSE);
});

it("HandshakeFailure OpenTimeout maps to DEFAULT_ABNORMAL_CLOSE", () => {
  const err = new Socket.SocketGenericError({
    reason: "OpenTimeout",
    cause: new Error("timeout"),
  });
  const exit = Exit.fail(err);
  expect(extractCloseInfo(exit)).toEqual(DEFAULT_ABNORMAL_CLOSE);
});

it("TransportFailure Read maps to DEFAULT_ABNORMAL_CLOSE", () => {
  const err = new Socket.SocketGenericError({
    reason: "Read",
    cause: new Error("ECONNRESET"),
  });
  const exit = Exit.fail(err);
  expect(extractCloseInfo(exit)).toEqual(DEFAULT_ABNORMAL_CLOSE);
});

it("TransportFailure Write maps to DEFAULT_ABNORMAL_CLOSE", () => {
  const err = new Socket.SocketGenericError({
    reason: "Write",
    cause: new Error("EPIPE"),
  });
  const exit = Exit.fail(err);
  expect(extractCloseInfo(exit)).toEqual(DEFAULT_ABNORMAL_CLOSE);
});

it("interrupt with no SocketError failure maps to DEFAULT_ABNORMAL_CLOSE", () => {
  const exit = Exit.failCause(Cause.interrupt(0 as never));
  expect(extractCloseInfo(exit)).toEqual(DEFAULT_ABNORMAL_CLOSE);
});

it("classifyCloseCause preserves upstream code and closeReason", () => {
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
