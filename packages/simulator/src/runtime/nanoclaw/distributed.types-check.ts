/**
 * Type canary: NanoClaw's private Kubernetes realization preserves its exact
 * native gateway and acquisition-error types through render and attach.
 */

import type { Effect } from "effect";
import {
  distributedRuntimeCapability,
  type DistributedRuntimeApplication,
  type DistributedRuntimeCapability,
} from "../distributed.js";
import type { RuntimeAcquisitionFailed } from "../process.js";
import type { RunningAgent } from "../runtime.js";
import type { NanoclawGateway } from "./gateway.js";
import { nanoclawRuntime } from "./runtime.js";

type Equal<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;

const runtime = nanoclawRuntime({
  applicationImage:
    "example.invalid/nanoclaw@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
});

/** Configured NanoClaw preserves its exact private distributed capability. */
export const nanoclawDistributedCapabilityCanary:
  | DistributedRuntimeCapability<NanoclawGateway, RuntimeAcquisitionFailed>
  | undefined = distributedRuntimeCapability(runtime);

type NanoclawDistributedApplication = DistributedRuntimeApplication<
  NanoclawGateway,
  RuntimeAcquisitionFailed
>;
type AttachedNanoclaw = Effect.Effect.Success<
  ReturnType<NanoclawDistributedApplication["attach"]>
>;

/** The controller bridge yields NanoClaw's native typed running agent. */
export const distributedNanoclawAttachReturnsExactRunningAgent: Equal<
  AttachedNanoclaw,
  RunningAgent<NanoclawGateway>
> = true;

/** The bridge retains NanoClaw's acquisition failure channel. */
export const distributedNanoclawAttachPreservesAcquisitionError: Equal<
  Effect.Effect.Error<ReturnType<NanoclawDistributedApplication["attach"]>>,
  RuntimeAcquisitionFailed
> = true;
