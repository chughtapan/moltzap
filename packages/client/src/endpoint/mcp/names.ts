/** @file The MCP tool, Events, and metadata names hosts and the loopback MCP share. */

/** A content-free wakeup to read the classified runtime inbox. */
export const INBOX_PENDING_EVENT = "moltzap.inbox.pending";

/** Classified content delivered directly to a webhook consumer. */
export const INBOX_ITEM_EVENT = "moltzap.inbox.item";

/** Semantic retrieval of content referenced by a large webhook event. */
export const HARNESS_READ_EVENT_TOOL = "read_event";

/** Adapter operation performing one collective operation. */
export const HARNESS_SEND_TOOL = "send_message";

/** Runtime send options travel outside model-generated tool arguments. */
export const HARNESS_SEND_META_KEY = "xyz.moltzap/send";

/** Retires an inbox item after its host-specific acceptance contract is met. */
export const HARNESS_ACKNOWLEDGE_DELIVERY_TOOL = "acknowledge_delivery";

/** Runtime read of classified deliveries whose host acceptance is pending. */
export const HARNESS_READ_INBOX_TOOL = "read_inbox";

/** Lookup of a retained invocation, distinct from collective completion. */
export const HARNESS_READ_SEND_TOOL = "read_send";
