import type * as Effect from "effect/Effect";
import type { CoreApp } from "@moltzap/server-core";
import type { Runtime, SpawnInput, LogSlice, ReadyOutcome } from "./runtime.js";
import { SpawnFailed } from "./errors.js";

export interface OpenClawAdapterDeps {
  /** Live CoreApp instance for ConnectionManager readiness checks. */
  readonly coreApp: CoreApp;
  /** Absolute path to openclaw.mjs bin. */
  readonly openclawBin: string;
  /** Absolute path to the built @moltzap/openclaw-channel dist directory. */
  readonly channelDistDir: string;
  /** Monorepo root (for resolving workspace packages). */
  readonly repoRoot: string;
}

export class OpenClawAdapter implements Runtime {
  constructor(private readonly deps: OpenClawAdapterDeps) {}

  spawn(input: SpawnInput): Effect.Effect<void, SpawnFailed, never> {
    throw new Error("not implemented");
  }

  waitUntilReady(timeoutMs: number): Effect.Effect<ReadyOutcome, never, never> {
    throw new Error("not implemented");
  }

  teardown(): Effect.Effect<void, never, never> {
    throw new Error("not implemented");
  }

  getLogs(offset: number): LogSlice {
    throw new Error("not implemented");
  }

  getInboundMarker(): string {
    throw new Error("not implemented");
  }
}
