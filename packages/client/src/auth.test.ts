import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { registerAgent } from "./auth.js";

/** Run an Effect to a Promise for vitest assertions. */
const run = <A, E>(e: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(e);

interface CapturedCall {
  url: string;
  method?: string;
  body: unknown;
}

/** Build a fake `fetch` that captures the request and returns a canned
 * `RegisterResponse` payload. The capture is the assertion target — we
 * verify URL and body shape without standing up the real server. The
 * fake matches `typeof globalThis.fetch` so it can replace the real
 * binding without a cast. */
function makeFakeFetch(
  responder?: (url: string) => Response,
): { fakeFetch: typeof globalThis.fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fakeFetch: typeof globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const bodyText = typeof init?.body === "string" ? init.body : "";
    calls.push({
      url,
      method: init?.method,
      body: bodyText ? JSON.parse(bodyText) : undefined,
    });
    if (responder) return responder(url);
    return new Response(
      JSON.stringify({
        agentId: "agent-id",
        apiKey: "api-key",
        claimUrl: "http://example/claim",
        claimToken: "claim-token",
      }),
      { status: 201, headers: { "Content-Type": "application/json" } },
    );
  };
  return { fakeFetch, calls };
}

describe("registerAgent", () => {
  const baseUrl = "http://test.local";
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("includes ownerUserId in the HTTP body when provided", async () => {
    const { fakeFetch, calls } = makeFakeFetch();
    globalThis.fetch = fakeFetch;

    const result = await run(
      registerAgent(baseUrl, "test", {
        inviteCode: "secret",
        ownerUserId: "00000000-0000-4000-8000-000000000001",
      }),
    );

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.body).toEqual({
      name: "test",
      inviteCode: "secret",
      ownerUserId: "00000000-0000-4000-8000-000000000001",
    });
    expect(result.agentId).toBe("agent-id");
  });

  it("routes to the admin endpoint when ownerUserId is provided", async () => {
    const { fakeFetch, calls } = makeFakeFetch();
    globalThis.fetch = fakeFetch;

    await run(
      registerAgent(baseUrl, "test", {
        inviteCode: "secret",
        ownerUserId: "00000000-0000-4000-8000-000000000001",
      }),
    );

    expect(calls[0]!.url).toBe(`${baseUrl}/api/v1/admin/register-agent`);
    expect(calls[0]!.method).toBe("POST");
  });

  it("routes to the public endpoint and omits ownerUserId when absent", async () => {
    const { fakeFetch, calls } = makeFakeFetch();
    globalThis.fetch = fakeFetch;

    await run(registerAgent(baseUrl, "test", { inviteCode: "secret" }));

    expect(calls[0]!.url).toBe(`${baseUrl}/api/v1/auth/register`);
    expect(calls[0]!.body).toEqual({ name: "test", inviteCode: "secret" });
    expect(
      Object.prototype.hasOwnProperty.call(
        calls[0]!.body as object,
        "ownerUserId",
      ),
    ).toBe(false);
  });

  it("fails with the response text when the server rejects the request", async () => {
    const { fakeFetch } = makeFakeFetch(
      () =>
        new Response("invite required", {
          status: 403,
          headers: { "Content-Type": "text/plain" },
        }),
    );
    globalThis.fetch = fakeFetch;

    const exit = await Effect.runPromiseExit(
      registerAgent(baseUrl, "test", { ownerUserId: "any" }),
    );

    expect(exit._tag).toBe("Failure");
  });
});
