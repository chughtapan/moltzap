import { Effect } from "effect";
import { Type } from "@sinclair/typebox";
import { defineRpc } from "@moltzap/protocol";
import {
  defineAppMethod,
  defineNetworkMethod,
} from "../rpc/define-layered-method.js";
import {
  NetworkLayerScope,
  TaskLayerScope,
  AppLayerScope,
} from "../rpc/layer-scopes.js";

const Probe = defineRpc({
  name: "app/_probe" as const,
  params: Type.Object({}, { additionalProperties: false }),
  result: Type.Object({}, { additionalProperties: false }),
});

const okAppHandler = () =>
  Effect.gen(function* () {
    yield* NetworkLayerScope;
    yield* TaskLayerScope;
    yield* AppLayerScope;
    return {};
  });

defineAppMethod(Probe, { handler: okAppHandler });

const appShapedHandler = () =>
  Effect.gen(function* () {
    yield* AppLayerScope;
    return {};
  });

// @ts-expect-error - cannot register an app-scoped handler at the network layer
defineNetworkMethod(Probe, { handler: appShapedHandler });
