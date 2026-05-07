import { Effect } from "effect";
import { AgentsLookup } from "@moltzap/protocol";
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

const empty = () => Effect.succeed({ agents: [] });

const yieldsTaskScope = () =>
  Effect.gen(function* () {
    yield* TaskLayerScope;
    return { agents: [] };
  });
const yieldsAppScope = () =>
  Effect.gen(function* () {
    yield* AppLayerScope;
    return { agents: [] };
  });
const yieldsNetworkScope = () =>
  Effect.gen(function* () {
    yield* NetworkLayerScope;
    yield* TaskLayerScope;
    return { agents: [] };
  });
const yieldsAllScopes = () =>
  Effect.gen(function* () {
    yield* NetworkLayerScope;
    yield* TaskLayerScope;
    yield* AppLayerScope;
    return { agents: [] };
  });
const yieldsConversationService = () =>
  Effect.gen(function* () {
    yield* ConversationServiceTag;
    return { agents: [] };
  });
const yieldsContactsService = () =>
  Effect.gen(function* () {
    yield* ContactsServiceTag;
    return { agents: [] };
  });
const yieldsAppHost = () =>
  Effect.gen(function* () {
    yield* AppHostTag;
    return { agents: [] };
  });

defineNetworkMethod(AgentsLookup, { handler: empty });
defineTaskMethod(AgentsLookup, { handler: yieldsNetworkScope });
defineAppMethod(AgentsLookup, { handler: yieldsAllScopes });

// @ts-expect-error - network handler may not require TaskLayerScope
defineNetworkMethod(AgentsLookup, { handler: yieldsTaskScope });

// @ts-expect-error - network handler may not require AppLayerScope
defineNetworkMethod(AgentsLookup, { handler: yieldsAppScope });

// @ts-expect-error - network handler may not yield from a task-layer service
defineNetworkMethod(AgentsLookup, { handler: yieldsConversationService });

// @ts-expect-error - network handler may not yield from contacts (task-layer)
defineNetworkMethod(AgentsLookup, { handler: yieldsContactsService });

// @ts-expect-error - network handler may not yield from app-layer service
defineNetworkMethod(AgentsLookup, { handler: yieldsAppHost });

// @ts-expect-error - task handler may not require AppLayerScope
defineTaskMethod(AgentsLookup, { handler: yieldsAppScope });

// @ts-expect-error - task handler may not yield from app-layer service
defineTaskMethod(AgentsLookup, { handler: yieldsAppHost });
