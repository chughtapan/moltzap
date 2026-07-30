import { Effect } from "effect";
import type { RpcGroup } from "@effect/rpc";
import {
  TransportRpcError,
  type Transport as TransportSurface,
  type TransportError,
} from "../transport.js";
import type { LocalDaemonRpcs } from "../../local-daemon-rpc.js";
import type { PayloadForTag, SuccessForTag } from "@moltzap/protocol/rpc";

type DaemonRpcs = RpcGroup.Rpcs<typeof LocalDaemonRpcs>;
type DaemonCommand = DaemonRpcs["_tag"];

/** Describes test transport call. */
export interface TestTransportCall<Tag extends DaemonCommand = DaemonCommand> {
  readonly method: Tag;
  readonly params: PayloadForTag<DaemonRpcs, Tag>;
}

/** Represents test transport responder values. */
export type TestTransportResponder<Tag extends DaemonCommand> = (
  call: TestTransportCall<Tag>,
) => SuccessForTag<DaemonRpcs, Tag> | TransportError | Error;

/** Represents test transport responders values. */
export type TestTransportResponders = {
  readonly [Tag in DaemonCommand]?: TestTransportResponder<Tag>;
};

const isTransportError = (value: unknown): value is TransportError =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  "message" in value;

const isError = (value: unknown): value is Error => value instanceof Error;
const errorMessage = (error: Error): string => error.message;

/**
 * Provides the make fake transport runtime value.
 * @param responders Value supplied to the operation.
 * @returns The created fake transport.
 */
export const makeFakeTransport = (
  responders: TestTransportResponders,
): {
  readonly calls: TestTransportCall[];
  readonly transport: TransportSurface;
} => {
  const calls: TestTransportCall[] = [];
  const transport: TransportSurface = {
    command: <Tag extends DaemonCommand>(
      tag: Tag,
      payload: PayloadForTag<DaemonRpcs, Tag>,
    ): Effect.Effect<SuccessForTag<DaemonRpcs, Tag>, TransportError> => {
      const call: TestTransportCall<Tag> = { method: tag, params: payload };
      calls.push(call);
      const respond = responders[tag];
      if (respond === undefined) {
        return Effect.dieMessage(`No test transport responder for ${tag}`);
      }
      const out = respond(call);
      if (isTransportError(out)) {
        return Effect.fail(out);
      }
      if (isError(out)) {
        return Effect.fail(
          new TransportRpcError({
            method: tag,
            tag: "Unauthorized",
            message: errorMessage(out),
          }),
        );
      }
      return Effect.succeed(out);
    },
  };
  return { calls, transport };
};
