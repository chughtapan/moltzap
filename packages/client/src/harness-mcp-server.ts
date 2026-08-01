import {
  type FetchLikeMcpHandler,
  type NodeMcpRequestHandler,
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import type { RequestListener } from "node:http";

const REGISTER_MCP_PATH = "/register/mcp";
const HARNESS_MCP_PATH = "/mcp";
const POST_METHOD = "POST";

const respond = (
  status: number,
  body: string,
  response: Parameters<RequestListener>[1],
  headers: Readonly<Record<string, string>> = {},
): void => {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    ...headers,
  });
  response.end(body);
};

/**
 * Routes the daemon's two loopback MCP surfaces through one Node listener.
 *
 * @param registrationHandler Official SDK handler for registration.
 * @param harnessHandler Official SDK handler for the active agent surface.
 * @returns A guarded Node request listener for both handlers.
 */
export const makeHarnessMcpRequestListener = (
  registrationHandler: FetchLikeMcpHandler,
  harnessHandler: FetchLikeMcpHandler,
): RequestListener => {
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const registrationNodeHandler = toNodeHandler(registrationHandler);
  const harnessNodeHandler = toNodeHandler(harnessHandler);
  const handlers: ReadonlyMap<string, NodeMcpRequestHandler> = new Map([
    [REGISTER_MCP_PATH, registrationNodeHandler],
    [HARNESS_MCP_PATH, harnessNodeHandler],
  ]);

  return (request, response): void => {
    if (
      !validateHost(request, response) ||
      !validateOrigin(request, response)
    ) {
      return;
    }

    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const handler = handlers.get(pathname);

    if (handler === undefined) {
      respond(404, "Not found.", response);
      return;
    }

    if (request.method !== POST_METHOD) {
      respond(405, "Method not allowed.", response, { allow: POST_METHOD });
      return;
    }

    handler(request, response).catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : undefined);
    });
  };
};
