/**
 * @file Provisions paired black-box test identities exclusively through the
 * public registration boundary.
 */
import { Effect } from "effect";
import {
  registerAgent,
  type RegisterAgentError,
  type RegisterResponse,
} from "../auth.js";

/** Display names assigned to the two independently registered agents. */
export interface StandaloneAgentPairNames {
  readonly first: string;
  readonly second: string;
}

/** Registration responses returned for both members of the pair. */
export interface StandaloneAgentPair {
  readonly first: RegisterResponse;
  readonly second: RegisterResponse;
}

/**
 * Provisions two agents through a running MoltZap endpoint's public
 * registration boundary. The helper deliberately exposes no storage or
 * process internals, keeping its consumers black-box.
 *
 * @param baseUrl HTTP origin of the registration boundary.
 * @param names Display names for the two registrations.
 * @returns Both independently issued registration responses.
 */
export function registerStandaloneAgentPair(
  baseUrl: string,
  names: StandaloneAgentPairNames,
): Effect.Effect<StandaloneAgentPair, RegisterAgentError> {
  return Effect.all(
    {
      first: registerAgent(baseUrl, names.first),
      second: registerAgent(baseUrl, names.second),
    },
    { concurrency: 2 },
  ).pipe(Effect.withSpan("registerStandaloneAgentPair"));
}
