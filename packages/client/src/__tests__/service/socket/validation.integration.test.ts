import { expect } from "vitest";
import { live as it } from "@effect/vitest";
import { Effect, Either } from "effect";
import * as H from "../../support/index.js";

H.setupServiceIntegration();

function expectSocketFailure(
  result: Either.Either<unknown, Error>,
  messagePart: string,
): void {
  Either.match(result, {
    onLeft: (error) => expect(error.message).toContain(messagePart),
    onRight: () => expect.fail(),
  });
}

it("unknown socket method rejects with error", () =>
  Effect.gen(function* () {
    const reg = yield* H.registerAgent("sock-unknown");
    const service = yield* H.connectService(reg.apiKey, reg.agentId);
    yield* service.startSocketServer();
    try {
      const result = yield* Effect.either(
        H.socketRequest("nonexistent/method", { foo: "bar" }),
      );
      expectSocketFailure(result, "unknown or invalid RPC method");
    } finally {
      service.close();
      yield* reg.client.close();
    }
  }));

it("history rejects when required fields are missing or wrong type", () =>
  Effect.gen(function* () {
    const reg = yield* H.registerAgent("sock-validate");
    const service = yield* H.connectService(reg.apiKey, reg.agentId);
    yield* service.startSocketServer();
    const tryReq = (params: Record<string, unknown>) =>
      H.socketRequest(H.LocalServiceCommands.History, params);
    try {
      // Empty body: taskId AND conversationId both required.
      expectSocketFailure(yield* Effect.either(tryReq({})), "taskId");
      expectSocketFailure(
        yield* Effect.either(tryReq({ taskId: "t-1" })),
        "conversationId",
      );
      expectSocketFailure(
        yield* Effect.either(tryReq({ taskId: "t-1", conversationId: 123 })),
        "conversationId",
      );
      expectSocketFailure(
        yield* Effect.either(
          tryReq({
            taskId: "t-1",
            conversationId: "abc",
            limit: "not-a-number",
          }),
        ),
        "limit",
      );
    } finally {
      service.close();
      yield* reg.client.close();
    }
  }));
