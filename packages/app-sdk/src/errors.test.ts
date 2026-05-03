import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import {
  AppDisconnected,
  AppHandlerError,
  AdmissionTimeoutError,
  AttachAlreadyAttachedError,
  AttachConversationNotFoundError,
  AttachFailedError,
  AttachNotAuthorizedError,
  AttachSessionNotFoundError,
  AuthError,
  ConversationKeyError,
  DuplicateHookHandlerError,
  InvalidConfigError,
  ManifestRegistrationError,
  SendError,
  SessionClosedError,
  SessionError,
  UserHandlerError,
} from "./errors.js";

import {
  AppsOnBeforeDispatch,
  AppsOnBeforeMessageDelivery,
  AppsOnJoin,
} from "@moltzap/protocol";

describe("app SDK tagged errors", () => {
  it("stores message and cause on plain SDK errors", () => {
    const cause = new Error("original");
    const err = new InvalidConfigError({ message: "bad config", cause });
    expect(err._tag).toBe("InvalidConfigError");
    expect(err.message).toBe("bad config");
    expect(err.cause).toBe(cause);
    expect(err).toBeInstanceOf(Error);
  });

  it("discriminates domain errors with Effect.catchTag", async () => {
    const recovered = await Effect.runPromise(
      Effect.fail(new AuthError({ message: "bad creds" })).pipe(
        Effect.catchTag("AuthError", (err) => Effect.succeed(err.message)),
      ),
    );
    expect(recovered).toBe("bad creds");
  });

  it("keeps contextual fields on structured errors", () => {
    expect(
      new ConversationKeyError({
        key: "typo-key",
        message: 'Unknown conversation key: "typo-key"',
      }).key,
    ).toBe("typo-key");
    expect(
      new AppHandlerError({
        method: AppsOnBeforeDispatch.name,
        message: "handler failed",
      }).method,
    ).toBe(AppsOnBeforeDispatch.name);
    expect(
      new AdmissionTimeoutError({
        method: AppsOnJoin.name,
        timeoutMs: 30_000,
        message: "timeout",
      }).timeoutMs,
    ).toBe(30_000);
  });

  it("exposes attach failure variants as tags", () => {
    const errors = [
      new AttachSessionNotFoundError({ message: "session missing" }),
      new AttachConversationNotFoundError({ message: "conversation missing" }),
      new AttachNotAuthorizedError({ message: "not authorized" }),
      new AttachAlreadyAttachedError({ message: "already attached" }),
      new AttachFailedError({ message: "transport failed" }),
    ];
    expect(errors.map((err) => err._tag)).toEqual([
      "AttachSessionNotFoundError",
      "AttachConversationNotFoundError",
      "AttachNotAuthorizedError",
      "AttachAlreadyAttachedError",
      "AttachFailedError",
    ]);
  });

  it("has stable tags for all exported SDK errors", () => {
    expect(
      new DuplicateHookHandlerError({
        method: AppsOnJoin.name,
        message: "duplicate",
      })._tag,
    ).toBe("DuplicateHookHandlerError");
    expect(
      new UserHandlerError({
        message: "handler threw",
        cause: new Error("boom"),
      })._tag,
    ).toBe("UserHandlerError");
    expect(new SessionError({ message: "session failed" })._tag).toBe(
      "SessionError",
    );
    expect(new SessionClosedError({ message: "closed" })._tag).toBe(
      "SessionClosedError",
    );
    expect(
      new ManifestRegistrationError({ message: "manifest rejected" })._tag,
    ).toBe("ManifestRegistrationError");
    expect(new SendError({ message: "send failed" })._tag).toBe("SendError");
    expect(
      new AppDisconnected({
        method: AppsOnBeforeMessageDelivery.name,
        message: "disconnected",
      })._tag,
    ).toBe("AppDisconnected");
  });
});
