import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { registerAgent } from "./auth.js";

/** Run an Effect to a Promise for vitest assertions. */
const run = <A, E>(e: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(e);

interface CapturedCall {
  path: string;
  method?: string;
  body: unknown;
}

interface StubResponse {
  readonly status: number;
  readonly body: string;
  readonly contentType: string;
}

const CREATED_STATUS = 201;
const FORBIDDEN_STATUS = 403;
const LOCALHOST = "127.0.0.1";

const readRequestBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
};

const listen = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, LOCALHOST);
  });

const close = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });

const defaultRegisterResponse = (): StubResponse => ({
  status: CREATED_STATUS,
  contentType: "application/json",
  body: JSON.stringify({
    agentId: "agent-id",
    apiKey: "api-key",
    claimUrl: "http://example/claim",
    claimToken: "claim-token",
  }),
});

async function withRegisterServer<T>(
  test: (ctx: { baseUrl: string; calls: CapturedCall[] }) => Promise<T>,
  responder: (path: string) => StubResponse = defaultRegisterResponse,
): Promise<T> {
  const calls: CapturedCall[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const path = request.url ?? "/";
      const bodyText = await readRequestBody(request);
      const stubResponse = responder(path);
      response.statusCode = stubResponse.status;
      response.setHeader("Content-Type", stubResponse.contentType);
      response.end(stubResponse.body);
      const parsedBody: unknown = bodyText ? JSON.parse(bodyText) : undefined;
      calls.push({
        path,
        method: request.method,
        body: parsedBody,
      });
    })().catch((error: unknown) => {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    });
  });

  await listen(server);
  const address = server.address();
  if (address === null || typeof address === "string") {
    await close(server);
    throw new Error("expected TCP server address");
  }
  const baseUrl = `http://${LOCALHOST}:${(address as AddressInfo).port}`;
  try {
    return await test({ baseUrl, calls });
  } finally {
    await close(server);
  }
}

describe("registerAgent", () => {
  it("posts ownerUserId in the body to the admin endpoint", async () => {
    await withRegisterServer(async ({ baseUrl, calls }) => {
      const result = await run(
        registerAgent(baseUrl, "test", {
          inviteCode: "secret",
          ownerUserId: "00000000-0000-4000-8000-000000000001",
        }),
      );

      expect(calls).toHaveLength(1);
      const [call] = calls;
      expect(call!.path).toBe("/api/v1/admin/register-agent");
      expect(call!.method).toBe("POST");
      expect(call!.body).toEqual({
        name: "test",
        inviteCode: "secret",
        ownerUserId: "00000000-0000-4000-8000-000000000001",
      });
      expect(result.agentId).toBe("agent-id");
    });
  });

  it("posts to the public endpoint without ownerUserId when absent", async () => {
    await withRegisterServer(async ({ baseUrl, calls }) => {
      await run(registerAgent(baseUrl, "test", { inviteCode: "secret" }));

      expect(calls[0]!.path).toBe("/api/v1/auth/register");
      // toEqual with `additionalProperties` rejects extra keys, so this also
      // proves ownerUserId is not on the body.
      expect(calls[0]!.body).toEqual({ name: "test", inviteCode: "secret" });
    });
  });

  it("fails when the server returns a non-2xx response", async () => {
    await withRegisterServer(
      async ({ baseUrl }) => {
        const exit = await Effect.runPromiseExit(
          registerAgent(baseUrl, "test", {
            ownerUserId: "00000000-0000-4000-8000-000000000001",
          }),
        );

        expect(exit._tag).toBe("Failure");
      },
      () => ({
        status: FORBIDDEN_STATUS,
        contentType: "text/plain",
        body: "invite required",
      }),
    );
  });
});
