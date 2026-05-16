import { describe, expect, it } from "vitest";
import { AgentNotFoundError, MalformedFrameError } from "./errors.js";
import {
  MessagesSend,
  NotConnectedError,
  RpcServerError,
  RpcTimeoutError,
} from "@moltzap/protocol";

const RPC_TIMEOUT_MS = 30_000;
const METHOD_NOT_FOUND_CODE = -32601;
const INTERNAL_ERROR_CODE = -32603;
const AGENT_NAME = "foo";
const OTHER_AGENT_NAME = "bar";
const AGENT_NOT_FOUND_TAG = "AgentNotFoundError";
const AGENT_NOT_FOUND_MESSAGE = "Agent not found: foo";
const NOT_CONNECTED_TAG = "NotConnectedError";
const SOCKET_CLOSED_MESSAGE = "socket closed";
const RPC_TIMEOUT_TAG = "RpcTimeoutError";
const RPC_SERVER_TAG = "RpcServerError";
const METHOD_NOT_FOUND_MESSAGE = "method not found";
const RPC_SERVER_HINT = "check spelling";
const MALFORMED_FRAME_TAG = "MalformedFrameError";
const MALFORMED_RAW_PAYLOAD = "not json";

describe("AgentNotFoundError", () => {
  it("carries agentName and derives a `_tag` + `message`", () => {
    const err = new AgentNotFoundError({ agentName: AGENT_NAME });
    expect(err._tag).toBe(AGENT_NOT_FOUND_TAG);
    expect(err.agentName).toBe(AGENT_NAME);
    expect(err.message).toBe(AGENT_NOT_FOUND_MESSAGE);
  });

  it("tag discriminates at the type level against sibling tagged errors", () => {
    const err: AgentNotFoundError | NotConnectedError = new AgentNotFoundError({
      agentName: OTHER_AGENT_NAME,
    });
    expect(err).toBeInstanceOf(AgentNotFoundError);
    expect(err.agentName).toBe(OTHER_AGENT_NAME);
  });
});

describe("NotConnectedError", () => {
  it("carries message field and `_tag === 'NotConnectedError'`", () => {
    const err = new NotConnectedError({ message: SOCKET_CLOSED_MESSAGE });
    expect(err._tag).toBe(NOT_CONNECTED_TAG);
    expect(err.message).toBe(SOCKET_CLOSED_MESSAGE);
  });
});

describe("RpcTimeoutError", () => {
  it("carries method + timeoutMs and `_tag === 'RpcTimeoutError'`", () => {
    const err = new RpcTimeoutError({
      method: MessagesSend.name,
      timeoutMs: RPC_TIMEOUT_MS,
    });
    expect(err._tag).toBe(RPC_TIMEOUT_TAG);
    expect(err.method).toBe(MessagesSend.name);
    expect(err.timeoutMs).toBe(RPC_TIMEOUT_MS);
  });
});

describe("RpcServerError", () => {
  it("carries code, message, and optional data", () => {
    const err = new RpcServerError({
      code: METHOD_NOT_FOUND_CODE,
      message: METHOD_NOT_FOUND_MESSAGE,
      data: { hint: RPC_SERVER_HINT },
    });
    expect(err._tag).toBe(RPC_SERVER_TAG);
    expect(err.code).toBe(METHOD_NOT_FOUND_CODE);
    expect(err.message).toBe(METHOD_NOT_FOUND_MESSAGE);
    expect(err.data).toEqual({ hint: RPC_SERVER_HINT });
  });

  it("treats `data` as optional (undefined when omitted)", () => {
    const err = new RpcServerError({
      code: INTERNAL_ERROR_CODE,
      message: "oops",
    });
    expect(err.data).toBeUndefined();
  });
});

describe("MalformedFrameError", () => {
  it("carries the raw payload and `_tag === 'MalformedFrameError'`", () => {
    const err = new MalformedFrameError({ raw: MALFORMED_RAW_PAYLOAD });
    expect(err._tag).toBe(MALFORMED_FRAME_TAG);
    expect(err.raw).toBe(MALFORMED_RAW_PAYLOAD);
  });
});
