import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Effect } from "effect";
import { HeartbeatManager } from "./heartbeat.js";

describe("HeartbeatManager", () => {
  let hb: HeartbeatManager;

  beforeEach(() => {
    vi.useFakeTimers();
    hb = new HeartbeatManager();
  });

  afterEach(() => {
    hb.destroy();
    vi.useRealTimers();
  });

  it("starts and calls sendPing at interval", async () => {
    const sendPing = vi
      .fn<() => Effect.Effect<void, Error>>()
      .mockImplementation(() => Effect.void);
    const onFailure = vi.fn();

    hb.start(sendPing, 1000, onFailure);
    expect(hb.isRunning).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);
    expect(sendPing).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(sendPing).toHaveBeenCalledTimes(2);
  });

  it("calls onFailure when ping fails", async () => {
    const error = new Error("ping failed");
    const sendPing = vi
      .fn<() => Effect.Effect<void, Error>>()
      .mockImplementation(() => Effect.fail(error));
    const onFailure = vi.fn();

    hb.start(sendPing, 1000, onFailure);

    await vi.advanceTimersByTimeAsync(1000);
    expect(onFailure).toHaveBeenCalledWith(error);
  });

  it("stop clears the timer", async () => {
    const sendPing = vi
      .fn<() => Effect.Effect<void, Error>>()
      .mockImplementation(() => Effect.void);
    const onFailure = vi.fn();

    hb.start(sendPing, 1000, onFailure);
    hb.stop();
    expect(hb.isRunning).toBe(false);

    await vi.advanceTimersByTimeAsync(2000);
    expect(sendPing).not.toHaveBeenCalled();
  });

  it("start replaces previous timer", async () => {
    const sendPing1 = vi
      .fn<() => Effect.Effect<void, Error>>()
      .mockImplementation(() => Effect.void);
    const sendPing2 = vi
      .fn<() => Effect.Effect<void, Error>>()
      .mockImplementation(() => Effect.void);
    const onFailure = vi.fn();

    hb.start(sendPing1, 1000, onFailure);
    hb.start(sendPing2, 1000, onFailure);

    await vi.advanceTimersByTimeAsync(1000);
    expect(sendPing1).not.toHaveBeenCalled();
    expect(sendPing2).toHaveBeenCalledTimes(1);
  });

  it("destroy stops the timer", () => {
    const sendPing = vi
      .fn<() => Effect.Effect<void, Error>>()
      .mockImplementation(() => Effect.void);
    const onFailure = vi.fn();

    hb.start(sendPing, 1000, onFailure);
    hb.destroy();
    expect(hb.isRunning).toBe(false);
  });
});
