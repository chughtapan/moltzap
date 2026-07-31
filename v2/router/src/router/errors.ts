import { Data } from "effect";

/** The Router connection could not be established or used. */
export class RouterConnectionError extends Data.TaggedError(
  "RouterConnectionError",
) {}

/** The configured complete Router call deadline expired. */
export class RouterRequestTimeoutError extends Data.TaggedError(
  "RouterRequestTimeoutError",
) {}

/** A Router response did not match the selected operation contract. */
export class RouterInvalidResponseError extends Data.TaggedError(
  "RouterInvalidResponseError",
) {}
