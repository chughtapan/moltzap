import { describe, it, expect } from "vitest";
import { AppSessionHandle } from "./session.js";
import { ConversationKeyError } from "./errors.js";

describe("AppSessionHandle", () => {
  const makeHandle = (
    overrides?: Partial<ConstructorParameters<typeof AppSessionHandle>[0]>,
  ) =>
    new AppSessionHandle({
      id: "session-1",
      appId: "test-app",
      status: "active",
      conversations: {
        main: "conv-1",
        sidebar: "conv-2",
      },
      ...overrides,
    });

  it("exposes session properties", () => {
    const handle = makeHandle();
    expect(handle.id).toBe("session-1");
    expect(handle.appId).toBe("test-app");
    expect(handle.status).toBe("active");
  });

  it("resolves conversation key to ID", () => {
    const handle = makeHandle();
    expect(handle.conversationId("main")).toBe("conv-1");
    expect(handle.conversationId("sidebar")).toBe("conv-2");
  });

  it("throws ConversationKeyError for unknown key", () => {
    const handle = makeHandle();
    expect(() => handle.conversationId("unknown")).toThrow(
      ConversationKeyError,
    );
  });

  it("isActive returns true for active status", () => {
    expect(makeHandle({ status: "active" }).isActive).toBe(true);
  });

  it("isActive returns false for non-active status", () => {
    expect(makeHandle({ status: "waiting" }).isActive).toBe(false);
    expect(makeHandle({ status: "closed" }).isActive).toBe(false);
    expect(makeHandle({ status: "failed" }).isActive).toBe(false);
  });
});
