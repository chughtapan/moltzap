import { appendFileSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import { logger as sharedLogger } from "@moltzap/server-core";

type EvalLogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHT: Record<EvalLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let consoleLevel: EvalLogLevel = "info";
let outputFilePath: string | undefined;

function normalizeLevel(value: string): EvalLogLevel {
  switch (value) {
    case "debug":
    case "info":
    case "warn":
    case "error":
      return value;
    default:
      return "info";
  }
}

function shouldWriteConsole(level: EvalLogLevel): boolean {
  return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[consoleLevel];
}

function serialiseLogArgs(level: EvalLogLevel, args: unknown[]): string {
  const timestamp = new Date().toISOString();
  if (args.length === 0) {
    return JSON.stringify({ timestamp, level, message: "" });
  }
  const [first, second, ...rest] = args;
  if (typeof first === "string") {
    return JSON.stringify({
      timestamp,
      level,
      message: first,
      args: [second, ...rest].filter((value) => value !== undefined),
    });
  }
  if (typeof second === "string") {
    return JSON.stringify({
      timestamp,
      level,
      message: second,
      fields: first,
      args: rest,
    });
  }
  return JSON.stringify({
    timestamp,
    level,
    args,
  });
}

function writeFileLog(level: EvalLogLevel, args: unknown[]): void {
  if (outputFilePath === undefined) {
    return;
  }
  appendFileSync(outputFilePath, serialiseLogArgs(level, args) + "\n");
}

function emit(level: EvalLogLevel, args: unknown[]): void {
  writeFileLog(level, args);
  if (!shouldWriteConsole(level)) {
    return;
  }
  const method =
    level === "warn" ? "warn" : level === "error" ? "error" : level;
  const sink = sharedLogger[method].bind(sharedLogger) as (
    ...values: unknown[]
  ) => void;
  sink(...args);
}

export const logger = {
  get level(): EvalLogLevel {
    return consoleLevel;
  },
  set level(value: string) {
    consoleLevel = normalizeLevel(value);
  },
  debug(...args: unknown[]): void {
    emit("debug", args);
  },
  info(...args: unknown[]): void {
    emit("info", args);
  },
  warn(...args: unknown[]): void {
    emit("warn", args);
  },
  error(...args: unknown[]): void {
    emit("error", args);
  },
};

export function setupLogger(
  outputDir: string | undefined,
  logLevel: string,
): void {
  consoleLevel = normalizeLevel(logLevel);
  sharedLogger.level = consoleLevel;
  if (outputDir === undefined) {
    outputFilePath = undefined;
    return;
  }
  mkdirSync(outputDir, { recursive: true });
  outputFilePath = path.join(outputDir, "output.log");
}
