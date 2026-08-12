/**
 * @file Pins turn-ready subscription admission, retained POST framing,
 * single-reader ownership, publication, and teardown behavior.
 */
import {
  Client,
  fromJsonSchema,
  type JsonSchemaType,
  StreamableHTTPClientTransport,
  type SubscriptionFilter,
} from "@modelcontextprotocol/client";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  createMcpHandler,
  type Implementation,
  McpServer,
  PROTOCOL_VERSION_META_KEY,
  SERVER_INFO_META_KEY,
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
} from "./harness/index.js";

/* eslint-disable agent-code-guard/async-keyword -- These contract tests exercise the official Promise-native MCP client, handler, and retained response stream. */

const SERVER_IMPLEMENTATION = {
  name: "harness-subscription-test",
  version: "1.0.0",
} satisfies Implementation;
const SUBSCRIPTIONS_LISTEN_METHOD = "subscriptions/listen";
const SUBSCRIPTIONS_ACKNOWLEDGED_NOTIFICATION =
  "notifications/subscriptions/acknowledged";
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const DATA_FIELD = "data: ";
const EVENT_FIELD = "event:";
const ID_FIELD = "id:";
const RETRY_FIELD = "retry:";
const FRAME_END = "\n\n";
const SSE_CONTENT_TYPE = "text/event-stream";
const OK_STATUS = 200;
const BAD_REQUEST_STATUS = 400;
const CONFLICT_STATUS = 409;
const METHOD_NOT_ALLOWED_STATUS = 405;
const LOCAL_SUBSCRIPTION_CLOSE = "local";
const GRACEFUL_SUBSCRIPTION_CLOSE = "graceful";
const TURN_READY_FILTER: SubscriptionFilter & {
  readonly [HARNESS_TURN_READY_FILTER]: true;
} = {
  [HARNESS_TURN_READY_FILTER]: true,
};
const opaquePayloadSchema = fromJsonSchema<OpaquePayload>({
  type: "object",
  properties: {
    ordinal: { type: "number" },
    snapshot: {
      type: "object",
      properties: { opaque: { type: "string" } },
      required: ["opaque"],
    },
  },
  required: ["ordinal", "snapshot"],
  additionalProperties: true,
} satisfies JsonSchemaType);

interface OpaquePayload {
  readonly ordinal: number;
  readonly snapshot: {
    readonly opaque: string;
  };
}

const openHandlers = new Set<HarnessMcpSubscriptionHandler<OpaquePayload>>();

const makeHandler = () => {
  const delegate = createMcpHandler(
    () => new McpServer(SERVER_IMPLEMENTATION),
    { legacy: "reject" },
  );
  const handler = makeHarnessMcpSubscriptionHandler<OpaquePayload>({
    delegate,
    implementation: SERVER_IMPLEMENTATION,
  });
  openHandlers.add(handler);
  return { delegate, handler };
};

const getReader = (
  response: Response,
): ReadableStreamDefaultReader<Uint8Array> => {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new Error("expected retained SSE response body");
  }
  return reader;
};

interface ListenRequestOptions {
  readonly capability?: boolean;
  readonly signal?: AbortSignal;
  readonly notifications?: Readonly<Record<string, unknown>>;
}

const makeListenRequest = (
  id: string | number,
  options: ListenRequestOptions = {},
): Request => {
  const capabilities =
    options.capability === false
      ? {}
      : { extensions: { [HARNESS_EVENTS_EXTENSION]: {} } };
  return new Request("http://127.0.0.1/mcp", {
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
        notifications: options.notifications ?? {
          [HARNESS_TURN_READY_FILTER]: true,
        },
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
          [CLIENT_INFO_META_KEY]: {
            name: "harness-subscription-client",
            version: "1.0.0",
          },
          [CLIENT_CAPABILITIES_META_KEY]: capabilities,
        },
      },
    }),
    signal: options.signal,
  });
};

const readFrame = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
  const result = await reader.read();
  expect(result.done).toBe(false);
  const frame = new TextDecoder().decode(result.value);
  expect(frame.startsWith(DATA_FIELD)).toBe(true);
  expect(frame.endsWith(FRAME_END)).toBe(true);
  expect(frame).not.toContain(EVENT_FIELD);
  expect(frame).not.toContain(ID_FIELD);
  expect(frame).not.toContain(RETRY_FIELD);
  const parsed: unknown = JSON.parse(
    frame.slice(DATA_FIELD.length, -FRAME_END.length),
  );
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("expected JSON-RPC object frame");
  }
  return parsed;
};

