import { Effect } from "effect";
import { Type } from "@sinclair/typebox";
import { defineRpc } from "@moltzap/protocol";
import { defineAppMethod } from "./handlers/define-method.js";
import { defineNetworkMethod } from "../network/handlers/define-method.js";
import { NetworkLayerScope } from "../network/layer-scope.js";
import { TaskLayerScope } from "../task/layer-scope.js";
import { AppLayerScope } from "./layer-scope.js";

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

// Positive: app handlers may yield from any layer scope.
defineAppMethod(Probe, { handler: okAppHandler });

const appShapedHandler = () =>
  Effect.gen(function* () {
    yield* AppLayerScope;
    return {};
  });

// Negative: an app-scoped handler can't be passed to defineNetworkMethod.
// @ts-expect-error - cannot register an app-scoped handler at the network layer
defineNetworkMethod(Probe, { handler: appShapedHandler });
