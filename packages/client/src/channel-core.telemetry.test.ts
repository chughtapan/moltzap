import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MoltZapChannelCore } from "./channel-core.js";
import {
  createFakeChannelService,
  buildMessage,
  flushDispatchChain,
} from "./test-utils/index.js";
import {
  type DispatchCompleteEvent,
  type DispatchStartEvent,
} from "@moltzap/observability";
import {
  captureTelemetry,
  resetTelemetry,
} from "@moltzap/observability/test-utils";

describe("MoltZapChannelCore telemetry — invariants", () => {
  beforeEach(resetTelemetry);
  afterEach(resetTelemetry);

  it("fires one dispatch.start and one dispatch.complete per inbound", async () => {
    const { events } = captureTelemetry();
    const fake = createFakeChannelService({ ownAgentId: "agent-self" });
    const core = new MoltZapChannelCore({
      service: fake.service,
      queueStatsIntervalMs: 0,
    });
    core.onInbound(() => Promise.resolve());

    fake.emit.message(buildMessage({ id: "m1" }));
    await flushDispatchChain();

    const starts = events.filter((e) => e.event === "dispatch.start");
    const completes = events.filter((e) => e.event === "dispatch.complete");
    expect(starts).toHaveLength(1);
    expect(completes).toHaveLength(1);
    expect((starts[0] as DispatchStartEvent).msgId).toBe("m1");
    expect((completes[0] as DispatchCompleteEvent).outcome).toBe("final");
  });

  it("handler throw produces dispatch.complete outcome=error; chain continues", async () => {
    const { events } = captureTelemetry();
    const fake = createFakeChannelService({ ownAgentId: "agent-self" });
    let callCount = 0;
    const core = new MoltZapChannelCore({
      service: fake.service,
      queueStatsIntervalMs: 0,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    core.onInbound(async () => {
      callCount++;
      if (callCount === 1) throw new Error("boom");
    });

    fake.emit.message(buildMessage({ id: "m1" }));
    fake.emit.message(buildMessage({ id: "m2" }));
    await flushDispatchChain();

    const completes = events.filter(
      (e) => e.event === "dispatch.complete",
    ) as DispatchCompleteEvent[];
    expect(completes).toHaveLength(2);
    expect(completes[0]!.outcome).toBe("error");
    expect(completes[0]!.errorReason).toBe("boom");
    expect(completes[1]!.outcome).toBe("final");
    expect(core.getQueueStats().depth).toBe(0);
    expect(core.getQueueStats().inflight).toBe(0);
  });

  it("invariant: 10 sequential messages preserve order, inflight <= 1, depth returns to 0", async () => {
    captureTelemetry();
    const fake = createFakeChannelService({ ownAgentId: "agent-self" });
    const order: string[] = [];
    const inflightSamples: number[] = [];
    const core = new MoltZapChannelCore({
      service: fake.service,
      queueStatsIntervalMs: 0,
    });
    core.onInbound(async (m) => {
      inflightSamples.push(core.getQueueStats().inflight);
      await new Promise((r) => setTimeout(r, 1));
      order.push(m.id);
    });

    for (let i = 0; i < 10; i++) {
      fake.emit.message(buildMessage({ id: `m${i}` }));
    }
    await flushDispatchChain();
    // Also wait enough real time for the setTimeouts in the handler
    await new Promise((r) => setTimeout(r, 50));

    expect(order).toEqual([
      "m0",
      "m1",
      "m2",
      "m3",
      "m4",
      "m5",
      "m6",
      "m7",
      "m8",
      "m9",
    ]);
    for (const n of inflightSamples) expect(n).toBeLessThanOrEqual(1);
    expect(core.getQueueStats().depth).toBe(0);
    expect(core.getQueueStats().inflight).toBe(0);
  });

  it("chaos test: 100 messages with random handler delays (0-20ms), order preserved, no counter drift", async () => {
    captureTelemetry();
    const fake = createFakeChannelService({ ownAgentId: "agent-self" });
    const order: string[] = [];
    let maxInflight = 0;
    const core = new MoltZapChannelCore({
      service: fake.service,
      queueStatsIntervalMs: 0,
    });
    core.onInbound(async (m) => {
      const inflight = core.getQueueStats().inflight;
      if (inflight > maxInflight) maxInflight = inflight;
      const delayMs = Math.floor(Math.random() * 20);
      await new Promise((r) => setTimeout(r, delayMs));
      order.push(m.id);
    });

    const ids: string[] = [];
    for (let i = 0; i < 100; i++) {
      const id = `m${i.toString().padStart(3, "0")}`;
      ids.push(id);
      fake.emit.message(buildMessage({ id }));
    }
    await flushDispatchChain();
    // Wait for all timeouts to drain. 100 * 20ms worst case = 2s; 3s is safe.
    await new Promise((r) => setTimeout(r, 3000));

    expect(order).toHaveLength(100);
    expect(order).toEqual(ids);
    expect(maxInflight).toBeLessThanOrEqual(1);
    expect(core.getQueueStats().depth).toBe(0);
    expect(core.getQueueStats().inflight).toBe(0);
  }, 10_000);

  it("chaos test: mid-flight disconnect + reconnect, no messages lost", async () => {
    captureTelemetry();
    const fake = createFakeChannelService({ ownAgentId: "agent-self" });
    const delivered: string[] = [];
    const core = new MoltZapChannelCore({
      service: fake.service,
      queueStatsIntervalMs: 0,
    });
    core.onInbound(async (m) => {
      await new Promise((r) => setTimeout(r, 5));
      delivered.push(m.id);
    });

    // Send 5 messages, mid-flight fire disconnect+reconnect, then 5 more.
    for (let i = 0; i < 5; i++) {
      fake.emit.message(buildMessage({ id: `a${i}` }));
    }
    fake.emit.disconnect();
    fake.emit.reconnect();
    for (let i = 0; i < 5; i++) {
      fake.emit.message(buildMessage({ id: `b${i}` }));
    }

    await flushDispatchChain();
    await new Promise((r) => setTimeout(r, 500));

    expect(delivered).toHaveLength(10);
    expect(core.getQueueStats().depth).toBe(0);
    expect(core.getQueueStats().inflight).toBe(0);
  });

  it("queue.stats emits on state changes, suppresses idle zero-zero heartbeats", async () => {
    const { events } = captureTelemetry();
    const fake = createFakeChannelService({ ownAgentId: "agent-self" });
    const core = new MoltZapChannelCore({
      service: fake.service,
      queueStatsIntervalMs: 20,
    });
    core.onInbound(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });

    await core.connect();

    // Idle period: depth=0, inflight=0. One initial emission, then silence.
    await new Promise((r) => setTimeout(r, 80));
    const idleStats = events.filter((e) => e.event === "queue.stats");
    expect(idleStats).toHaveLength(1);
    expect((idleStats[0] as { depth: number }).depth).toBe(0);

    // Activity: a message in flight changes state, should emit again.
    fake.emit.message(buildMessage({ id: "x1" }));
    await new Promise((r) => setTimeout(r, 50));
    const activeStats = events.filter((e) => e.event === "queue.stats");
    expect(activeStats.length).toBeGreaterThan(1);

    await core.disconnect();
  });
});
