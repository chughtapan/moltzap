import * as http from "node:http";

/**
 * Creates node http server.
 * @returns The created node http server.
 */
export function makeNodeHttpServer() {
  return http.createServer();
}
