/** @file Runtime helpers for RPC validation and request coalescing. */

export { InvalidParamsError } from "./errors.js";
export { validateParams, type Validator } from "./validator.js";
export { coalesce, drainCoalesceMap } from "./coalesce.js";
