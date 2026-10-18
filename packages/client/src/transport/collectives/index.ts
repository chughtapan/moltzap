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

/** Application admission retains the exact collective content and completion boundary. */
export type { CollectiveSendOutcome } from "./forms.js";
/** Certified multicast projection preserves every non-protocol content part. */
export {
  encodeCollectiveContent,
  readCollectiveValue,
  withoutCollectivePart,
} from "./part/index.js";
