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
import { Effect, Schema, type Scope } from "effect";
import { ServerUrl } from "../runtime.js";
import { createRelayProxy, type RelayProxy } from "./node-net-relay.js";
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
 * Per-slot proxy state: the raw relay handle. `severed` semantics live
 * inside the relay (reject new connections, destroy established ones);
 * heal clears the flag.
 */
type SlotProxy = {
  readonly relay: RelayProxy;
};

function allocateEndpoint(
  proxies: Map<AgentName, SlotProxy>,
  slot: AgentName,
  upstream: ServerUrl,
): Effect.Effect<ServerUrl, never, Scope.Scope> {
  return Effect.gen(function* () {
    const upstreamUrl = new URL(upstream);
    // A local ephemeral bind failing is an environment defect, not an
    // expressible fault of the run; the never error channel reflects that.
    const relay = yield* Effect.async<RelayProxy, never, never>((resume) => {
      createRelayProxy(
        upstreamUrl.hostname,
        upstreamPort(upstreamUrl),
        (proxy) => resume(Effect.succeed(proxy)),
        (cause) => resume(Effect.die(cause)),
      );
    });
    proxies.set(slot, { relay });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        relay.close();
      }),
    );
    return ServerUrl(
      `${upstreamUrl.protocol}//${PROXY_HOST}:${String(relay.port)}${upstreamUrl.pathname}${upstreamUrl.search}`,
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
  return Effect.sync(() => {
    proxy.relay.sever();
    const correlationId = Schema.decodeSync(CorrelationId)(crypto.randomUUID());
    return {
      correlationId,
      fault,
      revert: () =>
        Effect.sync(() => {
          proxy.relay.heal();
        }).pipe(Effect.withSpan("World.revert")),
    };
  });
}
