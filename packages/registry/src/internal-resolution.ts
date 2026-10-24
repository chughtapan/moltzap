/** @file Limits Registry's private Identity resolution to Registry-owned modules. */
import { registerHooks } from "node:module";

const REGISTRY_ROOT = new URL("../", import.meta.url).href;

/** External consumers retain their original export conditions after Registry starts. */
export function installInternalResolution(): void {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL?.startsWith(REGISTRY_ROOT) !== true) {
        return nextResolve(specifier, context);
      }
      return nextResolve(specifier, {
        ...context,
        conditions: [...context.conditions, "sharness-internal"],
      });
    },
  });
}
