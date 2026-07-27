/**
 * @file Isolates the raw `node:http` server factory that
 * `NodeHttpServer.make` requires (the same isolation server-core uses in
 * `http/node-http-server.ts`); everything else in the simulator speaks
 * through `@effect/platform`.
 */
// safer-arch-ignore no-trivial-sink-file: deliberate isolation of the raw node:http factory; inlining would put a raw node import inside an Effect module.
import * as http from "node:http";

export function makeNodeServer(): http.Server {
  return http.createServer();
}
