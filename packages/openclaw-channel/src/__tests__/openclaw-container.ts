/**
 * Shared model configs for integration tests.
 */

import type { ContainerModelConfig } from "../test-utils/container-core.js";
import { Redacted } from "effect";

/** Echo model config — no API key required. */
export function echoModelConfig(echoPort: number): ContainerModelConfig {
  return {
    modelString: "echo/echo-1",
    providerConfig: {
      provider: "echo",
      modelId: "echo-1",
      baseUrl: `http://host.docker.internal:${echoPort}`,
      api: "openai-completions",
      apiKey: Redacted.make("test"),
    },
  };
}
