import { expect } from "vitest";
import { live as it } from "@effect/vitest";
import { Effect } from "effect";
import * as H from "../../support/index.js";

H.setupServiceIntegration();

it("markers are per-viewing-conversation", () =>
  Effect.gen(function* () {
    const regA = yield* H.registerAgent("perv-a");
    const regB = yield* H.registerAgent("perv-b");
    const regC = yield* H.registerAgent("perv-c");

    yield* regB.client.connect();
    yield* regC.client.connect();
    const service = yield* H.connectService(regA.apiKey);

    const convB = yield* service.sendRpc(H.ConversationsCreate, {
      type: "dm",
      participants: [{ type: "agent", id: regB.agentId }],
    });
    const convC = yield* service.sendRpc(H.ConversationsCreate, {
      type: "dm",
      participants: [{ type: "agent", id: regC.agentId }],
    });

    // Send message in conv C
    yield* H.sendAndSettle(regC.client, convC.conversation.id, H.SHARED_UPDATE);

    // Conv B views — sees the update, marker advances
    const fromB = service.getContext(convB.conversation.id);
    expect(fromB).not.toBeNull();
    expect(fromB).toContain(H.SHARED_UPDATE);

    // Conv B's marker advanced, so second call returns null
    expect(service.getContext(convB.conversation.id)).toBeNull();

    // Send message in conv B
    yield* H.sendAndSettle(regB.client, convB.conversation.id, H.B_UPDATE);

    // Conv C views — should see BOTH conv C's message hasn't been "seen" from C's perspective
    // AND conv B's new message
    const fromC = service.getContext(convC.conversation.id);
    expect(fromC).not.toBeNull();
    expect(fromC).toContain(H.B_UPDATE);

    service.close();
    yield* regA.client.close();
    yield* regB.client.close();
    yield* regC.client.close();
  }));

it("multiple other conversations appear in context", () =>
  Effect.gen(function* () {
    const regA = yield* H.registerAgent("multi-a");
    const regB = yield* H.registerAgent("multi-b");
    const regC = yield* H.registerAgent("multi-c");
    const regD = yield* H.registerAgent("multi-d");

    yield* regB.client.connect();
    yield* regC.client.connect();
    yield* regD.client.connect();
    const service = yield* H.connectService(regA.apiKey);

    const convB = yield* service.sendRpc(H.ConversationsCreate, {
      type: "dm",
      participants: [{ type: "agent", id: regB.agentId }],
    });
    const convC = yield* service.sendRpc(H.ConversationsCreate, {
      type: "dm",
      participants: [{ type: "agent", id: regC.agentId }],
    });
    const convD = yield* service.sendRpc(H.ConversationsCreate, {
      type: "dm",
      participants: [{ type: "agent", id: regD.agentId }],
    });

    yield* H.sendAndSettle(regC.client, convC.conversation.id, H.FROM_C);
    yield* H.sendAndSettle(regD.client, convD.conversation.id, H.FROM_D);

    const ctx = service.getContext(convB.conversation.id)!;
    expect(ctx).toContain(H.FROM_C);
    expect(ctx).toContain(H.FROM_D);

    service.close();
    yield* regA.client.close();
    yield* regB.client.close();
    yield* regC.client.close();
    yield* regD.client.close();
  }));

it("maxConversations limits output", () =>
  Effect.gen(function* () {
    const regA = yield* H.registerAgent("lim-a");
    const agentNames = ["lim-b", "lim-c", "lim-d", "lim-e"];
    const agents = yield* Effect.all(
      agentNames.map((n) => H.registerAgent(n)),
      { concurrency: agentNames.length },
    );
    for (const a of agents) yield* a.client.connect();

    const service = yield* H.connectService(regA.apiKey);

    const convs = [];
    for (const a of agents) {
      const conv = yield* service.sendRpc(H.ConversationsCreate, {
        type: "dm",
        participants: [{ type: "agent", id: a.agentId }],
      });
      convs.push(conv.conversation.id);
    }

    // Send messages in all 4 other conversations
    for (let i = 0; i < agents.length; i++) {
      yield* H.sendAndSettle(agents[i]!.client, convs[i]!, `Msg from ${i}`);
    }

    // Limit to 2 conversations
    const ctx = service.getContext(convs[0]!, {
      type: "cross-conversation",
      maxConversations: 2,
    })!;
    const lines = ctx.split("\n").filter((l) => l.startsWith("@"));
    expect(lines.length).toBe(2);

    service.close();
    yield* regA.client.close();
    for (const a of agents) yield* a.client.close();
  }));
