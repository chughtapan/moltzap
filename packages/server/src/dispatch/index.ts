/** @file Dispatch-domain service barrel. */

export {
  LeaseInvalidError,
  leaseRecordToWire,
  makeLeaseRegistry,
} from "./lease-registry.js";
export type {
  LeaseRegistry,
  LeaseRegistryDeps,
  LeaseVerdict,
  ModeratorBoundLeaseBinding,
} from "./lease-registry.js";
export {
  lookupAppBoundForConversation,
  type AppBoundConversationLookup,
} from "./app-bound-conversation.js";
