import Ajv from "ajv";
import addFormats from "ajv-formats";
import type { TSchema, Static } from "@sinclair/typebox";

/**
 * Single shared AJV instance for the protocol package. Both `defineRpc()`
 * and `defineNotification()` register their TypeBox schemas against this
 * instance at module load, so every wire boundary uses the same compiled
 * validator pool with identical options.
 *
 * The instance itself is not exported. AJV's `_compileMetaSchema` mutates
 * its own `opts` on first compile, so `Object.freeze` on the instance
 * would break compilation. Instead, the factory exposes only `compile`,
 * which is the single operation any descriptor needs. Options are sealed
 * inside the closure and unreachable from callers.
 */
const ajvInstance = addFormats(new Ajv({ strict: true, allErrors: true }));

export const ajv: {
  readonly compile: <T extends TSchema>(
    schema: T,
  ) => (data: unknown) => data is Static<T>;
} = Object.freeze({
  compile: <T extends TSchema>(
    schema: T,
  ): ((data: unknown) => data is Static<T>) => {
    const validate = ajvInstance.compile<Static<T>>(schema);
    return (data: unknown): data is Static<T> => validate(data);
  },
});
