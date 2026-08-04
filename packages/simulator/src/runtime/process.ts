/** @file Shared failure returned by runtime-specific container bridges. */

import { Schema } from "effect";

/** A runtime application or its native gateway did not become ready. */
export class RuntimeAcquisitionFailed extends Schema.TaggedError<RuntimeAcquisitionFailed>()(
  "RuntimeAcquisitionFailed",
  {
    runtime: Schema.NonEmptyString,
    agent: Schema.NonEmptyString,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `${this.runtime} runtime for "${this.agent}" failed to start: ${this.detail}`;
  }
}
