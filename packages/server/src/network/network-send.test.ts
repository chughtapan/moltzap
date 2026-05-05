/**
 * Unit tests for {@link NetworkSendService}.
 *
 * Each test covers exactly one branch of the send path:
 *   - happy path: agent address resolves and write succeeds.
 *   - {@link RecipientNotResolved}: resolver miss; connection-manager miss
 *     (race where the resolver retains a stale entry).
 *   - {@link EndpointKindNotImplemented}: app-kind addresses fail with the
 *     placeholder tag (Phase 9 territory).
 *   - {@link WriteFailed}: connection.write rejects.
 *
 * The service is exercised directly (no Layer composition) so each test
 * has full control over the resolver and connection manager state.
 */
import { describe, expect, it } from "vitest";
import { Cause, Effect, Exit, HashMap, Option, Ref } from "effect";
import * as Socket from "@effect/platform/Socket";
import { agentId, endpointAddress } from "@moltzap/protocol/network";
import { ConnectionManager } from "../ws/connection.js";
import {
  AgentEndpointResolver,
  agentConnectionEndpointAddress,
} from "./agent-endpoint-resolver.js";
import {
  DeliveryAck,
  EndpointKindNotImplemented,
  NetworkSendService,
  RecipientNotResolved,
  WriteFailed,
  opaquePayload,
} from "./network-send.js";

const ALICE = agentId("00000000-0000-4000-8000-00000000a11c");
const CONN_A = "00000000-0000-4000-8000-00000000c001";

const APP_ADDR = endpointAddress(`tm:app:00000000-0000-4000-8000-0000000a9990`);

const makeResolver = (): AgentEndpointResolver =>
  Effect.runSync(AgentEndpointResolver.make);

/**
 * Build a minimal MoltZapConnection record that satisfies the parts of
 * the interface the send path actually reads:
 *   - `id`
 *   - `write(raw)`: Effect succeeding or failing per `writeBehavior`
 *
 * Other fields are present as placeholders to satisfy the structural type
 * but are not exercised by the send path.
 */
function fakeConnection(
  id: string,
  writeBehavior: "ok" | { fail: Socket.SocketError },
  capture: { raw: string | null },
): import("../ws/connection.js").MoltZapConnection {
  return {
    id,
    write: (raw: string) => {
      capture.raw = raw;
      if (writeBehavior === "ok") return Effect.void;
      return Effect.fail(writeBehavior.fail);
    },
    shutdown: Effect.void,
    auth: null,
    lastPong: 0,
    conversationIds: new Set<string>(),
    mutedConversations: new Set<string>(),
    appCallbackPending: Effect.runSync(
      Ref.make(
        HashMap.empty<
          import("@moltzap/protocol").JsonRpcStringId,
          {
            readonly method: import("@moltzap/protocol").JsonRpcMethod;
            readonly deferred: never;
          }
        >() as import("../ws/connection.js").AppCallbackPendingMap,
      ),
    ),
    appCallbackRequestCounter: Effect.runSync(Ref.make(0)),
  };
}

describe("NetworkSendService.send", () => {
  it("agent address: resolves via resolver, writes payload, returns DeliveryAck", () => {
    const resolver = makeResolver();
    const connections = new ConnectionManager();
    const capture = { raw: null as string | null };
    const conn = fakeConnection(CONN_A, "ok", capture);
    connections.add(conn);

    const addr = agentConnectionEndpointAddress(CONN_A);
    Effect.runSync(resolver.add(ALICE, addr, CONN_A));

    const service = new NetworkSendService(resolver, connections);
    const payload = opaquePayload(`{"jsonrpc":"2.0","method":"x","params":{}}`);

    const exit = Effect.runSyncExit(service.send(addr, payload));
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toBeInstanceOf(DeliveryAck);
      expect(exit.value.to).toEqual(addr);
    }
    expect(capture.raw).toBe(payload);
  });

  it("agent address: resolver miss → RecipientNotResolved", () => {
    const resolver = makeResolver();
    const connections = new ConnectionManager();
    const service = new NetworkSendService(resolver, connections);
    const addr = agentConnectionEndpointAddress(CONN_A);
    const payload = opaquePayload("{}");

    const exit = Effect.runSyncExit(service.send(addr, payload));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) {
        expect(failure.value).toBeInstanceOf(RecipientNotResolved);
        expect(failure.value._tag).toBe("RecipientNotResolved");
      }
    }
  });

  it("agent address: resolver hit but connection gone → RecipientNotResolved", () => {
    // Race: resolver still holds the entry but the connection closed
    // between the WS finalizer and the send call.
    const resolver = makeResolver();
    const connections = new ConnectionManager(); // empty
    const addr = agentConnectionEndpointAddress(CONN_A);
    Effect.runSync(resolver.add(ALICE, addr, CONN_A));
    const service = new NetworkSendService(resolver, connections);
    const payload = opaquePayload("{}");

    const exit = Effect.runSyncExit(service.send(addr, payload));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      if (Option.isSome(failure)) {
        expect(failure.value).toBeInstanceOf(RecipientNotResolved);
      }
    }
  });

  it("app address: returns EndpointKindNotImplemented (Phase 9 deferral)", () => {
    const resolver = makeResolver();
    const connections = new ConnectionManager();
    const service = new NetworkSendService(resolver, connections);
    const payload = opaquePayload("{}");

    const exit = Effect.runSyncExit(service.send(APP_ADDR, payload));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) {
        expect(failure.value).toBeInstanceOf(EndpointKindNotImplemented);
        expect((failure.value as EndpointKindNotImplemented).kind).toBe("app");
      }
    }
  });

  it("agent address: socket write rejects → WriteFailed wraps the cause", async () => {
    const resolver = makeResolver();
    const connections = new ConnectionManager();
    const capture = { raw: null as string | null };
    // Build a SocketError. The constructor accepts `reason`-style payloads;
    // any well-formed instance suffices here because the test inspects
    // identity via `instanceof`.
    const cause = new Socket.SocketGenericError({
      reason: "Write",
      cause: new Error("EPIPE"),
    });
    const conn = fakeConnection(CONN_A, { fail: cause }, capture);
    connections.add(conn);
    const addr = agentConnectionEndpointAddress(CONN_A);
    Effect.runSync(resolver.add(ALICE, addr, CONN_A));
    const service = new NetworkSendService(resolver, connections);
    const payload = opaquePayload("{}");

    const exit = await Effect.runPromiseExit(service.send(addr, payload));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) {
        expect(failure.value).toBeInstanceOf(WriteFailed);
        expect((failure.value as WriteFailed).cause).toBe(cause);
      }
    }
  });
});

describe("opaquePayload", () => {
  it("brands a string and round-trips bytes unchanged", () => {
    const raw = `{"jsonrpc":"2.0","method":"task/ready","params":{}}`;
    const branded = opaquePayload(raw);
    expect(String(branded)).toBe(raw);
  });
});
