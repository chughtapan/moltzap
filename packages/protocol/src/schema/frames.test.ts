import { describe, expect, it } from "vitest";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import {
  JsonRpcIdSchema,
  RequestFrameSchema,
  ResponseFrameSchema,
  NotificationFrameSchema,
} from "./frames.js";

import { MessagesSend } from "./methods/messages.js";

const ajv = addFormats(new Ajv({ strict: true }));

describe("JsonRpcIdSchema", () => {
  const validate = ajv.compile(JsonRpcIdSchema);

  it("accepts JSON-RPC id values", () => {
    expect(validate("req-1")).toBe(true);
    expect(validate(1)).toBe(true);
    expect(validate(null)).toBe(true);
  });

  it("rejects non-id values", () => {
    expect(validate({ id: "req-1" })).toBe(false);
    expect(validate(undefined)).toBe(false);
  });
});

describe("RequestFrameSchema", () => {
  const validate = ajv.compile(RequestFrameSchema);

  it("accepts valid request frame", () => {
    expect(
      validate({
        jsonrpc: "2.0",
        id: "req-1",
        method: MessagesSend.name,
        params: { text: "hello" },
      }),
    ).toBe(true);
  });

  it("rejects missing id", () => {
    expect(
      validate({
        jsonrpc: "2.0",
        method: MessagesSend.name,
        params: { text: "hello" },
      }),
    ).toBe(false);
  });

  it("rejects notification id values", () => {
    expect(
      validate({
        jsonrpc: "2.0",
        id: null,
        method: MessagesSend.name,
      }),
    ).toBe(false);
  });

  it("rejects missing jsonrpc field", () => {
    expect(
      validate({
        id: "req-1",
        method: "test",
      }),
    ).toBe(false);
  });

  it("rejects extra non-JSON-RPC fields", () => {
    expect(
      validate({
        jsonrpc: "2.0",
        extra: "not allowed",
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
        id: "req-1",
        result: { ok: true },
      }),
    ).toBe(true);
  });

  it("accepts numeric and null ids", () => {
    expect(
      validate({
        jsonrpc: "2.0",
        id: 1,
        result: {},
      }),
    ).toBe(true);

    expect(
      validate({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      }),
    ).toBe(true);
  });

  it("accepts error response", () => {
    expect(
      validate({
        jsonrpc: "2.0",
        id: "req-1",
        error: { code: -32000, message: "Unauthorized" },
      }),
    ).toBe(true);
  });

  it("rejects responses with both result and error", () => {
    expect(
      validate({
        jsonrpc: "2.0",
        id: "req-1",
        result: { ok: true },
        error: { code: -32000, message: "Unauthorized" },
      }),
    ).toBe(false);
  });

  it("rejects responses with neither result nor error", () => {
    expect(
      validate({
        jsonrpc: "2.0",
        id: "req-1",
      }),
    ).toBe(false);
  });
});

describe("NotificationFrameSchema", () => {
  const validate = ajv.compile(NotificationFrameSchema);

  it("accepts valid notification", () => {
    expect(
      validate({
        jsonrpc: "2.0",
        method: "messages/received",
        params: { message: {} },
      }),
    ).toBe(true);
  });

  it("rejects request ids", () => {
    expect(
      validate({
        jsonrpc: "2.0",
        id: "req-1",
        method: "messages/received",
        params: { message: {} },
      }),
    ).toBe(false);
  });
});
