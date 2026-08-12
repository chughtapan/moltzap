/** @file Router process entrypoint that launches the production Layer from environment config. */
import { NodeRuntime } from "@effect/platform-node";
import { ConfigProvider, Effect, Layer } from "effect";
import { layer } from "./server.js";

/** Runs the Router server with process environment configuration. */
export const runRouterProcess = (): void => {
  Layer.launch(layer).pipe(
    Effect.withConfigProvider(ConfigProvider.fromEnv()),
    NodeRuntime.runMain,
  );
};
