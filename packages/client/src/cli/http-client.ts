import { getHttpUrl, resolveAuth } from "./config.js";
import type { RegisterResult } from "@moltzap/protocol";

function authHeaders(): Record<string, string> {
  const { agentKey } = resolveAuth();
  return { "X-API-Key": agentKey };
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  opts?: { noAuth?: boolean },
): Promise<T> {
  const baseUrl = getHttpUrl();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (!opts?.noAuth) {
    Object.assign(headers, authHeaders());
  }
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

export async function registerAgent(
  name: string,
  inviteCode: string,
  description?: string,
): Promise<RegisterResult> {
  return request<RegisterResult>(
    "POST",
    "/api/v1/auth/register",
    { name, inviteCode, description },
    { noAuth: true },
  );
}
