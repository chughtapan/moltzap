/**
 * Unit tests for {@link NetworkSendService}.
 *
 * Each test covers exactly one branch of the send path:
 *   - durable agent address (`tm:agent:<agentId>`): resolves through
 *     the resolver's forward map and writes to one of the agent's
 *     live connections (Phase 9 + plan §1.3 in-process loopback).
 *   - {@link RecipientNotResolved}: agent has no live connection;
 *     resolver hit + connection gone (race).
 *   - {@link EndpointKindNotImplemented}: app-kind addresses fail with
 *     the placeholder tag (Phase 11+ arena cutover wires app TMs).
 *   - {@link WriteFailed}: connection.write rejects.
 *
 * Phase 9b consumer-migration (sub-issue #460 amendment): the legacy
 * `agent-conn` `EndpointAddress` kind retired. The resolver now keys by
 * `ConnectionId` directly; the public `EndpointAddressKind` union is
 * `agent | app`. Tests that previously exercised `tm:agent-conn:<connId>`
 * routing have been folded into the durable `tm:agent:<agentId>` cases
 * (the `agent-conn` form was always internal to the resolver and never
 * appeared on the wire).
 */
import { describe, expect, it } from "vitest";
import { Cause, Effect, Exit, HashMap, Option, Ref } from "effect";
import * as Socket from "@effect/platform/Socket";
import {
  agentId,
  endpointAddress,
  makeEndpointAddress,
} from "@moltzap/protocol/network";
import { ConnectionManager } from "../ws/connection.js";
import {
  AgentEndpointResolver,
  connectionId,
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
const CONN_A = connectionId("00000000-0000-4000-8000-00000000c001");

const APP_ADDR = endpointAddress(`tm:app:00000000-0000-4000-8000-0000000a9990`);
// Durable agent-id form `tm:agent:<agentId>` — what task-manager
// registration writes into `tasks.tm_endpoint_address`.
const ALICE_DURABLE = makeEndpointAddress("agent", ALICE);

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
  it("durable agent address (`tm:agent:<agentId>`): resolves through forward map, writes payload, returns DeliveryAck", () => {
    // Phase 9 / plan §2.4.a + §1.3: durable TM-routed sends use the
    // `tm:agent:<agentId>` form. The resolver maps the agent to its
    // live ConnectionIds; sendToDurableAgent picks one and writes
    // there. In-process loopback: the same code path always runs (no
    // short-circuit).
    const resolver = makeResolver();
    const connections = new ConnectionManager();
    const capture = { raw: null as string | null };
    const conn = fakeConnection(CONN_A, "ok", capture);
    connections.add(conn);

    Effect.runSync(resolver.add(ALICE, CONN_A));

    const service = new NetworkSendService(resolver, connections);
    const payload = opaquePayload(`{"jsonrpc":"2.0","method":"x","params":{}}`);

    const exit = Effect.runSyncExit(service.send(ALICE_DURABLE, payload));
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toBeInstanceOf(DeliveryAck);
      expect(exit.value.to).toEqual(ALICE_DURABLE);
    }
    expect(capture.raw).toBe(payload);
  });

  it("durable agent address: agent has no live connection → RecipientNotResolved", () => {
    const resolver = makeResolver();
    const connections = new ConnectionManager();
    const service = new NetworkSendService(resolver, connections);
    const payload = opaquePayload("{}");

    // ALICE_DURABLE references a registered TM that is not currently
    // connected. The durable address persists in the column, but no
    // socket holds it.
    const exit = Effect.runSyncExit(service.send(ALICE_DURABLE, payload));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) {
        expect(failure.value).toBeInstanceOf(RecipientNotResolved);
      }
    }
  });

  it("durable agent address: resolver hit but connection gone → RecipientNotResolved", () => {
    // Race: resolver still holds the entry but the connection closed
    // between the WS finalizer and the send call.
    const resolver = makeResolver();
    const connections = new ConnectionManager(); // empty
    Effect.runSync(resolver.add(ALICE, CONN_A));
    const service = new NetworkSendService(resolver, connections);
    const payload = opaquePayload("{}");

    const exit = Effect.runSyncExit(service.send(ALICE_DURABLE, payload));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      if (Option.isSome(failure)) {
        expect(failure.value).toBeInstanceOf(RecipientNotResolved);
      }
    }
  });

  it("app address: returns EndpointKindNotImplemented (reserved for Phase 11+ arena cutover)", () => {
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

  it("durable agent address: socket write rejects → WriteFailed wraps the cause", async () => {
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
    Effect.runSync(resolver.add(ALICE, CONN_A));
    const service = new NetworkSendService(resolver, connections);
    const payload = opaquePayload("{}");

    const exit = await Effect.runPromiseExit(
      service.send(ALICE_DURABLE, payload),
    );
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
