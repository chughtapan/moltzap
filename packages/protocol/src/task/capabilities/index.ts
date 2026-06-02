/**
 * @file Public barrel for the capability/permission tag classes.
 *
 * Each tag is a permission the server's `*AuthMw` proves before a handler runs:
 * the tag class + its value type + the wire errors its proof can fail with
 * (`static get errors()`). The `obtain*` impls that resolve a permission against
 * server-side services live in `@moltzap/server-core`, paired with their
 * `CapabilityMiddleware` in `app/capability-middlewares.ts`.
 */

export * from "./task-read-access.js";
export * from "./conversation-in-task.js";
export * from "./conversation-send-access.js";
export * from "./contact-policy-allows-reach.js";
export * from "./conversation-create-authorization.js";
export * from "./assert-capability-matches-task.js";
