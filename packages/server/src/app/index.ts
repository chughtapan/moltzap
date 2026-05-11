/**
 * `app/` — top protocol layer. AppHost, app registration, lease registry,
 * server boot, layer composition.
 *
 * Layer rules:
 *   - May import: kernels and every other protocol layer.
 *   - May NOT be imported by: any protocol layer (app is the composition root).
 *
 * Public surface: `createCoreApp`, `AppHost`, `LeaseRegistry`, every service
 * Tag/Layer from `layers.ts`, and the `appHandlers` registry.
 */

// `createCoreApp` is the package's composition root — exported from the
// package root barrel (`index.ts`), NOT from this layer barrel. Re-exporting
// it here creates a runtime import cycle: the barrel would pull in
// `server.js` (which imports every layer's handler registry), and any
// cross-layer consumer that yields through this barrel would observe a
// partially-initialized export from each handler module. Layer barrels
// expose primitive surfaces (Tags, Layers, types, services). Composition
// stays at package root.
export type {
  CoreConfig,
  CoreApp,
  AgentId,
  UserId,
  ConversationId,
  ConnectionHook,
  DisconnectionHook,
} from "./types.js";
export { AppId } from "./types.js";

export { AppHost } from "./app-host.js";
export type { ContactService } from "./app-host.js";

export {
  LeaseInvalidError,
  LeaseNotFoundError,
  leaseRecordToWire,
  makeLeaseRegistry,
} from "./lease-registry.js";
export type {
  LeaseBindingTuple,
  LeaseState,
  LeaseVerdict,
  LeaseRecord,
  LeaseMintContext,
  LeaseMintResult,
  Claim,
  LeaseRegistry,
  LeaseRegistryDeps,
} from "./lease-registry.js";

export {
  // Tags
  AgentEndpointResolverTag,
  AppHostTag,
  AppTmRegistryTag,
  AuthServiceTag,
  ConnIdTag,
  ConnectionManagerTag,
  ContactsServiceTag,
  ConversationServiceTag,
  DbTag,
  DeliveryWebhookTag,
  EncryptionTag,
  LeaseRegistryTag,
  MessageServiceTag,
  NetworkSendServiceTag,
  ParticipantServiceTag,
  PresenceServiceTag,
  SessionValidatorTag,
  TaskServiceTag,
  WebhookClientTag,
  // Live Layers
  AgentEndpointResolverLive,
  AppHostLive,
  AppTmRegistryLive,
  AuthServiceLive,
  ConnectionManagerLive,
  ContactsServiceLive,
  ConversationServiceLive,
  LeaseRegistryLive,
  MessageServiceLive,
  NetworkSendServiceLive,
  ParticipantServiceLive,
  PresenceServiceLive,
  TaskServiceLive,
  ServicesLive,
  resolveServices,
} from "./layers.js";
export type { ResolvedServices } from "./layers.js";

// `appHandlers` is internal to the composition root (`server.ts`); the
// package's external API exposes `createCoreApp` instead of the raw registry.
// Keeping the import out of the layer barrel breaks the runtime cycle when
// `apps.handlers.ts` imports from `@moltzap/server-core/transport`.
