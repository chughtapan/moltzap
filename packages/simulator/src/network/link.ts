/** @file Directed-link control contracts for router implementations. */

import { Context, Effect, type Scope } from "effect";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ParticipantHandle } from "./participant.js";
import type { NetworkFailure } from "./router.js";

/**
 * Platform operations that change one directed data-plane link.
 *
 * A failed or interrupted operation leaves the link in its pre-call state;
 * success means the transition has completed. `enable` also terminates when
 * called during scoped release because the simulator awaits cleanup instead
 * of detaching it.
 */
export interface LinkDriverService {
  readonly disable: (
    from: AgentId,
    to: AgentId,
  ) => Effect.Effect<void, NetworkFailure>;
  readonly enable: (
    from: AgentId,
    to: AgentId,
  ) => Effect.Effect<void, NetworkFailure>;
}

/**
 * Platform link implementation. A program only requires this service when it
 * actually acquires a disabled-link scope.
 */
export class LinkDriver extends Context.Tag("@moltzap/simulator/LinkDriver")<
  LinkDriver,
  LinkDriverService
>() {}

/** Run-scoped, evidence-producing directed-link control. */
export interface LinkControllerService {
  /**
   * Keep one directed link disabled for the lifetime of the current Scope.
   * Overlapping acquisitions share a single physical down/up transition.
   */
  readonly disable: (
    from: ParticipantHandle,
    to: ParticipantHandle,
  ) => Effect.Effect<void, NetworkFailure, LinkDriver | Scope.Scope>;
}

/** Experiment-facing directed-link control installed by the run kernel. */
export class LinkController extends Context.Tag(
  "@moltzap/simulator/LinkController",
)<LinkController, LinkControllerService>() {}
