import { Effect } from "effect";
import { Type } from "@sinclair/typebox";
import { defineRpc } from "@moltzap/protocol";
import { defineTaskMethod } from "../rpc/define-layered-method.js";
import {
  NetworkLayerScope,
  TaskLayerScope,
  AppLayerScope,
} from "../rpc/layer-scopes.js";

const Probe = defineRpc({
  name: "task/_probe" as const,
  params: Type.Object({}, { additionalProperties: false }),
  result: Type.Object({}, { additionalProperties: false }),
});

const okHandler = () =>
  Effect.gen(function* () {
    yield* NetworkLayerScope;
    yield* TaskLayerScope;
    return {};
  });

defineTaskMethod(Probe, { handler: okHandler });

const badHandler = () =>
  Effect.gen(function* () {
    yield* AppLayerScope;
    return {};
  });

// @ts-expect-error - task handler may not require AppLayerScope
defineTaskMethod(Probe, { handler: badHandler });
