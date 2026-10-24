/** @file Node's listener constructor and host types for the Effect HTTP server adapter. */
export { createServer } from "node:http";

/** Node host types required by the platform adapter callbacks. */
export type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from "node:http";
