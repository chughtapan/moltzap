import { describe, expect, it } from "vitest";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import {
  RequestFrameSchema,
  ResponseFrameSchema,
  EventFrameSchema,
} from "./frames.js";

const ajv = addFormats(new Ajv({ strict: true }));

describe("RequestFrameSchema", () => {
  const validate = ajv.compile(RequestFrameSchema);

  it("accepts valid c2s request frame", () => {
    expect(
      validate({
        jsonrpc: "2.0",
        type: "request",
        direction: "c2s",
        id: "req-1",
        method: "messages/send",
        params: { text: "hello" },
      }),
    ).toBe(true);
  });

  it("accepts valid s2c request frame", () => {
    expect(
      validate({
        jsonrpc: "2.0",
        type: "request",
        direction: "s2c",
        id: "srv-1",
        method: "apps/onJoin",
        params: { sessionId: "s-1" },
      }),
    ).toBe(true);
  });

  it("accepts request frames with traceparent", () => {
    expect(
      validate({
        jsonrpc: "2.0",
        type: "request",
        direction: "s2c",
        id: "srv-trace-1",
        method: "apps/onJoin",
        params: { sessionId: "s-1" },
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      }),
    ).toBe(true);
  });

  it("rejects missing direction", () => {
    expect(
      validate({
        jsonrpc: "2.0",
        type: "request",
        id: "req-1",
        method: "messages/send",
        params: { text: "hello" },
      }),
    ).toBe(false);
  });

  it("rejects unknown direction", () => {
    expect(
      validate({
        jsonrpc: "2.0",
        type: "request",
        direction: "broadcast",
        id: "req-1",
        method: "messages/send",
      }),
    ).toBe(false);
  });

  it("rejects missing jsonrpc field", () => {
    expect(
      validate({
        type: "request",
        direction: "c2s",
        id: "req-1",
        method: "test",
      }),
    ).toBe(false);
  });

  it("rejects wrong type", () => {
    expect(
      validate({
        jsonrpc: "2.0",
        type: "response",
        direction: "c2s",
        id: "req-1",
        method: "test",
      }),
    ).toBe(false);
  });
});

describe("ResponseFrameSchema", () => {
  const validate = ajv.compile(ResponseFrameSchema);

  it("accepts c2s success response", () => {
    expect(
      validate({
        jsonrpc: "2.0",
        type: "response",
        direction: "c2s",
        id: "req-1",
        result: { ok: true },
      }),
    ).toBe(true);
  });

  it("accepts s2c success response", () => {
    expect(
      validate({
        jsonrpc: "2.0",
        type: "response",
        direction: "s2c",
        id: "srv-1",
        result: {},
      }),
    ).toBe(true);
  });

  it("accepts error response", () => {
    expect(
      validate({
        jsonrpc: "2.0",
        type: "response",
        direction: "c2s",
        id: "req-1",
        error: { code: -32000, message: "Unauthorized" },
      }),
    ).toBe(true);
  });

  it("rejects missing direction", () => {
    expect(
      validate({
        jsonrpc: "2.0",
        type: "response",
        id: "req-1",
        result: { ok: true },
      }),
    ).toBe(false);
  });
});

describe("EventFrameSchema", () => {
  const validate = ajv.compile(EventFrameSchema);

  it("accepts valid event", () => {
    expect(
      validate({
        jsonrpc: "2.0",
        type: "event",
        event: "messages/received",
        data: { message: {} },
      }),
    ).toBe(true);
  });
});
