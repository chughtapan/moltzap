/**
 * @file Notification consumer helpers for `@moltzap/client/notification`.
 */

/** Re-exports the public API from `./errors.js`. */
export {
  type NotificationConsumerError,
  StreamClosedError as NotificationStreamClosedError,
  NotificationTimeoutError,
  type StreamCloseReason,
} from "./errors.js";
