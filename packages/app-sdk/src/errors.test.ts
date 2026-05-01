import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import {
  AppError,
  AuthError,
  SessionError,
  SessionClosedError,
  ManifestRegistrationError,
  ConversationKeyError,
  SendError,
  AppHandlerError,
  AdmissionTimeoutError,
  AppDisconnected,
  AttachError,
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

// `Effect.catchTag` discriminates on `_tag`. The 10 error subclasses each
// carry a `readonly _tag = "<ClassName>" as const`, so the @example blocks
// in `errors.ts` that pipe failures through `Effect.catchTag` actually
// catch at runtime. This block is the runtime proof: each test fails the
// effect with one error class, catches the matching tag, and asserts the
// recovery handler ran exactly once. If a subclass loses its `_tag`, the
// catchTag silently misses → the recovery never runs → the test fails.
describe("error _tag discrimination via Effect.catchTag", () => {
  it("AuthError is caught by catchTag('AuthError')", async () => {
    const recovered = await Effect.runPromise(
      Effect.fail(new AuthError("bad creds")).pipe(
        Effect.catchTag("AuthError", (err) => Effect.succeed(err.code)),
      ),
    );
    expect(recovered).toBe("AUTH_FAILED");
  });

  it("SessionError is caught by catchTag('SessionError')", async () => {
    const recovered = await Effect.runPromise(
      Effect.fail(new SessionError("gone")).pipe(
        Effect.catchTag("SessionError", (err) => Effect.succeed(err.code)),
      ),
    );
    expect(recovered).toBe("SESSION_ERROR");
  });

  it("SessionClosedError is caught by catchTag('SessionClosedError')", async () => {
    const recovered = await Effect.runPromise(
      Effect.fail(new SessionClosedError("closed")).pipe(
        Effect.catchTag("SessionClosedError", (err) =>
          Effect.succeed(err.code),
        ),
      ),
    );
    expect(recovered).toBe("SESSION_CLOSED");
  });

  it("ManifestRegistrationError is caught by catchTag('ManifestRegistrationError')", async () => {
    const recovered = await Effect.runPromise(
      Effect.fail(new ManifestRegistrationError("bad manifest")).pipe(
        Effect.catchTag("ManifestRegistrationError", (err) =>
          Effect.succeed(err.code),
        ),
      ),
    );
    expect(recovered).toBe("MANIFEST_REJECTED");
  });

  it("ConversationKeyError is caught by catchTag('ConversationKeyError')", async () => {
    const recovered = await Effect.runPromise(
      Effect.fail(new ConversationKeyError("typo-key")).pipe(
        Effect.catchTag("ConversationKeyError", (err) =>
          Effect.succeed(err.code),
        ),
      ),
    );
    expect(recovered).toBe("UNKNOWN_CONVERSATION_KEY");
  });

  it("SendError is caught by catchTag('SendError')", async () => {
    const recovered = await Effect.runPromise(
      Effect.fail(new SendError("send failed")).pipe(
        Effect.catchTag("SendError", (err) => Effect.succeed(err.code)),
      ),
    );
    expect(recovered).toBe("SEND_FAILED");
  });

  it("AppHandlerError is caught by catchTag('AppHandlerError')", async () => {
    const recovered = await Effect.runPromise(
      Effect.fail(
        new AppHandlerError("apps/onBeforeDispatch", "user threw"),
      ).pipe(
        Effect.catchTag("AppHandlerError", (err) => Effect.succeed(err.method)),
      ),
    );
    expect(recovered).toBe("apps/onBeforeDispatch");
  });

  it("AdmissionTimeoutError is caught by catchTag('AdmissionTimeoutError')", async () => {
    const recovered = await Effect.runPromise(
      Effect.fail(
        new AdmissionTimeoutError("apps/onBeforeDispatch", 30_000),
      ).pipe(
        Effect.catchTag("AdmissionTimeoutError", (err) =>
          Effect.succeed(err.timeoutMs),
        ),
      ),
    );
    expect(recovered).toBe(30_000);
  });

  it("AppDisconnected is caught by catchTag('AppDisconnected')", async () => {
    const recovered = await Effect.runPromise(
      Effect.fail(new AppDisconnected("apps/onBeforeMessageDelivery")).pipe(
        Effect.catchTag("AppDisconnected", (err) => Effect.succeed(err.method)),
      ),
    );
    expect(recovered).toBe("apps/onBeforeMessageDelivery");
  });

  it("AttachError is caught by catchTag('AttachError')", async () => {
    const recovered = await Effect.runPromise(
      Effect.fail(new AttachError("SessionNotFound", "session is gone")).pipe(
        Effect.catchTag("AttachError", (err) => Effect.succeed(err.code)),
      ),
    );
    expect(recovered).toBe("SessionNotFound");
  });

  // Belt-and-suspenders: the literal `_tag` field on each instance must
  // equal the class name. catchTag is a thin wrapper over this property,
  // but a direct assertion catches any future drift (e.g. a copy-paste
  // bug where two classes share the same `_tag`).
  it("each error class exposes a _tag matching its class name", () => {
    expect(new AuthError("x")._tag).toBe("AuthError");
    expect(new SessionError("x")._tag).toBe("SessionError");
    expect(new SessionClosedError("x")._tag).toBe("SessionClosedError");
    expect(new ManifestRegistrationError("x")._tag).toBe(
      "ManifestRegistrationError",
    );
    expect(new ConversationKeyError("x")._tag).toBe("ConversationKeyError");
    expect(new SendError("x")._tag).toBe("SendError");
    expect(new AppHandlerError("apps/onJoin", "x")._tag).toBe(
      "AppHandlerError",
    );
    expect(new AdmissionTimeoutError("apps/onJoin", 1)._tag).toBe(
      "AdmissionTimeoutError",
    );
    expect(new AppDisconnected("apps/onJoin")._tag).toBe("AppDisconnected");
    expect(new AttachError("SessionNotFound", "x")._tag).toBe("AttachError");
  });
});
