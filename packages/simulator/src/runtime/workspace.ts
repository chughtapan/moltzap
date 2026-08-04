/** @file Credential profile material shared by container runtimes. */

import type { AgentId, AgentKey, AgentName } from "@moltzap/protocol/identity";
import { Redacted } from "effect";

const PROFILE_CONFIG_INDENT_SPACES = 2;

/** Profile selector shared by isolated runtime containers. */
export const SIMULATOR_PROFILE_NAME = "simulator-agent";

/**
 * Serialize the per-agent MoltZap profile mounted into a runtime container.
 * @param profile Runtime identity and redacted credentials.
 * @param profile.agentName Router-visible agent name.
 * @param profile.agentId Registered agent identity.
 * @param profile.apiKey Registered agent credential.
 * @returns The JSON profile configuration.
 */
export function serializeMoltZapProfileConfig(profile: {
  readonly agentName: AgentName;
  readonly agentId: AgentId;
  readonly apiKey: AgentKey;
}): string {
  return JSON.stringify(
    {
      profiles: {
        [SIMULATOR_PROFILE_NAME]: {
          agentId: profile.agentId,
          apiKey: Redacted.value(profile.apiKey),
          agentName: profile.agentName,
        },
      },
    },
    null,
    PROFILE_CONFIG_INDENT_SPACES,
  );
}
