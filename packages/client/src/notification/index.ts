/**
 * @file Notification consumer helpers for `@moltzap/client/notification`.
 */

/** Re-exports the public API from `./errors.js`. */
export {
  NotificationTimeoutError,
  StreamClosedError as NotificationStreamClosedError,
  type StreamCloseReason,
  type NotificationConsumerError,
} from "./errors.js";
