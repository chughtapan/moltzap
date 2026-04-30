import { describe, expect, it } from "vitest";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { AppHookTimeoutEventSchema } from "./events.js";

const ajv = addFormats(new Ajv({ strict: true }));

describe("AppHookTimeoutEventSchema", () => {
  const validate = ajv.compile(AppHookTimeoutEventSchema);

  const baseEvent = {
    sessionId: "550e8400-e29b-41d4-a716-446655440000",
    appId: "werewolf",
    timeoutMs: 5000,
  };

  it("accepts hookName=before_message_delivery", () => {
    expect(
      validate({ ...baseEvent, hookName: "before_message_delivery" }),
    ).toBe(true);
  });

  it("accepts hookName=before_dispatch", () => {
    expect(validate({ ...baseEvent, hookName: "before_dispatch" })).toBe(true);
  });

  it("accepts hookName=on_join", () => {
    expect(validate({ ...baseEvent, hookName: "on_join" })).toBe(true);
  });

  it("accepts hookName=on_session_active", () => {
    expect(validate({ ...baseEvent, hookName: "on_session_active" })).toBe(
      true,
    );
  });

  it("accepts hookName=on_close", () => {
    expect(validate({ ...baseEvent, hookName: "on_close" })).toBe(true);
  });

  it("rejects unknown hookName", () => {
    expect(validate({ ...baseEvent, hookName: "after_dispatch" })).toBe(false);
  });

  it("rejects missing hookName", () => {
    expect(validate(baseEvent)).toBe(false);
  });

  it("rejects extra properties", () => {
    expect(
      validate({
        ...baseEvent,
        hookName: "before_dispatch",
        extra: true,
      }),
    ).toBe(false);
  });
});
