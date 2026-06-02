/**
 * @file Re-export of the shared cast-free dispatch over a non-flat `RpcClient`.
 *
 * The mechanism lives in `@moltzap/protocol` (`transport/typed-dispatch.ts`) so
 * the production client and the server's reverse client share one definition.
 * This module keeps the client-local import path stable.
 */
export {
  makeTypedTransportCall,
  type TypedDispatchMap,
  type PayloadForTag,
  type SuccessForTag,
  type ErrorForTag,
} from "@moltzap/protocol";
