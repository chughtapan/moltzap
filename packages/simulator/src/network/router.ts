/** @file Router acquisition, attachment, and lifecycle ports. */

import type { InboundDelivery, SendInput } from "@moltzap/client";
import type { AgentId } from "@moltzap/identity";
import { Context, type Effect, type Scope, type Stream } from "effect";
import type { NetworkError } from "./failure.js";
import type { AgentHandle, ParticipantHandle } from "./participant.js";

const routerStoppedTypeId: unique symbol = Symbol(
  "@moltzap/simulator/RouterStopped",
);
const routerStoppedConstruction: unique symbol = Symbol(
  "@moltzap/simulator/RouterStoppedConstruction",
);

/** Shutdown evidence available only after the Router scope has released. */
export class RouterStopped {
  readonly [routerStoppedTypeId]: typeof routerStoppedTypeId;

  private constructor() {
    this[routerStoppedTypeId] = routerStoppedTypeId;
  }

  static [routerStoppedConstruction](): RouterStopped {
    return new RouterStopped();
  }
}

/**
 * Construct a nominal stop report at a platform boundary.
 * @returns Immutable evidence that the Router scope released.
 */
export function makeRouterStopReport(): RouterStopped {
  return Object.freeze(RouterStopped[routerStoppedConstruction]());
}

/** Nonempty participant identities accepted by a transport boundary. */
export type ParticipantIds = readonly [AgentId, ...(readonly AgentId[])];

/**
 * A ready, scope-owned endpoint attachment. The receive ingress is subscribed
 * before acquisition returns and retains deliveries until its consumer advances.
 */
export interface EndpointTransport {
  readonly received: Stream.Stream<InboundDelivery, NetworkError>;
  readonly send: (input: SendInput) => Effect.Effect<void, NetworkError>;
}

/** Runtime identity issued for one scope-owned autonomous agent. */
export interface AgentConnection<Name extends string = string> {
  readonly agent: AgentHandle<Name>;
}

/** Router output used by an experiment-controlled endpoint. */
export interface AttachedEndpoint<Name extends string> {
  readonly participant: ParticipantHandle<Name>;
  readonly transport: EndpointTransport;
}

/** Run-scoped Router fixture lifecycle. */
export interface Router {
  readonly address: URL;

  /** Awaits the stop report completed by scoped release. */
  readonly stopped: Effect.Effect<RouterStopped, NetworkError>;
}

/** Router acquisition service supplied by the platform Layer. */
export interface RouterProviderService {
  readonly acquire: Effect.Effect<Router, NetworkError, Scope.Scope>;
}

/** Router acquisition service supplied by the platform Layer. */
export class RouterProvider extends Context.Tag(
  "@moltzap/simulator/RouterProvider",
)<RouterProvider, RouterProviderService>() {}
