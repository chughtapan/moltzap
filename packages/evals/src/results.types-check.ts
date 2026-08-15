/**
 * @file The result-store layer consumes only portable filesystem capabilities.
 *
 * Keeping Node services out of this boundary lets the application select its
 * runtime once at the CLI edge.
 */

import type { FileSystem, Path } from "@effect/platform";
import type * as Layer from "effect/Layer";
import type { evaluationResultStoreLayer } from "./results.js";

type Equal<Left, Right> = [Left, Right] extends [Right, Left] ? true : false;
type Expect<Value extends true> = Value;
type ResultStoreRequirements = Layer.Layer.Context<
  ReturnType<typeof evaluationResultStoreLayer>
>;

/** Compile-time assertion for the result store's platform requirements. */
export type ResultStoreCanary = Expect<
  Equal<ResultStoreRequirements, FileSystem.FileSystem | Path.Path>
>;
