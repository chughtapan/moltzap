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
import type { Effect, Scope } from "effect";
import type { ServerUrl } from "../runtime.js";
import type { AgentName, FaultSpec } from "./run-spec.js";
import type { CorrelationId } from "./ids.js";
import type {
  FaultApplyFailed,
  FaultRevertFailed,
  FaultUnsupported,
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
  // eslint-disable-next-line agent-code-guard/no-raw-throw-new-error -- interface stub; the signature is the contract, the body is downstream
  throw new Error("not implemented");
}
