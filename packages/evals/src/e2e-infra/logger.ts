/** Winston logger for the E2E eval pipeline. */

import * as winston from "winston";
import * as path from "node:path";

let fileTransport: winston.transport | null = null;

const consoleTransport = new winston.transports.Console({
  level: "info",
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `\r\x1b[K${timestamp} [${level}]: ${message}`;
    }),
  ),
});

export const logger = winston.createLogger({
  level: "debug",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${level}]: ${message}`;
    }),
  ),
  transports: [consoleTransport],
});

export function setupLogger(
  outputDir: string | undefined,
  logLevel: string,
): void {
  logger.level = "debug";
  consoleTransport.level = logLevel;

  if (fileTransport) {
    logger.remove(fileTransport);
    fileTransport = null;
  }

  if (outputDir) {
    fileTransport = new winston.transports.File({
      filename: path.join(outputDir, "output.log"),
      level: "debug",
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json(),
      ),
    });
    logger.add(fileTransport);
  }
}
