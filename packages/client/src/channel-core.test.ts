import { beforeEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import type { Message } from "@moltzap/protocol";

import {
  MoltZapChannelCore,
  type ChannelService,
  type EnrichedInboundMessage,
  type CrossConversationEntry,
} from "./index.js";
import {
  createFakeChannelService,
  buildMessage,
  flushDispatchChain,
  type FakeChannelService,
} from "./test-utils/index.js";

function customSetup(): {
  fake: FakeChannelService;
  core: MoltZapChannelCore;
  received: EnrichedInboundMessage[];
  errorSpy: ReturnType<typeof vi.fn>;
} {
  const fake = createFakeChannelService({ ownAgentId: "agent-self" });
  const received: EnrichedInboundMessage[] = [];
  const errorSpy = vi.fn();
  const core = new MoltZapChannelCore({
    service: fake.service,
    logger: { info: () => {}, warn: () => {}, error: errorSpy },
  });
  core.onInbound((m) =>
    Effect.sync(() => {
      received.push(m);
    }),
  );
  return { fake, core, received, errorSpy };
}

/** Stub out getAgentName on the fixture's service so resolveAgentName is the only path. */
function forceResolveAgentNamePath(fake: FakeChannelService): void {
  (
    fake.service as { getAgentName: (id: string) => string | undefined }
  ).getAgentName = () => undefined;
}

describe("MoltZapChannelCore", () => {
  let fake: FakeChannelService;
  let service: ChannelService;
  let core: MoltZapChannelCore;
  let inbound: EnrichedInboundMessage[];

  beforeEach(() => {
    fake = createFakeChannelService({ ownAgentId: "agent-self" });
    service = fake.service;
    core = new MoltZapChannelCore({ service });
    inbound = [];
    core.onInbound((msg) =>
      Effect.sync(() => {
        inbound.push(msg);
      }),
    );
  });

  describe("lifecycle", () => {
    it("connect() delegates to service and sets connected", async () => {
      expect(core.isConnected()).toBe(false);
      await Effect.runPromise(core.connect());
      expect(fake.state.connectCalls.count).toBe(1);
      expect(core.isConnected()).toBe(true);
    });

    it("disconnect() closes the service and clears the connected flag", async () => {
      await Effect.runPromise(core.connect());
      await Effect.runPromise(core.disconnect());
      expect(fake.state.closeCalls.count).toBe(1);
      expect(core.isConnected()).toBe(false);
    });

    it("disconnect event from the service clears the connected flag", async () => {
      await Effect.runPromise(core.connect());
      fake.emit.disconnect();
      expect(core.isConnected()).toBe(false);
    });

    it("reconnect event from the service sets the connected flag", () => {
      fake.emit.reconnect();
      expect(core.isConnected()).toBe(true);
    });

    it("onDisconnect handlers fire on disconnect event", async () => {
      const spy = vi.fn();
      core.onDisconnect(spy);
      await Effect.runPromise(core.connect());
      fake.emit.disconnect();
      expect(spy).toHaveBeenCalledOnce();
    });

    it("onReconnect handlers fire on reconnect event", () => {
      const spy = vi.fn();
      core.onReconnect(spy);
      fake.emit.reconnect();
      expect(spy).toHaveBeenCalledOnce();
    });
  });

  describe("inbound message enrichment", () => {
    it("maps a MoltZap Message to EnrichedInboundMessage", async () => {
      fake.state.setConversation("conv-1", {
        type: "dm",
        name: "alice-dm",
        participants: ["agent:agent-alice", "agent:agent-self"],
      });
      fake.state.setAgentName("agent-alice", "Alice");

      fake.emit.message(
        buildMessage({
          id: "msg-abc",
          conversationId: "conv-1",
          senderId: "agent-alice",
          parts: [{ type: "text", text: "hi there" }],
          createdAt: "2026-04-10T13:00:00.000Z",
        }),
      );

      await flushDispatchChain();

      expect(inbound).toHaveLength(1);
      const enriched = inbound[0]!;
      expect(enriched).toMatchObject({
        id: "msg-abc",
        conversationId: "conv-1",
        sender: { id: "agent-alice", name: "Alice" },
        text: "hi there",
        isFromMe: false,
        createdAt: "2026-04-10T13:00:00.000Z",
      });
      expect(enriched.conversationMeta).toMatchObject({
        type: "dm",
        name: "alice-dm",
      });
    });

    it("resolves sender name from getAgentName cache when present", async () => {
      fake.state.setAgentName("agent-alice", "Alice (cached)");
      fake.state.setConversation("conv-1", { type: "dm", participants: [] });

      fake.emit.message(buildMessage());
      await flushDispatchChain();

      expect(inbound[0]!.sender.name).toBe("Alice (cached)");
      expect(fake.state.resolveAgentNameCallCount("agent-alice")).toBe(0);
    });

    it("falls back to resolveAgentName when getAgentName returns undefined", async () => {
      const { fake, received } = customSetup();
      forceResolveAgentNamePath(fake);
      fake.state.setConversation("conv-1", { type: "dm", participants: [] });
      fake.state.setAgentName("agent-alice", "Alice (via resolve)");

      fake.emit.message(buildMessage());
      await flushDispatchChain();

      expect(received[0]!.sender.name).toBe("Alice (via resolve)");
      expect(fake.state.resolveAgentNameCallCount("agent-alice")).toBe(1);
    });

    it("falls back to sender.id when both name lookups fail", async () => {
      const { fake, received } = customSetup();
      forceResolveAgentNamePath(fake);
      fake.state.setConversation("conv-1", { type: "dm", participants: [] });

      fake.emit.message(buildMessage({ senderId: "agent-unknown" }));
      await flushDispatchChain();

      expect(received[0]!.sender.name).toBe("agent-unknown");
    });

    it("swallows resolveAgentName errors and falls back to sender.id", async () => {
      const { fake, received } = customSetup();
      forceResolveAgentNamePath(fake);
      fake.state.setConversation("conv-1", { type: "dm", participants: [] });
      fake.state.setResolveAgentNameFailure(
        "agent-broken",
        new Error("network down"),
      );

      fake.emit.message(buildMessage({ senderId: "agent-broken" }));
      await flushDispatchChain();

      expect(received[0]!.sender.name).toBe("agent-broken");
    });

    it("concatenates multi-text-part messages with newlines", async () => {
      fake.state.setConversation("conv-1", { type: "dm", participants: [] });
      fake.state.setAgentName("agent-alice", "Alice");

      fake.emit.message(
        buildMessage({
          parts: [
            { type: "text", text: "line one" },
            { type: "text", text: "line two" },
          ],
        }),
      );
      await flushDispatchChain();

      expect(inbound[0]!.text).toBe("line one\nline two");
    });

    it("ignores non-text parts when building text", async () => {
      fake.state.setConversation("conv-1", { type: "dm", participants: [] });
      fake.state.setAgentName("agent-alice", "Alice");

      fake.emit.message(
        buildMessage({
          parts: [
            { type: "text", text: "caption" },
            { type: "image", url: "https://example.com/pic.png" },
          ] as Message["parts"],
        }),
      );
      await flushDispatchChain();

      expect(inbound[0]!.text).toBe("caption");
    });

    it("sets isFromMe=true when sender matches ownAgentId", async () => {
      fake.state.setConversation("conv-1", { type: "dm", participants: [] });

      fake.emit.message(buildMessage({ senderId: "agent-self" }));
      await flushDispatchChain();

      expect(inbound[0]!.isFromMe).toBe(true);
    });

    it("forwards replyToId from the message frame", async () => {
      fake.state.setConversation("conv-1", { type: "dm", participants: [] });
      fake.state.setAgentName("agent-alice", "Alice");

      fake.emit.message(buildMessage({ replyToId: "msg-parent-123" }));
      await flushDispatchChain();

      expect(inbound[0]!.replyToId).toBe("msg-parent-123");
    });

    it("logs failures from the inbound handler's Effect error channel and keeps the consumer alive", async () => {
      const { fake, errorSpy, core } = customSetup();
      fake.state.setConversation("conv-1", { type: "dm", participants: [] });
      fake.state.setAgentName("agent-alice", "Alice");

      let handlerShouldFail = true;
      const received: EnrichedInboundMessage[] = [];
      // Replace the setup's default capture handler with one that can fail.
      core.onInbound((m) =>
        Effect.gen(function* () {
          if (handlerShouldFail) {
            yield* Effect.fail(new Error("handler boom"));
          }
          received.push(m);
        }),
      );

      fake.emit.message(buildMessage({ id: "msg-1" }));
      await flushDispatchChain();

      expect(received).toHaveLength(0);
      expect(errorSpy).toHaveBeenCalledOnce();

      // Recovery: subsequent message lands cleanly.
      handlerShouldFail = false;
      fake.emit.message(buildMessage({ id: "msg-2" }));
      await flushDispatchChain();
      expect(received).toHaveLength(1);
      expect(received[0]!.id).toBe("msg-2");
    });

    it("logs synchronous defects thrown from inside the handler's Effect", async () => {
      const { fake, errorSpy, core } = customSetup();
      fake.state.setConversation("conv-1", { type: "dm", participants: [] });
      fake.state.setAgentName("agent-alice", "Alice");

      core.onInbound((_m) =>
        Effect.sync(() => {
          throw new Error("sync defect");
        }),
      );

      fake.emit.message(buildMessage({ id: "msg-1" }));
      await flushDispatchChain();

      expect(errorSpy).toHaveBeenCalledOnce();

      // Consumer fiber survives a defect and continues to dispatch later messages.
      const next: EnrichedInboundMessage[] = [];
      core.onInbound((m) =>
        Effect.sync(() => {
          next.push(m);
        }),
      );
      fake.emit.message(buildMessage({ id: "msg-2" }));
      await flushDispatchChain();
      expect(next.map((r) => r.id)).toEqual(["msg-2"]);
    });
  });

  describe("dispatch chain ordering", () => {
    it("serializes handlers so message order is preserved across async resolution", async () => {
      const { fake, received } = customSetup();
      fake.state.setConversation("conv-1", { type: "dm", participants: [] });
      forceResolveAgentNamePath(fake);

      // Hold the resolveAgentName promises so we can control timing. The
      // fake returns an async-style Effect that resumes once the test calls
      // the recorded resolver — this mirrors the pre-Effect Promise flow.
      const resolvers: Array<(name: string) => void> = [];
      fake.service.resolveAgentName = (id: string) =>
        Effect.async<string, never>((resume) => {
          resolvers.push(() => resume(Effect.succeed(id)));
        });

      fake.emit.message(buildMessage({ id: "msg-1" }));
      fake.emit.message(buildMessage({ id: "msg-2" }));

      // Neither has been delivered to the handler yet — first message is
      // still awaiting resolveAgentName; second is queued behind it.
      await flushDispatchChain();
      expect(received).toHaveLength(0);
      expect(resolvers).toHaveLength(1);

      // Resolve the first, chain advances.
      resolvers[0]!("agent-alice");
      await flushDispatchChain();
      expect(received.map((r) => r.id)).toEqual(["msg-1"]);
      expect(resolvers).toHaveLength(2);

      // Resolve the second.
      resolvers[1]!("agent-bob");
      await flushDispatchChain();
      expect(received.map((r) => r.id)).toEqual(["msg-1", "msg-2"]);
    });

    it("awaits async handler fully before processing the next message", async () => {
      const { fake, core } = customSetup();
      fake.state.setConversation("conv-1", { type: "dm", participants: [] });
      fake.state.setAgentName("agent-alice", "Alice");

      const handlerBarriers: Array<() => void> = [];
      const order: string[] = [];

      core.onInbound((m) =>
        Effect.gen(function* () {
          order.push(`enter:${m.id}`);
          yield* Effect.async<void>((resume) => {
            handlerBarriers.push(() => resume(Effect.void));
          });
          order.push(`exit:${m.id}`);
        }),
      );

      fake.emit.message(buildMessage({ id: "msg-1" }));
      fake.emit.message(buildMessage({ id: "msg-2" }));
      await flushDispatchChain();

      // Handler started for msg-1, hasn't returned yet. msg-2 has NOT entered.
      expect(order).toEqual(["enter:msg-1"]);

      handlerBarriers[0]!();
      await flushDispatchChain();

      // msg-1 fully processed; msg-2 has entered.
      expect(order).toEqual(["enter:msg-1", "exit:msg-1", "enter:msg-2"]);

      handlerBarriers[1]!();
      await flushDispatchChain();
      expect(order).toEqual([
        "enter:msg-1",
        "exit:msg-1",
        "enter:msg-2",
        "exit:msg-2",
      ]);
    });

    it("onInbound replaces the previous handler instead of adding", async () => {
      fake.state.setConversation("conv-1", { type: "dm", participants: [] });
      fake.state.setAgentName("agent-alice", "Alice");

      const firstHandler = vi.fn();
      const secondHandler = vi.fn();
      core.onInbound((m) => Effect.sync(() => firstHandler(m)));
      core.onInbound((m) => Effect.sync(() => secondHandler(m)));

      fake.emit.message(buildMessage());
      await flushDispatchChain();

      expect(firstHandler).not.toHaveBeenCalled();
      expect(secondHandler).toHaveBeenCalledOnce();
    });
  });

  describe("context blocks enrichment", () => {
    it("attaches groupMetadata when conversation is a group", async () => {
      fake.state.setConversation("conv-1", {
        type: "group",
        name: "devs",
        participants: [
          "agent:agent-alice",
          "agent:agent-bob",
          "agent:agent-self",
        ],
      });
      fake.state.setAgentName("agent-alice", "Alice");

      fake.emit.message(buildMessage());
      await flushDispatchChain();

      const msg = inbound[0]!;
      expect(msg.contextBlocks.groupMetadata).toEqual({
        type: "group",
        name: "devs",
        participants: [
          "agent:agent-alice",
          "agent:agent-bob",
          "agent:agent-self",
        ],
      });
    });

    it("does NOT attach groupMetadata for DM conversations", async () => {
      fake.state.setConversation("conv-1", {
        type: "dm",
        name: "alice-dm",
        participants: ["agent:agent-alice", "agent:agent-self"],
      });
      fake.state.setAgentName("agent-alice", "Alice");

      fake.emit.message(buildMessage());
      await flushDispatchChain();

      expect(inbound[0]!.contextBlocks.groupMetadata).toBeUndefined();
    });

    it("attaches crossConversation entries when getContextEntries returns non-empty", async () => {
      fake.state.setConversation("conv-1", { type: "dm", participants: [] });
      fake.state.setAgentName("agent-alice", "Alice");

      const entries: CrossConversationEntry[] = [
        {
          conversationId: "conv-other",
          conversationName: "other-dm",
          senderName: "Bob",
          text: "hello from the other side",
          minutesAgo: 3,
          count: 1,
        },
      ];
      fake.state.setContextEntries("conv-1", entries);

      fake.emit.message(buildMessage());
      await flushDispatchChain();

      expect(inbound[0]!.contextBlocks.crossConversation).toEqual(entries);
    });

    it("does NOT attach crossConversation when getContextEntries returns empty", async () => {
      fake.state.setConversation("conv-1", { type: "dm", participants: [] });
      fake.state.setAgentName("agent-alice", "Alice");
      // Fixture default: returns [] for unknown convs

      fake.emit.message(buildMessage());
      await flushDispatchChain();

      expect(inbound[0]!.contextBlocks.crossConversation).toBeUndefined();
    });

    it("handles groups with zero participants gracefully", async () => {
      fake.state.setConversation("conv-1", {
        type: "group",
        name: "empty-group",
        participants: [],
      });
      fake.state.setAgentName("agent-alice", "Alice");

      fake.emit.message(buildMessage());
      await flushDispatchChain();

      const meta = inbound[0]!.contextBlocks.groupMetadata;
      expect(meta).toBeDefined();
      expect(meta!.participants).toEqual([]);
    });

    it("commits context markers after enrichment so a second inbound message does not re-see the same entries", async () => {
      fake.state.setConversation("conv-1", { type: "dm", participants: [] });
      fake.state.setAgentName("agent-alice", "Alice");
      fake.state.setContextEntries("conv-1", [
        {
          conversationId: "conv-other",
          senderName: "Bob",
          text: "first visit",
          minutesAgo: 1,
          count: 1,
        },
      ]);

      fake.emit.message(buildMessage({ id: "msg-1" }));
      await flushDispatchChain();
      expect(inbound[0]!.contextBlocks.crossConversation).toHaveLength(1);

      fake.emit.message(buildMessage({ id: "msg-2" }));
      await flushDispatchChain();
      expect(inbound[1]!.contextBlocks.crossConversation).toBeUndefined();
    });

    it("does not commit when there are no context entries", async () => {
      const commitSpy = vi.fn();
      fake.state.setConversation("conv-1", { type: "dm", participants: [] });
      fake.state.setAgentName("agent-alice", "Alice");
      // Install a peekContextEntries that records commit calls.
      (
        fake.service as {
          peekContextEntries: (id: string) => {
            entries: CrossConversationEntry[];
            commit: () => void;
          };
        }
      ).peekContextEntries = () => ({ entries: [], commit: commitSpy });

      fake.emit.message(buildMessage());
      await flushDispatchChain();

      expect(commitSpy).not.toHaveBeenCalled();
    });

    it("attaches crossConversationMessages when peekFullMessages returns non-empty", async () => {
      fake.state.setConversation("conv-1", { type: "dm", participants: [] });
      fake.state.setAgentName("agent-alice", "Alice");
      fake.state.setFullMessages("conv-1", [
        {
          conversationId: "conv-other",
          conversationName: "other-dm",
          senderName: "Bob",
          senderId: "agent-bob",
          text: "full message text here",
          timestamp: "2026-04-13T22:00:00Z",
        },
      ]);

      fake.emit.message(buildMessage());
      await flushDispatchChain();

      const msgs = inbound[0]!.contextBlocks.crossConversationMessages;
      expect(msgs).toHaveLength(1);
      expect(msgs![0]).toMatchObject({
        conversationId: "conv-other",
        senderName: "Bob",
        text: "full message text here",
        timestamp: "2026-04-13T22:00:00Z",
      });
    });

    it("does NOT attach crossConversationMessages when peekFullMessages returns empty", async () => {
      fake.state.setConversation("conv-1", { type: "dm", participants: [] });
      fake.state.setAgentName("agent-alice", "Alice");

      fake.emit.message(buildMessage());
      await flushDispatchChain();

      expect(
        inbound[0]!.contextBlocks.crossConversationMessages,
      ).toBeUndefined();
    });

    it("commits full message markers after inbound handler succeeds", async () => {
      fake.state.setConversation("conv-1", { type: "dm", participants: [] });
      fake.state.setAgentName("agent-alice", "Alice");
      fake.state.setFullMessages("conv-1", [
        {
          conversationId: "conv-other",
          senderName: "Bob",
          senderId: "agent-bob",
          text: "first",
          timestamp: "2026-04-13T22:00:00Z",
        },
      ]);

      fake.emit.message(buildMessage({ id: "msg-1" }));
      await flushDispatchChain();
      expect(inbound[0]!.contextBlocks.crossConversationMessages).toHaveLength(
        1,
      );

      fake.emit.message(buildMessage({ id: "msg-2" }));
      await flushDispatchChain();
      expect(
        inbound[1]!.contextBlocks.crossConversationMessages,
      ).toBeUndefined();
    });
  });

  describe("sendReply", () => {
    it("delegates to service.send with conversationId and text", async () => {
      await Effect.runPromise(core.sendReply("conv-42", "hello there"));
      expect(fake.state.sent).toEqual([
        { convId: "conv-42", text: "hello there" },
      ]);
    });
  });

  describe("static enrichMessage", () => {
    it("returns the same shape as the instance handler path", async () => {
      fake.state.setConversation("conv-1", {
        type: "group",
        name: "devs",
        participants: ["agent:agent-alice", "agent:agent-self"],
      });
      fake.state.setAgentName("agent-alice", "Alice");
      fake.state.setContextEntries("conv-1", [
        {
          conversationId: "conv-other",
          senderName: "Bob",
          text: "bonjour",
          minutesAgo: 1,
          count: 1,
        },
      ]);

      const msg = buildMessage({
        id: "msg-static",
        conversationId: "conv-1",
        parts: [{ type: "text", text: "static enrichment" }],
      });

      const { enriched: staticResult, commitContext } = await Effect.runPromise(
        MoltZapChannelCore.enrichMessage(service, msg),
      );

      expect(staticResult).toMatchObject({
        id: "msg-static",
        conversationId: "conv-1",
        sender: { id: "agent-alice", name: "Alice" },
        text: "static enrichment",
        isFromMe: false,
      });
      expect(staticResult.contextBlocks.groupMetadata?.name).toBe("devs");
      expect(staticResult.contextBlocks.crossConversation).toHaveLength(1);
      expect(commitContext).toBeTypeOf("function");
    });

    it("static helper tolerates resolveAgentName throwing (disconnected service)", async () => {
      const { fake } = customSetup();
      fake.state.setConversation("conv-1", { type: "dm", participants: [] });
      forceResolveAgentNamePath(fake);
      fake.state.setResolveAgentNameFailure(
        "agent-unknown",
        new Error("Not connected"),
      );

      const { enriched: result } = await Effect.runPromise(
        MoltZapChannelCore.enrichMessage(
          fake.service,
          buildMessage({ senderId: "agent-unknown" }),
        ),
      );

      expect(result.sender.name).toBe("agent-unknown");
    });
  });

  describe("fanout guards", () => {
    it("disconnect: running handlers continue after one throws; logger.error sees 'disconnect handler threw'", async () => {
      const { fake, core, errorSpy } = customSetup();
      const recorded: string[] = [];
      core.onDisconnect(() => {
        throw new Error("first disconnect boom");
      });
      core.onDisconnect(() => {
        recorded.push("second");
      });

      await Effect.runPromise(core.connect());
      fake.emit.disconnect();

      expect(recorded).toEqual(["second"]);
      expect(errorSpy).toHaveBeenCalled();
      const msgs = errorSpy.mock.calls.map(
        (c: unknown[]) => (typeof c[1] === "string" ? c[1] : c[0]) as string,
      );
      expect(
        msgs.some(
          (m) =>
            typeof m === "string" && m.includes("disconnect handler threw"),
        ),
      ).toBe(true);
    });

    it("reconnect: running handlers continue after one throws; logger.error sees 'reconnect handler threw'", () => {
      const { fake, core, errorSpy } = customSetup();
      const recorded: string[] = [];
      core.onReconnect(() => {
        throw new Error("first reconnect boom");
      });
      core.onReconnect(() => {
        recorded.push("second");
      });

      fake.emit.reconnect();

      expect(recorded).toEqual(["second"]);
      const msgs = errorSpy.mock.calls.map(
        (c: unknown[]) => (typeof c[1] === "string" ? c[1] : c[0]) as string,
      );
      expect(
        msgs.some(
          (m) => typeof m === "string" && m.includes("reconnect handler threw"),
        ),
      ).toBe(true);
    });
  });

  describe("handleInbound does not commit context on handler failure", () => {
    it("leaves markers unadvanced when the handler's Effect fails so the next message re-sees the same context entries", async () => {
      const { fake, core } = customSetup();
      fake.state.setConversation("conv-1", { type: "dm", participants: [] });
      fake.state.setAgentName("agent-alice", "Alice");
      fake.state.setContextEntries("conv-1", [
        {
          conversationId: "conv-other",
          senderName: "Bob",
          text: "first visit",
          minutesAgo: 1,
          count: 1,
        },
      ]);

      let shouldFail = true;
      const received: EnrichedInboundMessage[] = [];
      core.onInbound((m) =>
        Effect.gen(function* () {
          received.push(m);
          if (shouldFail) {
            yield* Effect.fail(new Error("inbound handler boom"));
          }
        }),
      );

      // First message: handler fails after capturing the enriched payload.
      // commitContext() must NOT run, so the fake's contextEntries remain.
      fake.emit.message(buildMessage({ id: "msg-1" }));
      await flushDispatchChain();
      expect(received[0]!.contextBlocks.crossConversation).toHaveLength(1);

      // Second message: handler succeeds. Because the first message didn't
      // commit, the fake still returns the same entries.
      shouldFail = false;
      fake.emit.message(buildMessage({ id: "msg-2" }));
      await flushDispatchChain();
      expect(received[1]!.contextBlocks.crossConversation).toHaveLength(1);
      expect(received[1]!.contextBlocks.crossConversation![0]!.text).toBe(
        "first visit",
      );
    });
  });
});
