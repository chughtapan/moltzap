import { MoltZapService } from "../service.js";
import { resolveAuth, getServerUrl } from "./config.js";

interface HelloOk {
  agentId: string;
  conversations?: unknown[];
  unreadCounts?: Record<string, number>;
}

/**
 * Connect to MoltZap, run a callback, close the connection, handle errors.
 * All CLI commands should use this instead of manually constructing MoltZapService.
 */
export async function withService<T>(
  fn: (service: MoltZapService, hello: HelloOk) => Promise<T>,
): Promise<T> {
  const service = new MoltZapService({
    serverUrl: getServerUrl(),
    agentKey: resolveAuth().agentKey,
  });
  try {
    const hello = await service.connect();
    return await fn(service, hello as HelloOk);
  } catch (err) {
    console.error(
      `Failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  } finally {
    service.close();
  }
}
