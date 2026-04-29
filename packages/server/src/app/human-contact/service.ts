import { Context, Data, Effect, Layer } from "effect";
import type {
  HumanContactRequest,
  HumanContactResponse,
} from "@moltzap/protocol/schemas";

export class TimeoutError extends Data.TaggedError("HumanContactTimeout")<{
  readonly requestId: string;
  readonly timeoutMs: number;
}> {}

export class ConnectionDropped extends Data.TaggedError(
  "HumanContactConnectionDropped",
)<{
  readonly requestId: string;
}> {}

export class RejectedByHuman extends Data.TaggedError(
  "HumanContactRejectedByHuman",
)<{
  readonly requestId: string;
  readonly reason: string;
}> {}

export type HumanContactError =
  | TimeoutError
  | ConnectionDropped
  | RejectedByHuman;

export interface HumanContactService {
  readonly humanContact: (
    req: HumanContactRequest,
  ) => Effect.Effect<HumanContactResponse, HumanContactError, never>;
}

export class HumanContactServiceTag extends Context.Tag(
  "@moltzap/server/HumanContactService",
)<HumanContactServiceTag, HumanContactService>() {}

export const HumanContactServiceLive: Layer.Layer<
  HumanContactServiceTag,
  never,
  never
> = Layer.effect(
  HumanContactServiceTag,
  Effect.sync(() => {
    throw new Error("not implemented");
  }),
);
