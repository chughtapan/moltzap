/** @file Dispatch-domain service barrel. */

export { DispatchAdmissionService } from "./admission.service.js";
export {
  LeaseInvalidError,
  leaseRecordToWire,
  makeLeaseRegistry,
} from "./lease-registry.js";
export type { LeaseRegistry, LeaseRegistryDeps } from "./lease-registry.js";
