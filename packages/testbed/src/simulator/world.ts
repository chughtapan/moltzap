/**
 * @file World (contract 3): substrate control. Owns synchrony and
 * delivery treatments and scheduled connection-level fault apply/revert
 * pairs, acting through per-agent proxied server endpoints. The fault
 * vocabulary is connection-level only (sever, delay, throttle), never
 * per-message lossy delivery; v0's verified obligation is sever/heal and
 * the v0 implementation rejects delay and throttle with
 * `FaultUnsupported`. Topology control stays out until the topology open
 * question has a recorded decision.
 */
import { Deferred, Effect, Schema, type Scope } from "effect";
import type { Socket } from "@effect/platform";
import { NodeSocket, NodeSocketServer } from "@effect/platform-node";
import { ServerUrl } from "../runtime.js";
import type { AgentName, FaultSpec } from "./run-spec.js";
import { CorrelationId } from "./ids.js";
import {
  FaultApplyFailed,
  FaultUnsupported,
  type FaultRevertFailed,
} from "./errors.js";

/**
 * A live, applied fault. Reverting heals the connection; the episode
 * scheduler records both boundaries at their logical times under one
 * `correlationId`. A revert firing after episode termination is still
 * executed and recorded (fault windows may overlap episode end).
 */
export type AppliedFault = {
  readonly correlationId: CorrelationId;
  readonly fault: FaultSpec;
  revert(): Effect.Effect<void, FaultRevertFailed, never>;
};

/**
 * World contract. `allocateEndpoint` returns the per-agent proxied
 * ServerUrl a slot's runtime connects through — the control point faults
 * act on; proxies are released at scope close. `apply` executes one
 * scheduled fault against a live target; applying against a not-yet-ready
 * target is the caller's `target-not-ready` case, recorded, never a
 * crash and never a silent skip.
 */
export interface World {
  allocateEndpoint(
    slot: AgentName,
    upstream: ServerUrl,
  ): Effect.Effect<ServerUrl, never, Scope.Scope>;

  apply(
    fault: FaultSpec,
  ): Effect.Effect<AppliedFault, FaultUnsupported | FaultApplyFailed, never>;
}

/** Create the v0 world driver (per-agent WS proxy; sever/heal honored, delay/throttle rejected). */
export function makeWorld(): Effect.Effect<World, never, Scope.Scope> {
  return Effect.sync((): World => {
    const proxies = new Map<AgentName, SlotProxy>();
    return {
      allocateEndpoint: (slot, upstream) =>
        allocateEndpoint(proxies, slot, upstream),
      apply: (fault) => applyFault(proxies, fault),
    };
  }).pipe(Effect.withSpan("makeWorld"));
}

/**
 * Per-slot proxy state. `severed` rejects new connections; `live` holds
 * one interrupt latch per relayed connection so sever can cut every
 * established connection at once. Heal clears the flag; existing latches
 * are already spent.
 */
type SlotProxy = {
  severed: boolean;
  readonly live: Set<Deferred.Deferred<void>>;
};

function allocateEndpoint(
  proxies: Map<AgentName, SlotProxy>,
  slot: AgentName,
  upstream: ServerUrl,
): Effect.Effect<ServerUrl, never, Scope.Scope> {
  return Effect.gen(function* () {
    const upstreamUrl = new URL(upstream);
    const proxy: SlotProxy = { severed: false, live: new Set() };
    proxies.set(slot, proxy);
    // A local ephemeral bind failing is an environment defect, not an
    // expressible fault of the run; the never error channel reflects that.
    const server = yield* NodeSocketServer.make({
      host: PROXY_HOST,
      port: 0,
    }).pipe(Effect.orDie);
    yield* Effect.forkScoped(
      server.run((connection) => relayConnection(proxy, upstreamUrl, connection)),
    );
    const port =
      server.address._tag === "TcpAddress" ? server.address.port : 0;
    return ServerUrl(
      `${upstreamUrl.protocol}//${PROXY_HOST}:${String(port)}${upstreamUrl.pathname}${upstreamUrl.search}`,
    );
  }).pipe(Effect.withSpan("World.allocateEndpoint"));
}

const PROXY_HOST = "127.0.0.1";
const WS_DEFAULT_PORT = 80;
const WSS_DEFAULT_PORT = 443;

function upstreamPort(url: URL): number {
  if (url.port.length > 0) return Number(url.port);
  return url.protocol === "wss:" ? WSS_DEFAULT_PORT : WS_DEFAULT_PORT;
}

/**
 * Byte-level relay: WS runs over TCP, so a transparent TCP pipe carries
 * the protocol unchanged, and destroying it is exactly a connection-level
 * sever. The relay ends when either side closes or the sever latch fires;
 * scope close then destroys both sockets.
 */
function relayConnection(
  proxy: SlotProxy,
  upstreamUrl: URL,
  connection: Socket.Socket,
): Effect.Effect<void, never, never> {
  if (proxy.severed) return Effect.void;
  return Effect.scoped(
    Effect.gen(function* () {
      const upstream = yield* NodeSocket.makeNet({
        host: upstreamUrl.hostname,
        port: upstreamPort(upstreamUrl),
      });
      const severLatch = yield* Deferred.make<void>();
      proxy.live.add(severLatch);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => proxy.live.delete(severLatch)),
      );
      yield* Effect.race(
        pipeSockets(connection, upstream),
        Deferred.await(severLatch),
      );
    }),
  ).pipe(Effect.catchAll(() => Effect.void));
}

/** Pump both directions until either socket closes or errors. */
function pipeSockets(
  client: Socket.Socket,
  upstream: Socket.Socket,
): Effect.Effect<void, Socket.SocketError, Scope.Scope> {
  return Effect.gen(function* () {
    const toUpstream = yield* upstream.writer;
    const toClient = yield* client.writer;
    yield* Effect.race(
      client.runRaw((chunk) => toUpstream(chunk)),
      upstream.runRaw((chunk) => toClient(chunk)),
    );
  }).pipe(Effect.asVoid);
}

function applyFault(
  proxies: Map<AgentName, SlotProxy>,
  fault: FaultSpec,
): Effect.Effect<AppliedFault, FaultUnsupported | FaultApplyFailed, never> {
  if (fault._tag !== "sever") {
    return Effect.fail(
      new FaultUnsupported({
        faultKind: fault._tag,
        message: `Fault kind "${fault._tag}" is expressible but not honored by this build (v0 honors sever/heal); materialization rejects it, so this call bypassed config time.`,
      }),
    );
  }
  const proxy = proxies.get(fault.target);
  if (proxy === undefined) {
    return Effect.fail(
      new FaultApplyFailed({
        faultKind: fault._tag,
        target: fault.target,
        message: `No proxied endpoint exists for agent "${fault.target}"; allocateEndpoint runs at launch, so this target was never launched.`,
      }),
    );
  }
  return severSlot(proxy, fault).pipe(Effect.withSpan("World.apply"));
}

function severSlot(
  proxy: SlotProxy,
  fault: FaultSpec,
): Effect.Effect<AppliedFault, never, never> {
  return Effect.gen(function* () {
    proxy.severed = true;
    yield* Effect.forEach(
      [...proxy.live],
      (latch) => Deferred.succeed(latch, undefined),
      { concurrency: 1, discard: true },
    );
    const correlationId = Schema.decodeSync(CorrelationId)(
      crypto.randomUUID(),
    );
    return {
      correlationId,
      fault,
      revert: () =>
        Effect.sync(() => {
          proxy.severed = false;
        }).pipe(Effect.withSpan("World.revert")),
    };
  });
}
