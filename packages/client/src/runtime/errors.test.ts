import { describe, expect, it } from "vitest";
import {
  AgentNotFoundError,
  MalformedFrameError,
  NotConnectedError,
  RpcServerError,
  RpcTimeoutError,
} from "./errors.js";

describe("AgentNotFoundError", () => {
  it("carries agentName and derives a `_tag` + `message`", () => {
    const err = new AgentNotFoundError({ agentName: "foo" });
    expect(err._tag).toBe("AgentNotFoundError");
    expect(err.agentName).toBe("foo");
    expect(err.message).toBe("Agent not found: foo");
  });

  it("tag discriminates at the type level against sibling tagged errors", () => {
    const err: AgentNotFoundError | NotConnectedError = new AgentNotFoundError({
      agentName: "bar",
    });
    // Purely a runtime sanity check that the switch on _tag narrows.
    if (err._tag === "AgentNotFoundError") {
      expect(err.agentName).toBe("bar");
    } else {
      throw new Error("expected AgentNotFoundError");
    }
  });
});

describe("NotConnectedError", () => {
  it("carries message field and `_tag === 'NotConnectedError'`", () => {
    const err = new NotConnectedError({ message: "socket closed" });
    expect(err._tag).toBe("NotConnectedError");
    expect(err.message).toBe("socket closed");
  });
});

describe("RpcTimeoutError", () => {
  it("carries method + timeoutMs and `_tag === 'RpcTimeoutError'`", () => {
    const err = new RpcTimeoutError({
      method: "messages/send",
      timeoutMs: 30_000,
    });
    expect(err._tag).toBe("RpcTimeoutError");
    expect(err.method).toBe("messages/send");
    expect(err.timeoutMs).toBe(30_000);
  });
});

describe("RpcServerError", () => {
  it("carries code, message, and optional data", () => {
    const err = new RpcServerError({
      code: -32601,
      message: "method not found",
      data: { hint: "check spelling" },
    });
    expect(err._tag).toBe("RpcServerError");
    expect(err.code).toBe(-32601);
    expect(err.message).toBe("method not found");
    expect(err.data).toEqual({ hint: "check spelling" });
  });

  it("treats `data` as optional (undefined when omitted)", () => {
    const err = new RpcServerError({ code: -32603, message: "oops" });
    expect(err.data).toBeUndefined();
  });
});

describe("MalformedFrameError", () => {
  it("carries the raw payload and `_tag === 'MalformedFrameError'`", () => {
    const err = new MalformedFrameError({ raw: "not json" });
    expect(err._tag).toBe("MalformedFrameError");
    expect(err.raw).toBe("not json");
  });
});
