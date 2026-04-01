/**
 * Shared test helpers for openclaw-channel integration tests.
 *
 * Each worker initializes its own pg.Pool via initWorker() using
 * inject() values from globalSetup.
 */

import pg from "pg";
import { inject } from "vitest";
import type { Message } from "@moltzap/protocol";
import { hashPhone } from "@moltzap/protocol/phone-hash";

let pool: pg.Pool | null = null;

/** Initialize DB connection for this worker. Call once per test file. */
export function initWorker(): void {
  if (pool) return;
  pool = new pg.Pool({
    host: inject("testPgHost"),
    port: inject("testPgPort"),
    user: "test",
    password: "test",
    database: inject("testDbName"),
    max: 3,
  });
}

/** Clean up DB connection. Call in afterAll. */
export async function cleanupWorker(): Promise<void> {
  await pool?.end();
  pool = null;
}

function getPool(): pg.Pool {
  if (!pool) throw new Error("Call initWorker() before using test helpers");
  return pool;
}

export async function registerAndClaim(name: string): Promise<{
  apiKey: string;
  agentId: string;
  userId: string;
  supabaseUid: string;
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
  const reg = (await res.json()) as {
    agentId: string;
    apiKey: string;
    claimToken: string;
  };

  const db = getPool();
  const uid = crypto.randomUUID();
  const phone = `+1555${crypto.randomUUID().replace(/-/g, "").slice(0, 7)}`;

  const result = await db.query(
    `INSERT INTO users (supabase_uid, display_name, phone, phone_hash, status)
     VALUES ($1, $2, $3, $4, 'active') RETURNING id`,
    [uid, `User-${name}`, phone, hashPhone(phone)],
  );
  const userId = result.rows[0].id as string;

  await db.query(
    `UPDATE agents SET owner_user_id = $1, status = 'active' WHERE claim_token = $2`,
    [userId, reg.claimToken],
  );

  return {
    apiKey: reg.apiKey,
    agentId: reg.agentId,
    userId,
    supabaseUid: uid,
    claimToken: reg.claimToken,
  };
}

export async function makeContact(userA: string, userB: string): Promise<void> {
  const db = getPool();
  await db.query(
    `INSERT INTO contacts (requester_id, target_id, status) VALUES ($1, $2, 'accepted')`,
    [userA, userB],
  );
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
