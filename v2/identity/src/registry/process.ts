import { NodeRuntime } from "@effect/platform-node";
import { ConfigProvider, Effect, Layer } from "effect";
import { layer } from "./server.js";

/** Runs the Registry with process-environment configuration. */
export const runRegistryProcess = (): void => {
  Layer.launch(layer).pipe(
    Effect.withConfigProvider(ConfigProvider.fromEnv()),
    NodeRuntime.runMain,
  );
};
