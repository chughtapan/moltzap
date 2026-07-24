/**
 * @file Isolates the raw `node:http` server factory that
 * `NodeHttpServer.make` requires (the same isolation server-core uses in
 * `http/node-http-server.ts`); everything else in the simulator speaks
 * through `@effect/platform`.
 */
import * as http from "node:http";

export function makeNodeServer(): http.Server {
  return http.createServer();
}
