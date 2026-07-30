import { Effect } from "effect";
import {
  registerAgent,
  type RegisterAgentError,
  type RegisterResponse,
} from "../auth.js";

/** Describes standalone agent pair names. */
export interface StandaloneAgentPairNames {
  readonly first: string;
  readonly second: string;
}

/** Describes standalone agent pair. */
export interface StandaloneAgentPair {
  readonly first: RegisterResponse;
  readonly second: RegisterResponse;
}

/**
 * Provision agents through a spawned MoltZap server's public registration
 * boundary. Use this for black-box standalone integration tests. In-process
 * tests with direct DB access should use server-core's `createTestAgent`.
 * @param baseUrl Value supplied to the operation.
 * @param names Value supplied to the operation.
 * @returns The register standalone agent pair result.
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
