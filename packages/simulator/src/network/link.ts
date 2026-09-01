/** @file Directed-link control contracts for simulator platforms. */

import type { AgentId, SignedMessage } from "@moltzap/identity";
import {
  Context,
  Data,
  Duration,
  Effect,
  type Scope,
  type Stream,
} from "effect";
import type { NetworkError } from "./failure.js";
import type { ParticipantHandle } from "./participant.js";

/** One opaque signed message about to cross a directed link. */
export interface LinkDelivery {
  /** Message sender identity. */
  readonly from: AgentId;
  /** Receiving participant identity. */
  readonly to: AgentId;
  /** Identity-owned opaque signed message carried by the delivery. */
  readonly message: SignedMessage;
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

/**
 * Wraps one in-process inbound delivery stream with the active policies of its
 * receiver. The stage preserves per-sender FIFO order while letting deliveries
 * from different senders progress independently.
 */
export type InboundLinkStage = <
  A extends { readonly message: SignedMessage },
  E,
>(
  inbound: Stream.Stream<A, E>,
) => Stream.Stream<A, E>;

/** Removes one installed policy from its directed link. */
export interface LinkPolicyLease {
  readonly clear: Effect.Effect<void, NetworkError>;
}

/**
 * Platform operations that change one directed data-plane link.
 *
 * Waiting for the platform's serialization permit is interruptible and leaves
 * the link in its pre-call state. Once the permit is acquired, the mutation is
 * an uninterruptible linearization point and is never rolled back. A pending
 * interruption can therefore surface after the mutation with the link in its
 * post-call state. A typed failure occurs before that point and also leaves the
 * pre-call state. A caller that must own or compensate a committed mutation
 * masks the driver call through scope-finalizer registration. Scoped release
 * awaits `enable` instead of detaching cleanup.
 */
export interface LinkDriverService {
  readonly disable: (
    from: AgentId,
    to: AgentId,
  ) => Effect.Effect<void, NetworkError>;
  readonly enable: (
    from: AgentId,
    to: AgentId,
  ) => Effect.Effect<void, NetworkError>;
  /**
   * Install one policy on a directed link until the returned lease clears.
   * Policies stack in installation order on the same link. The same
   * pre-permit/post-linearization interruption rule applies to `clear`.
   */
  readonly apply: (
    from: AgentId,
    to: AgentId,
    policy: LinkPolicy,
    description: string,
  ) => Effect.Effect<LinkPolicyLease, NetworkError>;
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
  ) => Effect.Effect<void, NetworkError, LinkDriver | Scope.Scope>;
  /** Delay every delivery on one directed link for the current Scope. */
  readonly delay: (
    from: ParticipantHandle,
    to: ParticipantHandle,
    duration: Duration.DurationInput,
  ) => Effect.Effect<void, NetworkError, LinkDriver | Scope.Scope>;
  /** Park every delivery on one directed link for the current Scope. */
  readonly hold: (
    from: ParticipantHandle,
    to: ParticipantHandle,
  ) => Effect.Effect<void, NetworkError, LinkDriver | Scope.Scope>;
  /** Install one custom policy on a directed link for the current Scope. */
  readonly shape: (
    from: ParticipantHandle,
    to: ParticipantHandle,
    policy: LinkPolicy,
    description: string,
  ) => Effect.Effect<void, NetworkError, LinkDriver | Scope.Scope>;
}

/** Experiment-facing directed-link control installed by the run kernel. */
export class LinkController extends Context.Tag(
  "@moltzap/simulator/LinkController",
)<LinkController, LinkControllerService>() {}
