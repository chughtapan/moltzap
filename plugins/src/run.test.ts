/** @file Remote composition accepts native handoff before Client acknowledgement and fails closed on configuration. */

import type * as MoltZapClient from "@moltzap/client";
import { FileSystem, HttpClient, HttpClientResponse } from "@effect/platform";
import {
  acquireHarnessEndpoint,
  type HarnessEndpoint,
  type InboundDelivery,
  InboundItem,
} from "@moltzap/client";
import { ConfigProvider, Effect, Redacted, Schema, Stream } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runNativePlugin } from "./run.js";

// eslint-disable-next-line agent-code-guard/async-keyword -- Vitest's hoisted Promise-native mock factory runs before Effect's import binding initializes; no runtime operation or lifetime crosses this test-only boundary.
vi.mock("@moltzap/client", async (importOriginal) => ({
  ...(await importOriginal<typeof MoltZapClient>()),
  acquireHarnessEndpoint: vi.fn(),
}));

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- Handoff ordering, one-grant configuration and closed errors are acceptance-contract expectations. */

const eventId = "evt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const runtimeGrant = "one-runtime-grant-shared-with-model-000001";
const providerKey = "separate-native-provider-key-000001";
const item = Schema.decodeUnknownSync(InboundItem)({
  kind: "operationFailed",
  id: "col_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  to: "agent:bob",
  error: "fixture work",
});
const settings = {
  MOLTZAP_MCP_URL: "http://127.0.0.1:4319/mcp",
  MOLTZAP_MCP_CREDENTIAL_FILE: "/protected/runtime-grant",
  MOLTZAP_NATIVE_WEBHOOK_URL: "https://native.example/events",
  MOLTZAP_NATIVE_WEBHOOK_PORT: "4318",
  MOLTZAP_AGENTMAIL_KEY_FILE: "/protected/provider-key",
  MOLTZAP_AGENTMAIL_INBOX_ID: "dedicated@agentmail.to",
  MOLTZAP_INSTINCT_EMAIL: "native@instinct.example",
  MOLTZAP_GROK_ROUTINE_URL: "https://native.example/approved-routine",
  MOLTZAP_GROK_ROUTINE_KEY_FILE: "/protected/provider-key",
};

beforeEach(() => {
  vi.mocked(acquireHarnessEndpoint).mockReset();
});

describe("remote native receive composition", () => {
  it.each(["instinct", "grokbot"] as const)(
    "acknowledges %s only after the provider accepts, without sending a peer message",
    acceptsBeforeAcknowledging,
  );
  it.each(["instinct", "grokbot"] as const)(
    "delegates %s readiness to Client's opened webhook before work acceptance",
    signalsAuthenticatedReadiness,
  );
  it.each(["instinct", "grokbot"] as const)(
    "retains %s unread work if the provider refuses",
    retainsRefusedWork,
  );
  it.each([
    { change: { MOLTZAP_MCP_CREDENTIAL_FILE: undefined } },
    { change: { MOLTZAP_NATIVE_PLATFORM: "unknown" } },
  ])(
    "refuses incomplete native configuration before Client acquisition",
    refusesConfiguration,
  );
  it.each([
    { bytes: new Uint8Array([255]) },
    { bytes: new TextEncoder().encode(`${runtimeGrant}\n`) },
    { bytes: new Uint8Array() },
  ])(
    "requires exact credential bytes and never falls back to trusted-local MCP",
    refusesCredential,
  );
});

function signalsAuthenticatedReadiness(platform: "instinct" | "grokbot") {
  const phases: string[] = [];
  const endpoint = configuredEndpoint(phases);
  vi.mocked(acquireHarnessEndpoint).mockImplementation((url, options) =>
    Effect.sync(() => {
      expect(url).toEqual(new URL(settings.MOLTZAP_MCP_URL));
      phases.push("authenticated-client-acquired");
      const delivery = options?.delivery;
      const ready = typeof delivery === "object" ? delivery.onReady : undefined;
      return {
        ...endpoint,
        messages: Stream.unwrap(
          (ready ?? Effect.void).pipe(Effect.as(endpoint.messages)),
        ),
      };
    }),
  );
  return configuredRun(
    providerClient(phases, 200),
    { ...settings, MOLTZAP_NATIVE_PLATFORM: platform },
    secretFiles(),
    runNativePlugin(
      Effect.sync(() => {
        phases.push("host-ready");
      }),
    ),
  ).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        expect(phases).toEqual([
          "authenticated-client-acquired",
          "host-ready",
          "provider-accepted",
          "client-acknowledged",
        ]);
        expect(endpoint.send).not.toHaveBeenCalled();
      }),
    ),
    Effect.runPromise,
  );
}

