/** @file Mechanism-neutral infrastructure failure exposed by run outcomes. */

import { Data } from "effect";

/** Infrastructure loss that ends a run without exposing its backend. */
export class SimulatorInfrastructureFailure extends Data.TaggedError(
  "SimulatorInfrastructureFailure",
)<{ readonly detail: string }> {}
