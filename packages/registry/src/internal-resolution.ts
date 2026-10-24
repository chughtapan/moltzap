/** @file Limits Registry's private Identity resolution to Registry-owned modules. */
import { NodeRuntime } from "@effect/platform-node";
import { ConfigProvider, Console, Effect } from "effect";
import { registerHooks } from "node:module";

const REGISTRY_MODULE_ROOTS = [
  new URL("../dist/", import.meta.url).href,
  new URL("../bin/", import.meta.url).href,
];

/** External consumers retain their original export conditions after Registry starts. */
export function installInternalResolution(): void {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (
        !REGISTRY_MODULE_ROOTS.some(
          (root) => context.parentURL?.startsWith(root) === true,
        )
      ) {
        return nextResolve(specifier, context);
      }
      return nextResolve(specifier, {
        ...context,
        conditions: [...context.conditions, "sharness-internal"],
      });
    },
  });
}

/** Reports startup failures with their causes and runs the process with environment configuration. */
export function runRegistryMain<E>(program: Effect.Effect<void, E>): void {
  program.pipe(
    Effect.catchAll((error) =>
      Console.error(
        error instanceof Error ? error.message : String(error),
      ).pipe(
        Effect.andThen(
          Effect.sync(() => {
            process.exitCode = 1;
          }),
        ),
      ),
    ),
    Effect.withConfigProvider(ConfigProvider.fromEnv()),
    NodeRuntime.runMain,
  );
}
