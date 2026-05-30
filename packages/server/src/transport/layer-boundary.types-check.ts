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

// `callablePrincipal: "agent"` on every binding here — these canaries exercise
// the orthogonal LAYER (R-channel) boundary, not the principal axis (#705
// #720). Each `def` object is pre-declared so the `defineX(...)` call stays a
// single line and the `@ts-expect-error` directive aligns with the call (the
// layer-bound violation surfaces on the negative `def`s' R-channel).
const p = "agent" as const;

const defEmpty = { callablePrincipal: p, handler: empty };
const defNetworkScope = { callablePrincipal: p, handler: yieldsNetworkScope };
const defAllScopes = { callablePrincipal: p, handler: yieldsAllScopes };
const defTaskScope = { callablePrincipal: p, handler: yieldsTaskScope };
const defAppScope = { callablePrincipal: p, handler: yieldsAppScope };
const defConversation = {
  callablePrincipal: p,
  handler: yieldsConversationService,
};
const defContacts = { callablePrincipal: p, handler: yieldsContactsService };
const defAppHost = { callablePrincipal: p, handler: yieldsAppHost };

defineNetworkMethod(AgentsLookup, defEmpty);
defineTaskMethod(AgentsLookup, defNetworkScope);
defineAppMethod(AgentsLookup, defAllScopes);

// @ts-expect-error - network handler may not require TaskLayerScope
defineNetworkMethod(AgentsLookup, defTaskScope);

// @ts-expect-error - network handler may not require AppLayerScope
defineNetworkMethod(AgentsLookup, defAppScope);

// @ts-expect-error - network handler may not yield from a task-layer service
defineNetworkMethod(AgentsLookup, defConversation);

// @ts-expect-error - network handler may not yield from contacts (task-layer)
defineNetworkMethod(AgentsLookup, defContacts);

// @ts-expect-error - network handler may not yield from app-layer service
defineNetworkMethod(AgentsLookup, defAppHost);

// @ts-expect-error - task handler may not require AppLayerScope
defineTaskMethod(AgentsLookup, defAppScope);

// @ts-expect-error - task handler may not yield from app-layer service
defineTaskMethod(AgentsLookup, defAppHost);
