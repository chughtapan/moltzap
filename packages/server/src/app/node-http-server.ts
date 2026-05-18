import * as http from "node:http";

export function makeNodeHttpServer() {
  return http.createServer();
}
