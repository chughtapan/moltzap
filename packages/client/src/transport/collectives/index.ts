/** @file The collective operations the daemon service composes. */

/** The daemon's stateful gather and all_gather operations. */
export {
  CollectiveEmitError,
  type CollectiveOperations,
  makeCollectiveOperations,
} from "./operation.js";
/** The items those operations emit. */
export type { InboundItem } from "./inbound.js";
/** The collective part carried in a post's content. */
export { collectiveIdOf, readCollectiveValue } from "./wire.js";
