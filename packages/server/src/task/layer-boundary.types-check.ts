import { Effect } from "effect";
import { Type } from "@sinclair/typebox";
import { defineRpc } from "@moltzap/protocol";
import { defineTaskMethod } from "./handlers/define-method.js";
import { NetworkLayerScope } from "../network/layer-scope.js";
import { TaskLayerScope } from "./layer-scope.js";
import { AppLayerScope } from "../app/layer-scope.js";

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

// Positive: task handlers may yield from network and task scopes.
defineTaskMethod(Probe, { handler: okHandler });

const badHandler = () =>
  Effect.gen(function* () {
    yield* AppLayerScope;
    return {};
  });

// Negative: task handler may not require AppLayerScope.
// @ts-expect-error - task handler may not require AppLayerScope
defineTaskMethod(Probe, { handler: badHandler });
