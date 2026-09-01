/**
 * @file Pins the sole message listener's admission, acknowledgment, framing, and
 * lifecycle so delivery cannot be offered before an active subscription.
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
  HARNESS_EVENTS_EXTENSION,
  HARNESS_MESSAGE_READY_FILTER,
  HARNESS_MESSAGE_READY_NOTIFICATION,
} from "./harness-mcp-contract.js";
import {
  type HarnessMcpSubscriptionHandler,
  makeHarnessMcpSubscriptionHandler,
} from "./harness-mcp-subscription.js";

/* eslint-disable agent-code-guard/async-keyword, agent-code-guard/promise-type -- These interoperability tests exercise the official Promise-native MCP handler and retained response stream. */

const SUBSCRIPTIONS_LISTEN_METHOD = "subscriptions/listen";
const SUBSCRIPTIONS_ACKNOWLEDGED_NOTIFICATION =
  "notifications/subscriptions/acknowledged";
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const BAD_REQUEST_STATUS = 400;
const OK_STATUS = 200;
const CONFLICT_STATUS = 409;
const MESSAGE_READY_NOTIFICATIONS = {
  [HARNESS_MESSAGE_READY_FILTER]: true,
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
  notifications: Readonly<
    Record<string, unknown>
  > = MESSAGE_READY_NOTIFICATIONS,
  extension: unknown = {},
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
            experimental: { [HARNESS_EVENTS_EXTENSION]: extension },
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

const delegatesNonMessageSubscription = async () => {
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
      notifications: MESSAGE_READY_NOTIFICATIONS,
      _meta: { [SUBSCRIPTION_ID_META_KEY]: "listener-1" },
    },
  });
  expect(activeChanges).toEqual([true]);
  expect(handler.hasActiveSubscription()).toBe(true);
  expect(handler.publish({ value: "certified-message" })).toBe(true);
  expect(await readFrame(reader)).toEqual({
    jsonrpc: "2.0",
    method: HARNESS_MESSAGE_READY_NOTIFICATION,
    params: {
      value: "certified-message",
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
      data: { reason: "already-listening" },
    },
    id: 2,
  });

  await first.body?.cancel();
  const replacement = await handler.fetch(makeListenRequest(3));
  expect(replacement.status).toBe(OK_STATUS);
  await replacement.body?.cancel();
};

const rejectsNonemptyEventsCapability = async () => {
  const { handler } = makeHandler();
  const response = await handler.fetch(
    makeListenRequest("legacy-capability", MESSAGE_READY_NOTIFICATIONS, {
      version: 2,
    }),
  );

  expect(response.status).toBe(BAD_REQUEST_STATUS);
  expect(await response.json()).toMatchObject({
    error: {
      data: {
        requiredCapabilities: {
          experimental: { [HARNESS_EVENTS_EXTENSION]: {} },
        },
      },
    },
  });
};

// @agent-code-guard/regression-only: this finite matrix pins the one retained response stream and its delivery-ownership boundary.
describe("Harness MCP message subscription", () => {
  it("delegates every non-message subscription to the official handler", () =>
    delegatesNonMessageSubscription());
  it("acknowledges before publishing one complete message frame", () =>
    acknowledgesBeforePublication());
  it("atomically refuses a second listener until the owner detaches", () =>
    refusesRacingListener());
  it("rejects a nonempty events-v2 capability declaration", () =>
    rejectsNonemptyEventsCapability());
});

/* eslint-enable agent-code-guard/async-keyword, agent-code-guard/promise-type -- Restore repository defaults after the Promise-native test boundary. */
