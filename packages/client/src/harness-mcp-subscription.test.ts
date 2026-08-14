/**
 * @file Pins the sole turn listener's admission, acknowledgment, framing, and
 * lifecycle so attention cannot be offered before an active subscription.
 */

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  createMcpHandler,
  type Implementation,
  McpServer,
  PROTOCOL_VERSION_META_KEY,
  SUBSCRIPTION_ID_META_KEY,
} from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type HarnessMcpSubscriptionHandler,
  makeHarnessMcpSubscriptionHandler,
} from "./harness-mcp-subscription.js";
import {
  HARNESS_EVENTS_EXTENSION,
  HARNESS_TURN_READY_FILTER,
  HARNESS_TURN_READY_NOTIFICATION,
} from "./harness-runtime.js";

/* eslint-disable agent-code-guard/async-keyword, agent-code-guard/promise-type -- These interoperability tests exercise the official Promise-native MCP handler and retained response stream. */

const SUBSCRIPTIONS_LISTEN_METHOD = "subscriptions/listen";
const SUBSCRIPTIONS_ACKNOWLEDGED_NOTIFICATION =
  "notifications/subscriptions/acknowledged";
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const OK_STATUS = 200;
const CONFLICT_STATUS = 409;
const TURN_READY_NOTIFICATIONS = {
  [HARNESS_TURN_READY_FILTER]: true,
};
const SERVER_IMPLEMENTATION = {
  name: "harness-subscription-test",
  version: "1.0.0",
} satisfies Implementation;

interface TestPayload {
  readonly value: string;
}

const openHandlers = new Set<HarnessMcpSubscriptionHandler<TestPayload>>();

const makeHandler = (onActiveChange?: (active: boolean) => void) => {
  const delegate = createMcpHandler(
    () => new McpServer(SERVER_IMPLEMENTATION),
    { legacy: "reject" },
  );
  const handler = makeHarnessMcpSubscriptionHandler<TestPayload>({
    delegate,
    implementation: SERVER_IMPLEMENTATION,
    onActiveChange,
  });
  openHandlers.add(handler);
  return { delegate, handler };
};

const makeListenRequest = (
  id: string | number,
  notifications: Readonly<Record<string, unknown>> = TURN_READY_NOTIFICATIONS,
): Request =>
  new Request("http://127.0.0.1/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-method": SUBSCRIPTIONS_LISTEN_METHOD,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: SUBSCRIPTIONS_LISTEN_METHOD,
      params: {
        notifications,
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
          [CLIENT_INFO_META_KEY]: {
            name: "harness-subscription-test-client",
            version: "1.0.0",
          },
          [CLIENT_CAPABILITIES_META_KEY]: {
            extensions: { [HARNESS_EVENTS_EXTENSION]: {} },
          },
        },
      },
    }),
  });

const readFrame = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<unknown> => {
  const result = await reader.read();
  if (result.done || result.value === undefined) {
    throw new Error("expected a complete SSE data frame");
  }
  const frame = new TextDecoder().decode(result.value);
  expect(frame.startsWith("data: ")).toBe(true);
  expect(frame.endsWith("\n\n")).toBe(true);
  return JSON.parse(frame.slice("data: ".length, -"\n\n".length));
};

const responseReader = (
  response: Response,
): ReadableStreamDefaultReader<Uint8Array> => {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new Error("expected retained SSE response body");
  }
  return reader;
};

afterEach(async () => {
  for (const handler of openHandlers) {
    await handler.close();
  }
  openHandlers.clear();
});

const delegatesNonTurnSubscription = async () => {
  const { delegate, handler } = makeHandler();
  const delegated = vi.spyOn(delegate, "fetch");
  const response = await handler.fetch(
    makeListenRequest("ordinary", { toolsListChanged: true }),
  );

  expect(delegated).toHaveBeenCalledOnce();
  await response.body?.cancel();
};

const acknowledgesBeforePublication = async () => {
  const activeChanges: boolean[] = [];
  const { handler } = makeHandler((active) => activeChanges.push(active));
  const response = await handler.fetch(makeListenRequest("listener-1"));
  const reader = responseReader(response);

  expect(await readFrame(reader)).toEqual({
    jsonrpc: "2.0",
    method: SUBSCRIPTIONS_ACKNOWLEDGED_NOTIFICATION,
    params: {
      notifications: TURN_READY_NOTIFICATIONS,
      _meta: { [SUBSCRIPTION_ID_META_KEY]: "listener-1" },
    },
  });
  expect(activeChanges).toEqual([true]);
  expect(handler.hasActiveSubscription()).toBe(true);
  expect(handler.publish({ value: "certified-turn" })).toBe(true);
  expect(await readFrame(reader)).toEqual({
    jsonrpc: "2.0",
    method: HARNESS_TURN_READY_NOTIFICATION,
    params: {
      value: "certified-turn",
      _meta: { [SUBSCRIPTION_ID_META_KEY]: "listener-1" },
    },
  });

  await reader.cancel();
  expect(activeChanges).toEqual([true, false]);
  expect(handler.hasActiveSubscription()).toBe(false);
};

const refusesRacingListener = async () => {
  const { handler } = makeHandler();
  const first = await handler.fetch(makeListenRequest(1));
  const raced = await handler.fetch(makeListenRequest(2));

  expect(raced.status).toBe(CONFLICT_STATUS);
  expect(await raced.json()).toEqual({
    jsonrpc: "2.0",
    error: {
      code: -32_000,
      message: "Subscription already active",
      data: { reason: "subscription-in-use" },
    },
    id: 2,
  });

  await first.body?.cancel();
  const replacement = await handler.fetch(makeListenRequest(3));
  expect(replacement.status).toBe(OK_STATUS);
  await replacement.body?.cancel();
};

// @agent-code-guard/regression-only: this finite matrix pins the one retained response stream and its attention-ownership boundary.
describe("Harness MCP turn subscription", () => {
  it("delegates every non-turn subscription to the official handler", () =>
    delegatesNonTurnSubscription());
  it("acknowledges before publishing one complete turn frame", () =>
    acknowledgesBeforePublication());
  it("atomically refuses a second listener until the owner detaches", () =>
    refusesRacingListener());
});

/* eslint-enable agent-code-guard/async-keyword, agent-code-guard/promise-type -- Restore repository defaults after the Promise-native test boundary. */
