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

  it("accepts valid request frame", () => {
    expect(
      validate({
        jsonrpc: "2.0",
        type: "request",
        id: "req-1",
        method: "messages/send",
        params: { text: "hello" },
      }),
    ).toBe(true);
  });

  it("rejects missing jsonrpc field", () => {
    expect(validate({ type: "request", id: "req-1", method: "test" })).toBe(
      false,
    );
  });

  it("rejects wrong type", () => {
    expect(
      validate({
        jsonrpc: "2.0",
        type: "response",
        id: "req-1",
        method: "test",
      }),
    ).toBe(false);
  });
});

describe("ResponseFrameSchema", () => {
  const validate = ajv.compile(ResponseFrameSchema);

  it("accepts success response", () => {
    expect(
      validate({
        jsonrpc: "2.0",
        type: "response",
        id: "req-1",
        result: { ok: true },
      }),
    ).toBe(true);
  });

  it("accepts error response", () => {
    expect(
      validate({
        jsonrpc: "2.0",
        type: "response",
        id: "req-1",
        error: { code: -32000, message: "Unauthorized" },
      }),
    ).toBe(true);
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
