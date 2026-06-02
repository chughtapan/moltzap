import { Effect } from "effect";
import { AgentCallableGroup } from "@moltzap/protocol";
import type { RpcGroup } from "@effect/rpc";
import {
  TransportRpcError,
  type Transport as TransportSurface,
  type TransportError,
} from "../transport.js";
import type {
  PayloadForTag,
  SuccessForTag,
} from "../../runtime/typed-dispatch.js";

type AgentCallableRpcs = RpcGroup.Rpcs<typeof AgentCallableGroup>;
type AgentCallableTag = AgentCallableRpcs["_tag"];

export interface TestTransportCall {
  readonly method: string;
  readonly params: unknown;
}

export const makeFakeTransport = (
  respond: (call: TestTransportCall) => unknown | Error,
): {
  readonly calls: TestTransportCall[];
  readonly transport: TransportSurface;
} => {
  const calls: TestTransportCall[] = [];
  const transport: TransportSurface = {
    kind: "test",
    rpc: <Tag extends AgentCallableTag>(
      tag: Tag,
      payload: PayloadForTag<AgentCallableRpcs, Tag>,
    ): Effect.Effect<SuccessForTag<AgentCallableRpcs, Tag>, TransportError> => {
      const call = { method: tag, params: payload };
      calls.push(call);
      const out = respond(call);
      if (out instanceof Error) {
        return Effect.fail(
          new TransportRpcError({
            method: tag,
            tag: "Unauthorized",
            message: out.message,
          }),
        );
      }
      // The fake harness asserts on the recorded `calls`, not on the typed
      // result; the canned response is the matching method's success by test
      // construction.
      // eslint-disable-next-line agent-code-guard/as-unknown-as -- test fixture: the canned `respond` value stands in for the method's success type, asserted via `calls`.
      return Effect.succeed(out as SuccessForTag<AgentCallableRpcs, Tag>);
    },
  };
  return { calls, transport };
};
