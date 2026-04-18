/**
 * TelemetryCollector — subscribes to the telemetry singleton and writes each
 * event as one JSON line to disk via a buffered append stream.
 *
 * Usage:
 *   const c = new TelemetryCollector("/path/to/telemetry.jsonl");
 *   c.start();
 *   // ... do work that emits events ...
 *   await c.stop();
 *
 * By default the collector does NOT retain events in memory, so it is safe
 * for long-running servers emitting thousands of events. Tests that need to
 * assert against the captured stream can opt in with `{ keepInMemory: true }`.
 */

import { createWriteStream, type WriteStream } from "node:fs";
import { telemetry } from "./telemetry.js";
import type { TelemetryEvent } from "./events.js";

export interface TelemetryCollectorOptions {
  keepInMemory?: boolean;
}

export class TelemetryCollector {
  private readonly _events: TelemetryEvent[] | null;
  private stream: WriteStream | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly path: string,
    opts: TelemetryCollectorOptions = {},
  ) {
    this._events = opts.keepInMemory ? [] : null;
  }

  /**
   * Captured events, when constructed with `{ keepInMemory: true }`.
   * Returns `null` in production mode to avoid unbounded memory growth.
   */
  get events(): ReadonlyArray<TelemetryEvent> | null {
    return this._events;
  }

  start(): void {
    if (this.stream !== null) return;
    this.stream = createWriteStream(this.path, { flags: "a" });
    this.unsubscribe = telemetry.subscribe((event) => {
      if (this._events !== null) this._events.push(event);
      this.stream?.write(JSON.stringify(event) + "\n");
    });
  }

  async stop(): Promise<void> {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.stream !== null) {
      const stream = this.stream;
      this.stream = null;
      await new Promise<void>((resolve, reject) => {
        stream.end((err?: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  }
}