function acceptsBeforeAcknowledging(platform: "instinct" | "grokbot") {
  const phases: string[] = [];
  const endpoint = configuredEndpoint(phases);
  return configuredRun(
    providerClient(phases, 200),
    { ...settings, MOLTZAP_NATIVE_PLATFORM: platform },
    secretFiles(),
    runNativePlugin(),
  ).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        expect(phases).toEqual(["provider-accepted", "client-acknowledged"]);
        expect(endpoint.send).not.toHaveBeenCalled();
        const call = vi.mocked(acquireHarnessEndpoint).mock.calls[0];
        expect(call?.[0]).toEqual(new URL(settings.MOLTZAP_MCP_URL));
        expect(call?.[1]?.delivery).toEqual({
          mode: "webhook",
          url: settings.MOLTZAP_NATIVE_WEBHOOK_URL,
          port: 4318,
        });
        expect(
          call?.[1]?.credential && Redacted.value(call[1].credential),
        ).toBe(runtimeGrant);
        expect(JSON.stringify(call?.[1])).not.toContain(runtimeGrant);
        expect(acquireHarnessEndpoint).toHaveBeenCalledTimes(1);
      }),
    ),
    Effect.runPromise,
  );
}

function retainsRefusedWork(platform: "instinct" | "grokbot") {
  const phases: string[] = [];
  const endpoint = configuredEndpoint(phases);
  return configuredRun(
    providerClient(phases, 503),
    { ...settings, MOLTZAP_NATIVE_PLATFORM: platform },
    secretFiles(),
    runNativePlugin(),
  ).pipe(
    Effect.either,
    Effect.tap((result) =>
      Effect.sync(() => {
        expect(result).toMatchObject({
          _tag: "Left",
          left: { reason: "refused" },
        });
        expect(phases).toEqual(["provider-refused"]);
        expect(endpoint.send).not.toHaveBeenCalled();
      }),
    ),
    Effect.asVoid,
    Effect.runPromise,
  );
}

function refusesConfiguration({
  change,
}: {
  readonly change: Readonly<Record<string, string | undefined>>;
}) {
  return configuredRun(
    providerClient([], 200),
    { ...settings, MOLTZAP_NATIVE_PLATFORM: "instinct", ...change },
    secretFiles(),
    runNativePlugin(),
  ).pipe(
    Effect.either,
    Effect.tap(assertConfigurationFailure),
    Effect.asVoid,
    Effect.runPromise,
  );
}

function refusesCredential({ bytes }: { readonly bytes: Uint8Array }) {
  const files = secretFiles();
  files.set(settings.MOLTZAP_MCP_CREDENTIAL_FILE, new Uint8Array(bytes));
  return configuredRun(
    providerClient([], 200),
    { ...settings, MOLTZAP_NATIVE_PLATFORM: "grokbot" },
    files,
    runNativePlugin(),
  ).pipe(
    Effect.either,
    Effect.tap(assertConfigurationFailure),
    Effect.asVoid,
    Effect.runPromise,
  );
}

function configuredEndpoint(phases: string[]): HarnessEndpoint {
  const delivery: InboundDelivery = {
    eventId,
    item,
    acknowledge: Effect.sync(() => {
      phases.push("client-acknowledged");
    }),
  };
  const endpoint: HarnessEndpoint = {
    send: vi.fn(() => Effect.succeed({})),
    messages: Stream.make(delivery),
  };
  vi.mocked(acquireHarnessEndpoint).mockImplementation(() =>
    Effect.succeed(endpoint),
  );
  return endpoint;
}

function providerClient(phases: string[], status: number) {
  return HttpClient.make((request) =>
    Effect.sync(() => {
      phases.push(status === 200 ? "provider-accepted" : "provider-refused");
      return HttpClientResponse.fromWeb(
        request,
        new Response(
          JSON.stringify({ message_id: "mail-1", thread_id: "thread-1" }),
          { status },
        ),
      );
    }),
  );
}

function secretFiles() {
  return new Map([
    [
      settings.MOLTZAP_MCP_CREDENTIAL_FILE,
      new TextEncoder().encode(runtimeGrant),
    ],
    [
      settings.MOLTZAP_AGENTMAIL_KEY_FILE,
      new TextEncoder().encode(providerKey),
    ],
  ]);
}

function configuredRun(
  http: HttpClient.HttpClient,
  config: Readonly<Record<string, string | undefined>>,
  files: ReadonlyMap<string, Uint8Array>,
  program: ReturnType<typeof runNativePlugin>,
) {
  const values = new Map(
    Object.entries(config).flatMap(([name, value]) =>
      value === undefined ? [] : [[name, value] as const],
    ),
  );
  return program.pipe(
    Effect.withConfigProvider(ConfigProvider.fromMap(values)),
    Effect.provideService(HttpClient.HttpClient, http),
    Effect.provide(
      FileSystem.layerNoop({
        readFile: (path) =>
          Effect.succeed(new Uint8Array(files.get(path) ?? [])),
      }),
    ),
  );
}

function assertConfigurationFailure(result: unknown) {
  return Effect.sync(() => {
    expect(result).toMatchObject({
      _tag: "Left",
      left: { reason: "invalid-configuration" },
    });
    expect(JSON.stringify(result)).not.toContain(runtimeGrant);
    expect(JSON.stringify(result)).not.toContain(providerKey);
    expect(JSON.stringify(result)).not.toContain("private-secret");
    expect(acquireHarnessEndpoint).not.toHaveBeenCalled();
  });
}

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- The acceptance-contract expectations above are complete. */
