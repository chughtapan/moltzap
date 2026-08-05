/**
 * Type canary: a private container realization preserves its runtime's exact
 * principal gateway and acquisition-error types through render and attach.
 */

import type { Effect } from "effect";
import type { OpenClawGateway } from "./openclaw/gateway.js";
import { openClawRuntime } from "./openclaw/runtime.js";
import type { RuntimeAcquisitionError } from "./agent.js";
import {
  containerRuntimeFor,
  type Application,
  type ContainerRuntime,
} from "./container.js";

type Equal<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;

const runtime = openClawRuntime();

/** Stock OpenClaw preserves its exact private container realization type. */
export const openClawContainerRuntimeCanary:
  | ContainerRuntime<OpenClawGateway, RuntimeAcquisitionError>
  | undefined = containerRuntimeFor(runtime);

type OpenClawApplication = Application<
  OpenClawGateway,
  RuntimeAcquisitionError
>;
type AttachedOpenClaw = Effect.Effect.Success<
  ReturnType<OpenClawApplication["attach"]>
>;

/** The controller bridge yields OpenClaw's native gateway and nothing else. */
export const attachReturnsExactGateway: Equal<
  AttachedOpenClaw,
  OpenClawGateway
> = true;

/** The controller bridge retains OpenClaw's acquisition failure channel. */
export const attachPreservesAcquisitionError: Equal<
  Effect.Effect.Error<ReturnType<OpenClawApplication["attach"]>>,
  RuntimeAcquisitionError
> = true;
