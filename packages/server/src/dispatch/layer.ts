/** @file Dispatch service tags and live layers. */

import { Context, Effect, Layer } from "effect";

import { DbTag } from "#db";
import { ConnectionManagerTag } from "#socket";
import { AppEndpointRegistryTag } from "#identity/apps";
import { ConversationServiceTag } from "#conversation";
import { PresenceServiceTag } from "#network/presence";

import { DispatchAdmissionService } from "./admission.service.js";
import { type LeaseRegistry, makeLeaseRegistry } from "./lease-registry.js";

const LEASE_RETENTION_MINUTES = 5;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const DEFAULT_LEASE_RETENTION_MS =
  LEASE_RETENTION_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND;

export class LeaseRegistryTag extends Context.Tag("moltzap/LeaseRegistry")<
  LeaseRegistryTag,
  LeaseRegistry
>() {}

export class DispatchAdmissionServiceTag extends Context.Tag(
  "moltzap/DispatchAdmissionService",
)<DispatchAdmissionServiceTag, DispatchAdmissionService>() {}

export const LeaseRegistryLive = Layer.effect(
  LeaseRegistryTag,
  Effect.gen(function* () {
    const connections = yield* ConnectionManagerTag;
    const transitionObserver = yield* PresenceServiceTag;
    return yield* makeLeaseRegistry({
      connections,
      leaseRetentionMs: DEFAULT_LEASE_RETENTION_MS,
      transitionObserver,
    });
  }).pipe(Effect.withSpan("LeaseRegistryLive")),
);

export const DispatchAdmissionServiceLive = Layer.effect(
  DispatchAdmissionServiceTag,
  Effect.gen(function* () {
    const db = yield* DbTag;
    const appEndpointRegistry = yield* AppEndpointRegistryTag;
    const leaseRegistry = yield* LeaseRegistryTag;
    const conversations = yield* ConversationServiceTag;
    return new DispatchAdmissionService(
      db,
      appEndpointRegistry,
      leaseRegistry,
      conversations,
    );
  }).pipe(Effect.withSpan("DispatchAdmissionServiceLive")),
);
