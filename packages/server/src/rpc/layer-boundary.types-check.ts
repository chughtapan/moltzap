import { Effect } from "effect";
import { Type } from "@sinclair/typebox";
import { defineRpc } from "@moltzap/protocol";
import {
  defineAppMethod,
  defineNetworkMethod,
  defineTaskMethod,
} from "./define-layered-method.js";
import {
  AppLayerScope,
  NetworkLayerScope,
  TaskLayerScope,
} from "./layer-scopes.js";
import {
  AppHostTag,
  ContactsServiceTag,
  ConversationServiceTag,
} from "../app/layers.js";

const Probe = defineRpc({
  name: "_probe" as const,
  params: Type.Object({}, { additionalProperties: false }),
  result: Type.Object({}, { additionalProperties: false }),
});

const empty = () => Effect.succeed({});

const yieldsTaskScope = () =>
  Effect.gen(function* () {
    yield* TaskLayerScope;
    return {};
  });
const yieldsAppScope = () =>
  Effect.gen(function* () {
    yield* AppLayerScope;
    return {};
  });
const yieldsNetworkScope = () =>
  Effect.gen(function* () {
    yield* NetworkLayerScope;
    yield* TaskLayerScope;
    return {};
  });
const yieldsAllScopes = () =>
  Effect.gen(function* () {
    yield* NetworkLayerScope;
    yield* TaskLayerScope;
    yield* AppLayerScope;
    return {};
  });
const yieldsConversationService = () =>
  Effect.gen(function* () {
    yield* ConversationServiceTag;
    return {};
  });
const yieldsContactsService = () =>
  Effect.gen(function* () {
    yield* ContactsServiceTag;
    return {};
  });
const yieldsAppHost = () =>
  Effect.gen(function* () {
    yield* AppHostTag;
    return {};
  });

defineNetworkMethod(Probe, { handler: empty });
defineTaskMethod(Probe, { handler: yieldsNetworkScope });
defineAppMethod(Probe, { handler: yieldsAllScopes });

// @ts-expect-error - network handler may not require TaskLayerScope
defineNetworkMethod(Probe, { handler: yieldsTaskScope });

// @ts-expect-error - network handler may not require AppLayerScope
defineNetworkMethod(Probe, { handler: yieldsAppScope });

// @ts-expect-error - network handler may not yield from a task-layer service
defineNetworkMethod(Probe, { handler: yieldsConversationService });

// @ts-expect-error - network handler may not yield from contacts (task-layer)
defineNetworkMethod(Probe, { handler: yieldsContactsService });

// @ts-expect-error - network handler may not yield from app-layer service
defineNetworkMethod(Probe, { handler: yieldsAppHost });

// @ts-expect-error - task handler may not require AppLayerScope
defineTaskMethod(Probe, { handler: yieldsAppScope });

// @ts-expect-error - task handler may not yield from app-layer service
defineTaskMethod(Probe, { handler: yieldsAppHost });
