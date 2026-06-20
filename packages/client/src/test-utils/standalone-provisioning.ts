import { Effect } from "effect";
import {
  registerAgent,
  type RegisterAgentError,
  type RegisterResponse,
} from "../auth.js";

export interface StandaloneAgentPairNames {
  readonly first: string;
  readonly second: string;
}

export interface StandaloneAgentPair {
  readonly first: RegisterResponse;
  readonly second: RegisterResponse;
}

/**
 * Provision agents through a spawned MoltZap server's public registration
 * boundary. Use this for black-box standalone integration tests. In-process
 * tests with direct DB access should use server-core's `createTestAgent`.
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
