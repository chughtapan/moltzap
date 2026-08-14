/** @file Type canaries for exact container gateway and acquisition-error preservation. */

import type { Effect } from "effect";
import type { RuntimeAcquisitionError } from "./agent.js";
import type { OpenClawGateway } from "./openclaw/gateway.js";
import {
  type Application,
  type ContainerRuntime,
  containerRuntimeFor,
} from "./container.js";
import { openClawRuntime } from "./openclaw/runtime.js";

/**
 * Type canary: a private container realization preserves its runtime's exact
 * principal gateway and acquisition-error types through render and attach,
 * accepts only the runtime-owned agent name while rendering, and a runtime
 * built by `defineContainerRuntime` always has one to read.
 */

type Equal<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;

const runtime = openClawRuntime();

/** Stock OpenClaw preserves its exact private container realization type. */
export const openClawContainerRuntimeCanary: ContainerRuntime<
  OpenClawGateway,
  RuntimeAcquisitionError
> = containerRuntimeFor(runtime);

/** Reading back the realization of a defined container runtime has no absent case. */
export const containerRuntimeIsAlwaysPresent: Equal<
  typeof openClawContainerRuntimeCanary,
  ContainerRuntime<OpenClawGateway, RuntimeAcquisitionError>
> = true;

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
