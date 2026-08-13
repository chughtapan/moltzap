/**
 * Type canary: NanoClaw's private container realization preserves its exact
 * native gateway and acquisition-error types through render and attach while
 * accepting only the runtime-owned agent name during rendering.
 */

import type { Effect } from "effect";
import {
  containerRuntimeFor,
  image,
  type Application,
  type ContainerRuntime,
} from "../container.js";
import type { RuntimeAcquisitionError } from "../agent.js";
import type { NanoClawGateway } from "./gateway.js";
import { nanoclawRuntime } from "./runtime.js";

type Equal<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;

const runtime = nanoclawRuntime({
  applicationImage: image.make(
    "example.invalid/nanoclaw@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  ),
});

/** Configured NanoClaw preserves its exact private container realization. */
export const nanoclawContainerRuntimeCanary: ContainerRuntime<
  NanoClawGateway,
  RuntimeAcquisitionError
> = containerRuntimeFor(runtime);

type NanoClawApplication = Application<
  NanoClawGateway,
  RuntimeAcquisitionError
>;
type AttachedNanoClaw = Effect.Effect.Success<
  ReturnType<NanoClawApplication["attach"]>
>;

/** The controller bridge yields NanoClaw's native gateway and nothing else. */
export const nanoclawAttachReturnsExactGateway: Equal<
  AttachedNanoClaw,
  NanoClawGateway
> = true;

/** The bridge retains NanoClaw's acquisition failure channel. */
export const nanoclawAttachPreservesAcquisitionError: Equal<
  Effect.Effect.Error<ReturnType<NanoClawApplication["attach"]>>,
  RuntimeAcquisitionError
> = true;
