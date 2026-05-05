import { Effect } from "effect";
import { Type } from "@sinclair/typebox";
import { defineRpc } from "@moltzap/protocol";
import { defineNetworkMethod } from "./handlers/define-method.js";
import { TaskLayerScope } from "../task/layer-scope.js";
import { AppLayerScope } from "../app/layer-scope.js";

const Probe = defineRpc({
  name: "network/_probe" as const,
  params: Type.Object({}, { additionalProperties: false }),
  result: Type.Object({}, { additionalProperties: false }),
});

const networkOnlyHandler = () => Effect.succeed({});

// Positive: a handler whose only requirement is the network scope compiles.
defineNetworkMethod(Probe, { handler: networkOnlyHandler });

const handlerNeedingTaskScope = () =>
  Effect.gen(function* () {
    yield* TaskLayerScope;
    return {};
  });

const handlerNeedingAppScope = () =>
  Effect.gen(function* () {
    yield* AppLayerScope;
    return {};
  });

// Negative: a network handler that requires TaskLayerScope is rejected.
// @ts-expect-error - network handler may not require TaskLayerScope
defineNetworkMethod(Probe, { handler: handlerNeedingTaskScope });

// Negative: same shape against AppLayerScope.
// @ts-expect-error - network handler may not require AppLayerScope
defineNetworkMethod(Probe, { handler: handlerNeedingAppScope });
