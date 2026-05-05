import { Effect } from "effect";
import { Type } from "@sinclair/typebox";
import { defineRpc } from "@moltzap/protocol";
import { defineNetworkMethod } from "../rpc/define-layered-method.js";
import { TaskLayerScope, AppLayerScope } from "../rpc/layer-scopes.js";

const Probe = defineRpc({
  name: "network/_probe" as const,
  params: Type.Object({}, { additionalProperties: false }),
  result: Type.Object({}, { additionalProperties: false }),
});

const networkOnlyHandler = () => Effect.succeed({});

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

// @ts-expect-error - network handler may not require TaskLayerScope
defineNetworkMethod(Probe, { handler: handlerNeedingTaskScope });

// @ts-expect-error - network handler may not require AppLayerScope
defineNetworkMethod(Probe, { handler: handlerNeedingAppScope });
