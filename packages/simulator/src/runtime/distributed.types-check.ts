/**
 * Type canary: a private distributed capability preserves its runtime's exact
 * principal gateway and acquisition-error types through render and attach.
 */

import type { Effect } from "effect";
import type { OpenClawGateway } from "./openclaw/gateway.js";
import { openClawRuntime } from "./openclaw/runtime.js";
import type { RuntimeAcquisitionFailed } from "./process.js";
import {
  distributedRuntimeCapability,
  type DistributedRuntimeApplication,
  type DistributedRuntimeCapability,
} from "./distributed.js";
import type { RunningAgent } from "./runtime.js";

type Equal<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;

const runtime = openClawRuntime();

/** Stock OpenClaw preserves its exact private distributed capability type. */
export const openClawDistributedCapabilityCanary:
  | DistributedRuntimeCapability<OpenClawGateway, RuntimeAcquisitionFailed>
  | undefined = distributedRuntimeCapability(runtime);

type OpenClawDistributedApplication = DistributedRuntimeApplication<
  OpenClawGateway,
  RuntimeAcquisitionFailed
>;
type AttachedOpenClaw = Effect.Effect.Success<
  ReturnType<OpenClawDistributedApplication["attach"]>
>;

/** The controller bridge yields OpenClaw's native typed running agent. */
export const distributedAttachReturnsExactRunningAgent: Equal<
  AttachedOpenClaw,
  RunningAgent<OpenClawGateway>
> = true;

/** The controller bridge retains OpenClaw's acquisition failure channel. */
export const distributedAttachPreservesAcquisitionError: Equal<
  Effect.Effect.Error<ReturnType<OpenClawDistributedApplication["attach"]>>,
  RuntimeAcquisitionFailed
> = true;
