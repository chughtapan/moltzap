/**
 * Per-layer Tag allowlists. The hierarchy mirrors the protocol layer stack:
 *
 *   transport ─ identity ─ network ─ task ─ app
 *
 * Each layer's allowed Tag union is a superset of the layer below it. The
 * `defineXMethod` wrappers in `define-layered-method.ts` use these as
 * generic-constraint upper bounds so a handler at layer L cannot pull a
 * service that only layer L+1 owns.
 *
 * **Maintenance contract.** Adding a new service Tag is a TWO-step edit
 * that lands in the same PR:
 *   1. Add the Tag to the appropriate alias here.
 *   2. Update the matching `architectureOptions.layers` rule in the root
 *      `eslint.config.js` so the structural lint and the type system agree.
 *
 * The two-source-of-truth shape is intentional and named in §10 of the
 * Phase 2A architect plan; the user explicitly accepted the maintenance
 * cost over a codegen pipeline.
 */
import type { ConnIdTag } from "../app/layers.js";
import type {
  AuthServiceTag,
  AgentEndpointResolverTag,
  NetworkSendServiceTag,
  ConnectionManagerTag,
  MessageServiceTag,
  ConversationServiceTag,
  TaskServiceTag,
  AppHostTag,
  LeaseRegistryTag,
  AppTmRegistryTag,
} from "../app/layers.js";

/** Bottom kernel — the per-request connection id. */
export type TransportTags = ConnIdTag;

/** Identity-layer allowlist: registration, claim, login, contacts. */
export type IdentityTags =
  | TransportTags
  | AuthServiceTag
  | AgentEndpointResolverTag;

/** Network-layer allowlist: Connect, presence, send/broadcast. */
export type NetworkTags =
  | IdentityTags
  | NetworkSendServiceTag
  | ConnectionManagerTag;

/** Task-layer allowlist: conversations, messages, tasks. */
export type TaskTags =
  | NetworkTags
  | MessageServiceTag
  | ConversationServiceTag
  | TaskServiceTag;

/** App-layer allowlist: app-host, lease registry, app-TM registry. */
export type AppTags =
  | TaskTags
  | AppHostTag
  | LeaseRegistryTag
  | AppTmRegistryTag;
