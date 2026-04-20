import { Context, Data, Deferred, Effect, Layer } from "effect";
import type {
  HumanContactRequest,
  HumanContactResponse,
} from "@moltzap/protocol/schemas";
import type { HumanContactError } from "./service.js";

export type RequestId = string & { readonly __brand: "HumanContactRequestId" };

export class UnknownRequestId extends Data.TaggedError(
  "HumanContactUnknownRequestId",
)<{
  readonly requestId: RequestId;
}> {}

export class DuplicateRequestId extends Data.TaggedError(
  "HumanContactDuplicateRequestId",
)<{
  readonly requestId: RequestId;
}> {}

export interface PendingHumanContactRegistry {
  readonly register: (
    requestId: RequestId,
    request: HumanContactRequest,
  ) => Effect.Effect<
    Deferred.Deferred<HumanContactResponse, HumanContactError>,
    DuplicateRequestId
  >;

  readonly resolveSuccess: (
    requestId: RequestId,
    response: HumanContactResponse,
  ) => Effect.Effect<void, UnknownRequestId>;

  readonly resolveRejected: (
    requestId: RequestId,
    reason: string,
  ) => Effect.Effect<void, UnknownRequestId>;

  readonly drop: (requestId: RequestId) => Effect.Effect<void, never>;
}

export class PendingHumanContactRegistryTag extends Context.Tag(
  "@moltzap/server/PendingHumanContactRegistry",
)<PendingHumanContactRegistryTag, PendingHumanContactRegistry>() {}

export const PendingHumanContactRegistryLive: Layer.Layer<
  PendingHumanContactRegistryTag,
  never,
  never
> = Layer.effect(
  PendingHumanContactRegistryTag,
  Effect.sync(() => {
    throw new Error("not implemented");
  }),
);
