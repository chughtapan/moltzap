/**
 * Shared test helpers for openclaw-channel integration tests.
 *
 * Agent-only: schema dropped users + contacts (commit de304fa). Helpers now
 * register agents via HTTP only and operate exclusively on agent identifiers
 * exposed by `/api/v1/auth/register`.
 */

import { inject } from "vitest";
import type { Message } from "@moltzap/protocol";

export async function registerAndClaim(name: string): Promise<{
  apiKey: string;
  agentId: string;
  claimToken: string;
}> {
  const baseUrl = inject("baseUrl");

  const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    throw new Error(
      `Register ${name} failed: ${res.status} ${await res.text()}`,
    );
  }
  return (await res.json()) as {
    agentId: string;
    apiKey: string;
    claimToken: string;
  };
}

export function extractMessage(event: { data: unknown }): Message {
  return (event.data as { message: Message }).message;
}

export function extractConvId(result: unknown): string {
  return (result as { conversation: { id: string } }).conversation.id;
}

export function extractText(message: Message): string {
  const part = message.parts[0];
  return part && "text" in part ? part.text : "";
}

export function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) {
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        reject(new Error("waitFor timeout"));
      } else {
        setTimeout(check, 50);
      }
    };
    check();
  });
}
