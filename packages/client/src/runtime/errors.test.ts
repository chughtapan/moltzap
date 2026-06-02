import { describe, expect, it } from "vitest";
import { AgentNotFoundError, MalformedFrameError } from "./errors.js";
import {
  MessagesSend,
  NotConnectedError,
  RpcTimeoutError,
} from "@moltzap/protocol";

const RPC_TIMEOUT_MS = 30_000;
const AGENT_NAME = "foo";
const OTHER_AGENT_NAME = "bar";
const AGENT_NOT_FOUND_TAG = "AgentNotFoundError";
const AGENT_NOT_FOUND_MESSAGE = "Agent not found: foo";
const NOT_CONNECTED_TAG = "NotConnectedError";
const SOCKET_CLOSED_MESSAGE = "socket closed";
const RPC_TIMEOUT_TAG = "RpcTimeoutError";
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

describe("MalformedFrameError", () => {
  it("carries the raw payload and `_tag === 'MalformedFrameError'`", () => {
    const err = new MalformedFrameError({ raw: MALFORMED_RAW_PAYLOAD });
    expect(err._tag).toBe(MALFORMED_FRAME_TAG);
    expect(err.raw).toBe(MALFORMED_RAW_PAYLOAD);
  });
});