const makeOfficialClient = async (
  handler: HarnessMcpSubscriptionHandler<OpaquePayload>,
  received: OpaquePayload[],
) => {
  const client = new Client(
    { name: "harness-subscription-client", version: "1.0.0" },
    {
      capabilities: { extensions: { [HARNESS_EVENTS_EXTENSION]: {} } },
      versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } },
    },
  );
  client.setNotificationHandler(
    HARNESS_TURN_READY_NOTIFICATION,
    { params: opaquePayloadSchema },
    (payload) => {
      received.push(payload);
    },
  );
  const transport = new StreamableHTTPClientTransport(
    new URL("http://127.0.0.1/mcp"),
    { fetch: (url, init) => handler.fetch(new Request(url, init)) },
  );
  await client.connect(transport);
  return client;
};

afterEach(async () => {
  for (const handler of openHandlers) {
    await handler.close();
  }
  openHandlers.clear();
});

// @agent-code-guard/regression-only: this finite matrix pins the retained SSE wire shape and official beta.5 client interoperability.
describe("Harness MCP subscription delegation", () => {
  it("delegates ordinary MCP requests to the official handler", async () => {
    const { delegate, handler } = makeHandler();
    const delegateFetch = vi.spyOn(delegate, "fetch");
    const response = await handler.fetch(
      new Request("http://127.0.0.1/mcp", { method: "GET" }),
    );

    expect(delegateFetch).toHaveBeenCalledOnce();
    expect(response.status).toBe(METHOD_NOT_ALLOWED_STATUS);
    expect(handler.notify).toBe(delegate.notify);
    expect(handler.bus).toBe(delegate.bus);
  });

  it("leaves non-custom subscription filters with the official handler", async () => {
    const { delegate, handler } = makeHandler();
    const delegateFetch = vi.spyOn(delegate, "fetch");
    const response = await handler.fetch(
      makeListenRequest("standard", {
        notifications: { toolsListChanged: true },
      }),
    );

    expect(delegateFetch).toHaveBeenCalledOnce();
    await response.body?.cancel();
  });
});

describe("Harness MCP subscription filter isolation", () => {
  it("leaves mixed extension and standard filters with the official handler", async () => {
    const { delegate, handler } = makeHandler();
    const delegateFetch = vi.spyOn(delegate, "fetch");
    const response = await handler.fetch(
      makeListenRequest("mixed", {
        notifications: {
          [HARNESS_TURN_READY_FILTER]: true,
          toolsListChanged: true,
        },
      }),
    );

    expect(delegateFetch).toHaveBeenCalledOnce();
    await response.body?.cancel();
  });

  it("leaves malformed additional filters with the official handler", async () => {
    const { delegate, handler } = makeHandler();
    const delegateFetch = vi.spyOn(delegate, "fetch");
    const response = await handler.fetch(
      makeListenRequest("malformed-additional", {
        notifications: {
          [HARNESS_TURN_READY_FILTER]: true,
          toolsListChanged: "invalid",
        },
      }),
    );

    expect(delegateFetch).toHaveBeenCalledOnce();
    await response.body?.cancel();
  });
});

describe("Harness MCP subscription parsed-body isolation", () => {
  it("delegates when the extension filter is inherited", async () => {
    const { delegate, handler } = makeHandler();
    const delegateFetch = vi.spyOn(delegate, "fetch");
    class NotificationsWithInheritedExtension {
      readonly toolsListChanged = true;

      get [HARNESS_TURN_READY_FILTER](): true {
        return true;
      }
    }
    const notifications = new NotificationsWithInheritedExtension();
    const response = await handler.fetch(makeListenRequest("prototype"), {
      parsedBody: {
        jsonrpc: "2.0",
        id: "prototype",
        method: SUBSCRIPTIONS_LISTEN_METHOD,
        params: {
          notifications,
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
            [CLIENT_INFO_META_KEY]: {
              name: "harness-subscription-client",
              version: "1.0.0",
            },
            [CLIENT_CAPABILITIES_META_KEY]: {
              extensions: { [HARNESS_EVENTS_EXTENSION]: {} },
            },
          },
        },
      },
    });

    expect(delegateFetch).toHaveBeenCalledOnce();
    await response.body?.cancel();
  });
});

