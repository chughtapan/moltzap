import { describe, it, expect } from "vitest";
import {
  AppError,
  AuthError,
  SessionError,
  SessionClosedError,
  ManifestRegistrationError,
  ConversationKeyError,
  SendError,
} from "./errors.js";

describe("AppError hierarchy", () => {
  it("AppError has code and message", () => {
    const err = new AppError("TEST_CODE", "test message");
    expect(err.code).toBe("TEST_CODE");
    expect(err.message).toBe("test message");
    expect(err.name).toBe("AppError");
    expect(err).toBeInstanceOf(Error);
  });

  it("AppError preserves cause", () => {
    const cause = new Error("original");
    const err = new AppError("TEST", "wrapped", cause);
    expect(err.cause).toBe(cause);
  });

  it("AuthError has AUTH_FAILED code", () => {
    const err = new AuthError("bad creds");
    expect(err.code).toBe("AUTH_FAILED");
    expect(err.name).toBe("AuthError");
    expect(err).toBeInstanceOf(AppError);
  });

  it("SessionError has SESSION_ERROR code", () => {
    const err = new SessionError("session gone");
    expect(err.code).toBe("SESSION_ERROR");
    expect(err.name).toBe("SessionError");
    expect(err).toBeInstanceOf(AppError);
  });

  it("SessionClosedError has SESSION_CLOSED code", () => {
    const err = new SessionClosedError("closed");
    expect(err.code).toBe("SESSION_CLOSED");
    expect(err.name).toBe("SessionClosedError");
    expect(err).toBeInstanceOf(AppError);
  });

  it("ManifestRegistrationError has MANIFEST_REJECTED code", () => {
    const err = new ManifestRegistrationError("bad manifest");
    expect(err.code).toBe("MANIFEST_REJECTED");
    expect(err.name).toBe("ManifestRegistrationError");
    expect(err).toBeInstanceOf(AppError);
  });

  it("ConversationKeyError has UNKNOWN_CONVERSATION_KEY code", () => {
    const err = new ConversationKeyError("bad-key");
    expect(err.code).toBe("UNKNOWN_CONVERSATION_KEY");
    expect(err.message).toContain("bad-key");
    expect(err.name).toBe("ConversationKeyError");
    expect(err).toBeInstanceOf(AppError);
  });

  it("SendError has SEND_FAILED code", () => {
    const err = new SendError("send failed");
    expect(err.code).toBe("SEND_FAILED");
    expect(err.name).toBe("SendError");
    expect(err).toBeInstanceOf(AppError);
  });
});
