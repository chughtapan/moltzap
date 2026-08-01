/** @file Directed-link control contracts for router implementations. */

import { Context, Data, Duration, Effect, type Scope } from "effect";
import type { AgentId } from "@moltzap/protocol/identity";
import type { Message } from "@moltzap/protocol/message";
import type { ParticipantHandle } from "./participant.js";
import type { NetworkFailure } from "./router.js";

/** One committed message about to cross a directed link. */
export interface LinkDelivery {
  /** Message sender identity. */
  readonly from: AgentId;
  /** Receiving participant identity. */
  readonly to: AgentId;
  /** Router message carried by the delivery. */
  readonly message: Message;
}

/** Closed per-delivery decision returned by a link policy. */
export type LinkVerdict = Data.TaggedEnum<{
  deliver: Record<never, never>;
  drop: { readonly reason?: string };
  delay: { readonly duration: Duration.Duration };
  hold: Record<never, never>;
}>;

/** Constructors and matchers for the closed verdict union. */
export const linkVerdict = Data.taggedEnum<LinkVerdict>();

/**
 * Decides one delivery on a directed link. A policy reads only its input and
 * the ambient Clock; the link interpreter, never the policy, spends time and
 * records evidence.
 */
export type LinkPolicy = (delivery: LinkDelivery) => Effect.Effect<LinkVerdict>;

/** Canonical link policies for the common traffic shapes. */
export const linkPolicy: {
  /** Deliver every message unchanged. */
  readonly passthrough: LinkPolicy;
  /** Drop every message, recording the optional reason with each drop. */
  readonly dropAll: (reason?: string) => LinkPolicy;
  /** Delay every message by one fixed duration. */
  readonly delay: (duration: Duration.DurationInput) => LinkPolicy;
  /** Park every message until the installing lease clears. */
  readonly hold: LinkPolicy;
} = Object.freeze({
  passthrough: () => Effect.succeed(linkVerdict.deliver()),
  dropAll: (reason?: string) => () =>
    Effect.succeed(linkVerdict.drop({ reason })),
  delay: (duration: Duration.DurationInput) => {
    const decoded = Duration.decode(duration);
    return () => Effect.succeed(linkVerdict.delay({ duration: decoded }));
  },
  hold: () => Effect.succeed(linkVerdict.hold()),
});

/** Removes one installed policy from its directed link. */
export interface LinkPolicyLease {
  readonly clear: Effect.Effect<void, NetworkFailure>;
}

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
  /**
   * Install one policy on a directed link until the returned lease clears.
   * Policies stack in installation order on the same link.
   */
  readonly apply: (
    from: AgentId,
    to: AgentId,
    policy: LinkPolicy,
    description: string,
  ) => Effect.Effect<LinkPolicyLease, NetworkFailure>;
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
  /** Delay every delivery on one directed link for the current Scope. */
  readonly delay: (
    from: ParticipantHandle,
    to: ParticipantHandle,
    duration: Duration.DurationInput,
  ) => Effect.Effect<void, NetworkFailure, LinkDriver | Scope.Scope>;
  /** Park every delivery on one directed link for the current Scope. */
  readonly hold: (
    from: ParticipantHandle,
    to: ParticipantHandle,
  ) => Effect.Effect<void, NetworkFailure, LinkDriver | Scope.Scope>;
  /** Install one custom policy on a directed link for the current Scope. */
  readonly shape: (
    from: ParticipantHandle,
    to: ParticipantHandle,
    policy: LinkPolicy,
    description: string,
  ) => Effect.Effect<void, NetworkFailure, LinkDriver | Scope.Scope>;
}

/** Experiment-facing directed-link control installed by the run kernel. */
export class LinkController extends Context.Tag(
  "@moltzap/simulator/LinkController",
)<LinkController, LinkControllerService>() {}
