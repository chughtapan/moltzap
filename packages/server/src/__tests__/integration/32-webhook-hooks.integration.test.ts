// ─────────────────────────────────────────────────────────────────────
// WEBHOOK-BASED APP HOOKS (issue #74)
//
// Apps can declare `hooks.<name>.webhook` URLs in their manifest; the
// MoltZap server POSTs hook context to those URLs instead of running an
// in-process handler. This file spins up a mini HTTP server inside the
// test process as the "app" endpoint, registers a manifest pointing at
// that URL, and exercises the dispatch + fail-closed + HMAC paths end-
// to-end.
//
// Like 30-app-hooks.integration.test.ts, timeouts here are real wall-
// clock — TestClock does not apply to server-side fibers.
// ─────────────────────────────────────────────────────────────────────

import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import * as http from "node:http";
import { expectRpcFailure } from "../../test-utils/index.js";
import type { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";

import {
  startTestServer,
  stopTestServer,
  resetTestDb,
  registerAndConnect,
  getKyselyDb,
} from "./helpers.js";
import type { CoreApp } from "../../app/types.js";
import { ErrorCodes } from "@moltzap/protocol";
import type { ConnectedAgent } from "../../test-utils/helpers.js";

let coreApp: CoreApp;

beforeAll(async () => {
  const server = await startTestServer();
  coreApp = server.coreApp;
}, 60_000);

afterAll(async () => {
  await stopTestServer();
});

beforeEach(async () => {
  await resetTestDb();
});

function registerAppAgent(name: string): Effect.Effect<ConnectedAgent, Error> {
  return Effect.gen(function* () {
    const agent = yield* registerAndConnect(name);
    const db = getKyselyDb();
    yield* Effect.tryPromise(() =>
      db
        .updateTable("agents")
        .set({ owner_user_id: crypto.randomUUID() })
        .where("id", "=", agent.agentId)
        .execute(),
    );
    return agent;
  });
}

/**
 * Spin up a tiny HTTP server on an ephemeral port. `onRequest` receives
 * the raw body + headers and returns the response body (or null for 204).
 * Records every request for assertions, including the exact body bytes
 * so the signature check is authoritative.
 */
interface HookServerRecord {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface HookServer {
  url: string;
  requests: HookServerRecord[];
  close: () => Promise<void>;
}

async function startHookServer(
  handler: (req: HookServerRecord) =>
    | {
        status?: number;
        body?: unknown;
        /** Delay in ms before responding — used to simulate slow hooks. */
        delayMs?: number;
      }
    | Promise<{ status?: number; body?: unknown; delayMs?: number }>,
): Promise<HookServer> {
  const requests: HookServerRecord[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      void (async () => {
        const record: HookServerRecord = {
          method: req.method ?? "",
          path: req.url ?? "",
          headers: { ...req.headers },
          body: Buffer.concat(chunks).toString("utf-8"),
        };
        requests.push(record);

        try {
          const response = await handler(record);
          if (response.delayMs) {
            await new Promise((r) => setTimeout(r, response.delayMs));
          }
          const status = response.status ?? 200;
          if (response.body === undefined || response.body === null) {
            res.writeHead(status);
            res.end();
          } else {
            const bodyJson = JSON.stringify(response.body);
            res.writeHead(status, { "Content-Type": "application/json" });
            res.end(bodyJson);
          }
        } catch (err) {
          res.writeHead(500);
          res.end(String(err));
        }
      })();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

describe("Scenario 32: webhook-based app hooks", () => {
  describe("before_message_delivery via webhook", () => {
    it.live(
      "POSTs hook context and blocks when webhook returns block:true",
      () =>
        Effect.gen(function* () {
          const agent = yield* registerAppAgent("webhook-block");

          const hook = yield* Effect.promise(() =>
            startHookServer(() => ({
              status: 200,
              body: {
                block: true,
                reason: "Webhook says no",
                feedback: {
                  type: "error",
                  content: { policy: "test" },
                  retry: true,
                },
              },
            })),
          );

          try {
            coreApp.registerApp({
              appId: "webhook-blocker",
              name: "Webhook Blocker",
              permissions: { required: [], optional: [] },
              conversations: [
                { key: "main", name: "Main", participantFilter: "all" },
              ],
              hooks: {
                before_message_delivery: {
                  webhook: hook.url + "/before-message",
                },
              },
            });

            const session = (yield* agent.client.sendRpc("apps/create", {
              appId: "webhook-blocker",
              invitedAgentIds: [],
            })) as { session: { conversations: Record<string, string> } };
            const convId = session.session.conversations["main"]!;

            const rpcErr = yield* expectRpcFailure(
              agent.client.sendRpc("messages/send", {
                conversationId: convId,
                parts: [{ type: "text", text: "hello" }],
              }),
              ErrorCodes.HookBlocked,
            );
            // data.feedback IS the wire contract: structured block payload
            // from the webhook must reach the client as-is.
            expect(rpcErr.data).toHaveProperty("feedback");

            // Verify the outbound POST shape.
            expect(hook.requests.length).toBe(1);
            const request = hook.requests[0]!;
            expect(request.method).toBe("POST");
            expect(request.path).toBe("/before-message");
            expect(request.headers["content-type"]).toContain(
              "application/json",
            );
            expect(request.headers["x-moltzap-event"]).toBe(
              "app.before_message_delivery",
            );

            const body = JSON.parse(request.body) as {
              sessionId: string;
              appId: string;
              conversationId: string;
              sender: { agentId: string; ownerId: string };
              message: { parts: unknown[] };
            };
            expect(body.appId).toBe("webhook-blocker");
            expect(body.conversationId).toBe(convId);
            expect(body.sender.agentId).toBe(agent.agentId);
            expect(body.message.parts).toEqual([
              { type: "text", text: "hello" },
            ]);
          } finally {
            yield* Effect.promise(() => hook.close());
          }
        }),
    );

    it.live("patches message parts when webhook returns patch", () =>
      Effect.gen(function* () {
        const agent = yield* registerAppAgent("webhook-patch");

        const hook = yield* Effect.promise(() =>
          startHookServer(() => ({
            status: 200,
            body: {
              block: false,
              patch: {
                parts: [{ type: "text", text: "[WEBHOOK] patched" }],
              },
            },
          })),
        );

        try {
          coreApp.registerApp({
            appId: "webhook-patcher",
            name: "Webhook Patcher",
            permissions: { required: [], optional: [] },
            conversations: [
              { key: "main", name: "Main", participantFilter: "all" },
            ],
            hooks: {
              before_message_delivery: { webhook: hook.url + "/bmd" },
            },
          });

          const session = (yield* agent.client.sendRpc("apps/create", {
            appId: "webhook-patcher",
            invitedAgentIds: [],
          })) as { session: { conversations: Record<string, string> } };
          const convId = session.session.conversations["main"]!;

          const result = (yield* agent.client.sendRpc("messages/send", {
            conversationId: convId,
            parts: [{ type: "text", text: "raw" }],
          })) as {
            message: {
              parts: Array<{ type: string; text: string }>;
              patchedBy?: string;
            };
          };

          expect(result.message.parts[0]!.text).toBe("[WEBHOOK] patched");
          expect(result.message.patchedBy).toBe("webhook-patcher");
        } finally {
          yield* Effect.promise(() => hook.close());
        }
      }),
    );

    it.live("fails closed (HookBlocked) when webhook never responds", () =>
      Effect.gen(function* () {
        const agent = yield* registerAppAgent("webhook-timeout");

        // Sleep longer than the 200ms hook timeout so we exercise the
        // Effect.timeout path rather than the fetch AbortSignal path.
        const hook = yield* Effect.promise(() =>
          startHookServer(() => ({
            status: 200,
            body: { block: false },
            delayMs: 1500,
          })),
        );

        try {
          coreApp.registerApp({
            appId: "webhook-timeout-app",
            name: "Webhook Timeout",
            permissions: { required: [], optional: [] },
            conversations: [
              { key: "main", name: "Main", participantFilter: "all" },
            ],
            hooks: {
              before_message_delivery: {
                webhook: hook.url + "/bmd",
                timeout_ms: 200,
              },
            },
          });

          const session = (yield* agent.client.sendRpc("apps/create", {
            appId: "webhook-timeout-app",
            invitedAgentIds: [],
          })) as { session: { conversations: Record<string, string> } };
          const convId = session.session.conversations["main"]!;

          yield* expectRpcFailure(
            agent.client.sendRpc("messages/send", {
              conversationId: convId,
              parts: [{ type: "text", text: "should be blocked" }],
            }),
            ErrorCodes.HookBlocked,
          );

          const evt = yield* agent.client.waitForEvent("app/hookTimeout", 3000);
          const data = evt.data as {
            hookName: string;
            timeoutMs: number;
          };
          expect(data.hookName).toBe("before_message_delivery");
          expect(data.timeoutMs).toBe(200);
        } finally {
          yield* Effect.promise(() => hook.close());
        }
      }),
    );

    it.live("fails closed when webhook returns non-2xx", () =>
      Effect.gen(function* () {
        const agent = yield* registerAppAgent("webhook-5xx");

        const hook = yield* Effect.promise(() =>
          startHookServer(() => ({
            status: 500,
            body: { error: "internal" },
          })),
        );

        try {
          coreApp.registerApp({
            appId: "webhook-5xx-app",
            name: "Webhook 5xx",
            permissions: { required: [], optional: [] },
            conversations: [
              { key: "main", name: "Main", participantFilter: "all" },
            ],
            hooks: {
              before_message_delivery: { webhook: hook.url + "/bmd" },
            },
          });

          const session = (yield* agent.client.sendRpc("apps/create", {
            appId: "webhook-5xx-app",
            invitedAgentIds: [],
          })) as { session: { conversations: Record<string, string> } };
          const convId = session.session.conversations["main"]!;

          yield* expectRpcFailure(
            agent.client.sendRpc("messages/send", {
              conversationId: convId,
              parts: [{ type: "text", text: "should be blocked" }],
            }),
            ErrorCodes.HookBlocked,
          );
        } finally {
          yield* Effect.promise(() => hook.close());
        }
      }),
    );

    it.live(
      "includes X-MoltZap-Signature header when manifest sets hooks.secret",
      () =>
        Effect.gen(function* () {
          const agent = yield* registerAppAgent("webhook-signed");
          const secret = "top-secret-app-key-xyz";

          let capturedBody = "";
          let capturedSignature: string | undefined;

          const hook = yield* Effect.promise(() =>
            startHookServer((req) => {
              capturedBody = req.body;
              capturedSignature = req.headers["x-moltzap-signature"] as string;
              return {
                status: 200,
                body: { block: false },
              };
            }),
          );

          try {
            coreApp.registerApp({
              appId: "webhook-signed-app",
              name: "Signed Webhook",
              permissions: { required: [], optional: [] },
              conversations: [
                { key: "main", name: "Main", participantFilter: "all" },
              ],
              hooks: {
                before_message_delivery: { webhook: hook.url + "/bmd" },
                secret,
              },
            });

            const session = (yield* agent.client.sendRpc("apps/create", {
              appId: "webhook-signed-app",
              invitedAgentIds: [],
            })) as { session: { conversations: Record<string, string> } };
            const convId = session.session.conversations["main"]!;

            yield* agent.client.sendRpc("messages/send", {
              conversationId: convId,
              parts: [{ type: "text", text: "hello signed" }],
            });

            // Signature must verify against the exact body bytes we received.
            // This is the test an app author would write on their side to
            // validate inbound webhook requests.
            expect(capturedSignature).toBeDefined();
            expect(capturedSignature).toMatch(/^sha256=/);
            const expected =
              "sha256=" +
              createHmac("sha256", secret).update(capturedBody).digest("hex");
            expect(capturedSignature).toBe(expected);
          } finally {
            yield* Effect.promise(() => hook.close());
          }
        }),
    );

    it.live(
      "prefers webhook when both webhook URL and in-process handler set",
      () =>
        Effect.gen(function* () {
          const agent = yield* registerAppAgent("webhook-precedence");

          let inProcessFired = false;
          const hook = yield* Effect.promise(() =>
            startHookServer(() => ({
              status: 200,
              body: {
                block: true,
                reason: "from webhook",
              },
            })),
          );

          try {
            coreApp.registerApp({
              appId: "webhook-precedence-app",
              name: "Precedence",
              permissions: { required: [], optional: [] },
              conversations: [
                { key: "main", name: "Main", participantFilter: "all" },
              ],
              hooks: {
                before_message_delivery: { webhook: hook.url + "/bmd" },
              },
            });
            coreApp.onBeforeMessageDelivery("webhook-precedence-app", () => {
              inProcessFired = true;
              return { block: false };
            });

            const session = (yield* agent.client.sendRpc("apps/create", {
              appId: "webhook-precedence-app",
              invitedAgentIds: [],
            })) as { session: { conversations: Record<string, string> } };
            const convId = session.session.conversations["main"]!;

            yield* expectRpcFailure(
              agent.client.sendRpc("messages/send", {
                conversationId: convId,
                parts: [{ type: "text", text: "x" }],
              }),
              ErrorCodes.HookBlocked,
            );

            expect(hook.requests.length).toBe(1);
            expect(inProcessFired).toBe(false);
          } finally {
            yield* Effect.promise(() => hook.close());
          }
        }),
    );
  });

  describe("on_join via webhook", () => {
    it.live("POSTs on_join payload when agent is admitted", () =>
      Effect.gen(function* () {
        const initiator = yield* registerAppAgent("wh-on-join-init");
        const invitee = yield* registerAppAgent("wh-on-join-invitee");

        const hook = yield* Effect.promise(() =>
          startHookServer(() => ({ status: 200 })),
        );

        try {
          coreApp.registerApp({
            appId: "webhook-on-join",
            name: "On Join",
            permissions: { required: [], optional: [] },
            conversations: [
              { key: "main", name: "Main", participantFilter: "all" },
            ],
            hooks: {
              on_join: { webhook: hook.url + "/on-join" },
            },
          });

          yield* initiator.client.sendRpc("apps/create", {
            appId: "webhook-on-join",
            invitedAgentIds: [invitee.agentId],
          });

          // Wait for async admission to complete.
          yield* Effect.promise(() => new Promise((r) => setTimeout(r, 500)));

          expect(hook.requests.length).toBe(1);
          const body = JSON.parse(hook.requests[0]!.body) as {
            sessionId: string;
            appId: string;
            conversations: Record<string, string>;
            agent: { agentId: string; ownerId: string };
          };
          expect(body.appId).toBe("webhook-on-join");
          expect(body.agent.agentId).toBe(invitee.agentId);
          expect(body.conversations).toHaveProperty("main");
        } finally {
          yield* Effect.promise(() => hook.close());
        }
      }),
    );
  });

  describe("on_close via webhook", () => {
    it.live("POSTs on_close payload when session is closed", () =>
      Effect.gen(function* () {
        const agent = yield* registerAppAgent("wh-on-close");

        const hook = yield* Effect.promise(() =>
          startHookServer(() => ({ status: 200 })),
        );

        try {
          coreApp.registerApp({
            appId: "webhook-on-close",
            name: "On Close",
            permissions: { required: [], optional: [] },
            conversations: [
              { key: "main", name: "Main", participantFilter: "all" },
            ],
            hooks: {
              on_close: { webhook: hook.url + "/on-close" },
            },
          });

          const session = (yield* agent.client.sendRpc("apps/create", {
            appId: "webhook-on-close",
            invitedAgentIds: [],
          })) as { session: { id: string } };

          yield* agent.client.sendRpc("apps/closeSession", {
            sessionId: session.session.id,
          });

          expect(hook.requests.length).toBe(1);
          const body = JSON.parse(hook.requests[0]!.body) as {
            sessionId: string;
            appId: string;
            conversations: Record<string, string>;
            closedBy: { agentId: string; ownerId: string };
          };
          expect(body.sessionId).toBe(session.session.id);
          expect(body.appId).toBe("webhook-on-close");
          expect(body.closedBy.agentId).toBe(agent.agentId);
        } finally {
          yield* Effect.promise(() => hook.close());
        }
      }),
    );
  });
});
