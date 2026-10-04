/** @file The collective operations the daemon service composes. */

/** The daemon's stateful gather and all_gather operations. */
export {
  type CollectiveOperations,
  makeCollectiveOperations,
} from "./operation.js";
/** The failure an emit port returns when the service cannot keep an item. */
export { CollectiveEmitError } from "./forms.js";
/** The items those operations emit. */
export type { InboundItem } from "./inbound.js";
/** The collective part carried in a post's content. */
export { collectiveIdOf, readCollectiveValue } from "./part/index.js";