describe("Harness MCP subscription framing", () => {
  it("acknowledges first and publishes complete typed notification frames", async () => {
    const { handler } = makeHandler();
    const response = await handler.fetch(makeListenRequest("listen-7"));
    const reader = getReader(response);

    expect(response.status).toBe(OK_STATUS);
    expect(response.headers.get("content-type")).toBe(SSE_CONTENT_TYPE);
    expect(await readFrame(reader)).toEqual({
      jsonrpc: "2.0",
      method: SUBSCRIPTIONS_ACKNOWLEDGED_NOTIFICATION,
      params: {
        notifications: { [HARNESS_TURN_READY_FILTER]: true },
        _meta: { [SUBSCRIPTION_ID_META_KEY]: "listen-7" },
      },
    });

    expect(
      handler.publish({ ordinal: 3, snapshot: { opaque: "caller-owned" } }),
    ).toBe(true);
    expect(await readFrame(reader)).toEqual({
      jsonrpc: "2.0",
      method: HARNESS_TURN_READY_NOTIFICATION,
      params: {
        ordinal: 3,
        snapshot: { opaque: "caller-owned" },
        _meta: { [SUBSCRIPTION_ID_META_KEY]: "listen-7" },
      },
    });
    await reader.cancel();
  });
});

describe("Harness MCP subscription admission", () => {
  it("atomically refuses a racing turn-ready listener", async () => {
    const { handler } = makeHandler();
    const first = await handler.fetch(makeListenRequest(1));
    const raced = await handler.fetch(makeListenRequest(2));

    expect(raced.status).toBe(CONFLICT_STATUS);
    expect(await raced.json()).toEqual({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Turn-ready subscription already in use",
        data: { kind: "subscription_in_use" },
      },
      id: 2,
    });

    await first.body?.cancel();
    const replacement = await handler.fetch(makeListenRequest(3));
    expect(replacement.status).toBe(OK_STATUS);
    await replacement.body?.cancel();
  });

  it("uses the core missing-capability error before acquiring SSE", async () => {
    const { handler } = makeHandler();
    const response = await handler.fetch(
      makeListenRequest("missing-capability", { capability: false }),
    );

    expect(response.status).toBe(BAD_REQUEST_STATUS);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      error: {
        code: -32021,
        message: "Missing required client capabilities: extensions",
        data: {
          requiredCapabilities: {
            extensions: { [HARNESS_EVENTS_EXTENSION]: {} },
          },
        },
      },
      id: "missing-capability",
    });
  });
});

describe("Harness MCP subscription disconnect", () => {
  it("cleans up a disconnected listener without a terminal frame", async () => {
    const { handler } = makeHandler();
    const abort = new AbortController();
    const response = await handler.fetch(
      makeListenRequest("disconnect", { signal: abort.signal }),
    );
    const reader = getReader(response);
    await readFrame(reader);

    abort.abort();
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(handler.publish({ ordinal: 4, snapshot: { opaque: "late" } })).toBe(
      false,
    );

    const replacement = await handler.fetch(makeListenRequest("replacement"));
    expect(replacement.status).toBe(OK_STATUS);
    await replacement.body?.cancel();
  });
});

describe("Harness MCP subscription graceful close", () => {
  it("gracefully completes the retained response when the handler closes", async () => {
    const { handler } = makeHandler();
    const response = await handler.fetch(makeListenRequest("close-me"));
    const reader = getReader(response);
    await readFrame(reader);

    await handler.close();
    expect(await readFrame(reader)).toEqual({
      jsonrpc: "2.0",
      id: "close-me",
      result: {
        resultType: "complete",
        _meta: {
          [SUBSCRIPTION_ID_META_KEY]: "close-me",
          [SERVER_INFO_META_KEY]: SERVER_IMPLEMENTATION,
        },
      },
    });
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(handler.publish({ ordinal: 5, snapshot: { opaque: "late" } })).toBe(
      false,
    );
  });
});

describe("Harness MCP subscription official client interop", () => {
  it("interoperates with the official client listen lifecycle", async () => {
    const { handler } = makeHandler();
    const received: OpaquePayload[] = [];
    const client = await makeOfficialClient(handler, received);

    try {
      const first = await client.listen(TURN_READY_FILTER);
      expect(first).toBeDefined();

      const payload = {
        ordinal: 8,
        snapshot: { opaque: "official-client" },
      } satisfies OpaquePayload;
      expect(handler.publish(payload)).toBe(true);
      await vi.waitFor(() => {
        expect(received).toHaveLength(1);
        expect(received[0]).toMatchObject(payload);
      });

      await first.close();
      expect(await first.closed).toBe(LOCAL_SUBSCRIPTION_CLOSE);
      const replacement = await client.listen(TURN_READY_FILTER);
      await handler.close();
      expect(await replacement.closed).toBe(GRACEFUL_SUBSCRIPTION_CLOSE);
    } finally {
      await client.close();
    }
  });
});

/* eslint-enable agent-code-guard/async-keyword -- Restore repository defaults after the Promise-native MCP contract tests. */
