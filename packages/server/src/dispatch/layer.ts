/** @file Dispatch service tags and live layers. */

import { Context, Effect, Layer } from "effect";

import { DbTag } from "#db";
import { ConnectionManagerTag } from "#socket";
import { AppEndpointRegistryTag } from "#identity/apps";

import { DispatchAdmissionService } from "./admission.service.js";
import { makeLeaseRegistry, type LeaseRegistry } from "./lease-registry.js";

const LEASE_RETENTION_MINUTES = 5;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const DEFAULT_LEASE_RETENTION_MS =
  LEASE_RETENTION_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND;

/** Implements lease registry tag. */
export class LeaseRegistryTag extends Context.Tag("moltzap/LeaseRegistry")<
  LeaseRegistryTag,
  LeaseRegistry
>() {}

/** Implements dispatch admission service tag. */
export class DispatchAdmissionServiceTag extends Context.Tag(
  "moltzap/DispatchAdmissionService",
)<DispatchAdmissionServiceTag, DispatchAdmissionService>() {}

/** Provides the lease registry live runtime value. */
export const leaseRegistryLive = Layer.effect(
  LeaseRegistryTag,
  Effect.gen(function* () {
    const connections = yield* ConnectionManagerTag;
    return yield* makeLeaseRegistry({
      connections,
      leaseRetentionMs: DEFAULT_LEASE_RETENTION_MS,
    });
  }).pipe(Effect.withSpan("LeaseRegistryLive")),
);

/** Provides the dispatch admission service live runtime value. */
export const dispatchAdmissionServiceLive = Layer.effect(
  DispatchAdmissionServiceTag,
  Effect.gen(function* () {
    const db = yield* DbTag;
    const appEndpointRegistry = yield* AppEndpointRegistryTag;
    const leaseRegistry = yield* LeaseRegistryTag;
    return new DispatchAdmissionService(db, appEndpointRegistry, leaseRegistry);
  }).pipe(Effect.withSpan("DispatchAdmissionServiceLive")),
);
