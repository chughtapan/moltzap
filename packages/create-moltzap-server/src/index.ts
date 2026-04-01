#!/usr/bin/env node
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const rl = createInterface({ input: process.stdin, output: process.stdout });

function prompt(question: string, defaultValue: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(`${question} (${defaultValue}): `, (answer) => {
      resolve(answer.trim() || defaultValue);
    });
  });
}

// See @moltzap/server-core/examples/server.ts for the full reference implementation.
// This template scaffolds the minimal working server with registration + WebSocket.
const SERVER_TEMPLATE = `import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import {
  AuthService,
  EnvelopeEncryption,
  seedInitialKek,
  createRpcRouter,
  logger,
} from "@moltzap/server-core";
import type { Database } from "@moltzap/server-core";
import type { RequestFrame } from "@moltzap/protocol";
import { ErrorCodes } from "@moltzap/protocol";

const databaseUrl = process.env.DATABASE_URL!;
const masterSecret = process.env.ENCRYPTION_MASTER_SECRET!;
const port = parseInt(process.env.PORT ?? "3000");

const pool = new pg.Pool({ connectionString: databaseUrl, max: 20 });
const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });

const envelope = new EnvelopeEncryption(masterSecret);
await seedInitialKek(db, envelope);

const authService = new AuthService(db, logger);

// Add RPC method handlers here (see examples/handlers/ in @moltzap/server-core repo)
const dispatch = createRpcRouter({});

const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

app.use("/*", cors({ origin: "*" }));
app.get("/health", (c) => c.json({ status: "ok" }));

app.post("/api/v1/auth/register", async (c) => {
  const body = await c.req.json();
  const result = await authService.registerAgent(body);
  return c.json(result, 201);
});

app.get(
  "/ws",
  upgradeWebSocket(() => ({
    onMessage(event, ws) {
      try {
        const frame = JSON.parse(String(event.data)) as RequestFrame;
        // TODO: authenticate connection, then dispatch RPC
        // dispatch(frame, ctx).then((res) => ws.send(JSON.stringify(res)));
      } catch {
        ws.send(JSON.stringify({
          jsonrpc: "2.0", type: "response", id: "unknown",
          error: { code: ErrorCodes.ParseError, message: "Invalid JSON" },
        }));
      }
    },
  })),
);

const server = serve({ fetch: app.fetch, port });
injectWebSocket(server);
logger.info({ port }, "MoltZap server started");
`;

async function main() {
  console.log("\ncreate-moltzap-server — scaffold an agent messaging server\n");

  const projectName = await prompt("Project name", "moltzap-server");
  const postgresUrl = await prompt(
    "Postgres URL",
    "postgresql://localhost:5432/moltzap",
  );
  const portInput = await prompt("Port", "3000");

  rl.close();

  const encryptionSecret = randomBytes(32).toString("base64");
  const projectDir = join(process.cwd(), projectName);

  mkdirSync(projectDir, { recursive: true });

  writeFileSync(
    join(projectDir, "package.json"),
    JSON.stringify(
      {
        name: projectName,
        type: "module",
        scripts: {
          start: "node --import tsx/esm server.ts",
          dev: "tsx watch server.ts",
        },
        dependencies: {
          "@hono/node-server": "^1.13.7",
          "@hono/node-ws": "^1.0.5",
          "@moltzap/protocol": "latest",
          "@moltzap/server-core": "latest",
          hono: "^4.6.0",
          kysely: "^0.27.0",
          pg: "^8.12.0",
        },
        devDependencies: {
          "@types/pg": "^8.11.0",
          tsx: "^4.19.0",
        },
      },
      null,
      2,
    ) + "\n",
  );

  writeFileSync(join(projectDir, "server.ts"), SERVER_TEMPLATE);

  writeFileSync(
    join(projectDir, ".env"),
    `DATABASE_URL=${postgresUrl}
ENCRYPTION_MASTER_SECRET=${encryptionSecret}
PORT=${portInput}
CORS_ORIGINS=*
MOLTZAP_DEV_MODE=true
`,
  );

  writeFileSync(
    join(projectDir, "docker-compose.yml"),
    `services:
  db:
    image: postgres:16
    ports:
      - "5432:5432"
    environment:
      POSTGRES_USER: moltzap
      POSTGRES_PASSWORD: moltzap
      POSTGRES_DB: moltzap
    volumes:
      - pgdata:/var/lib/postgresql/data
volumes:
  pgdata:
`,
  );

  console.log(`\nProject created in ./${projectName}\n`);
  console.log("Next steps:\n");
  console.log(`  cd ${projectName}`);
  console.log("  npm install");
  console.log("  docker compose up -d  # start Postgres");
  console.log("  npm run dev\n");
}

main();
