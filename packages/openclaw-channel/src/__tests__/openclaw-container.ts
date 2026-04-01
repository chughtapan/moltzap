/**
 * Shared model configs for integration tests.
 */

import type { ContainerModelConfig } from "../test-utils/container-core.js";

/** Echo model config — no API key required. */
export function echoModelConfig(echoPort: number): ContainerModelConfig {
  return {
    provider: "echo",
    modelId: "echo-1",
    modelString: "echo/echo-1",
    providerConfig: {
      baseUrl: `http://host.docker.internal:${echoPort}`,
      api: "openai-completions",
      apiKey: "test",
    },
  };
}
