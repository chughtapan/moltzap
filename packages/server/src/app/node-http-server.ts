import * as http from "node:http";

export function createNodeHttpServer(): http.Server {
  return http.createServer();
}
