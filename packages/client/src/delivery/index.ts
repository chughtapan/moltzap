/** @file One service's delivery and the pass that classifies and publishes pending items, for the service to compose. */

/** The service's delivery state, inbox writes and host operations. */
export { type HostDelivery, makeHostDelivery } from "./host-delivery.js";
/** One classification and publication pass over pending deliveries. */
export { offerPendingMessages, type PendingOffer } from "./pass.js";
