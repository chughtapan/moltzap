import pino from "pino";

export const logger = pino({
  level: process.env["LOG_LEVEL"] ?? "info",
  transport:
    process.env["NODE_ENV"] !== "production"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
});

export type Logger = typeof logger;

export const log = {
  ws: logger.child({ category: "ws" }),
  rpc: logger.child({ category: "rpc" }),
  auth: logger.child({ category: "auth" }),
  db: logger.child({ category: "db" }),
  push: logger.child({ category: "push" }),
  invite: logger.child({ category: "invite" }),
  encryption: logger.child({ category: "encryption" }),
};
