import { CliConfig, Options, ValidationError } from "@effect/cli";
import { NodeContext } from "@effect/platform-node";
import { it as effectIt } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { describe, expect, expectTypeOf } from "vitest";
import { taskId as taskIdSchema } from "@moltzap/protocol/task";
import { messagesListOptions } from "./commands/messages.js";
import { sendOptions } from "./commands/send.js";
import { startOptions } from "./commands/start.js";
import { optionsFromSchema } from "./adapters.js";

const it = effectIt.effect;

const pageLimit = Schema.Number.pipe(Schema.int(), Schema.between(1, 200));
const INTEGER_USAGE_PLACEHOLDER = '"integer"';
const TASK_ID = "00000000-0000-4000-8000-00000000001a";
const CONVERSATION_ID = "00000000-0000-4000-8000-00000000000c";
const REPLY_TO_ID = "00000000-0000-4000-8000-0000000000a1";
const APP_ID = "11111111-2222-4333-8444-555555555555";

const parseOptions = <A>(
  options: Options.Options<A>,
  argv: readonly string[],
) =>
  Options.processCommandLine(options, argv, CliConfig.defaultConfig).pipe(
    Effect.flatMap(([error, rest, value]) =>
      Option.match(error, {
        onNone: () => Effect.succeed({ rest, value }),
        onSome: Effect.fail,
      }),
    ),
    Effect.provide(NodeContext.layer),
  );

describe("schema option presentation", () => {
  it("derives renamed and kebab-cased scalar options", () =>
    Effect.gen(function* () {
      const params = Schema.Struct({
        taskId: taskIdSchema,
        sessionKey: Schema.optional(Schema.String),
        limit: Schema.optional(pageLimit),
      });
      const options = optionsFromSchema(params, {
        taskId: { name: "task", description: "Task id" },
      });
      expectTypeOf(options).toEqualTypeOf<
        Options.Options<Schema.Schema.Type<typeof params>>
      >();
      expect(JSON.stringify(Options.getUsage(options))).toContain(
        INTEGER_USAGE_PLACEHOLDER,
      );

      const taskId = "00000000-0000-4000-8000-000000000001";
      const parsed = yield* parseOptions(options, [
        "--task",
        taskId,
        "--session-key",
        "demo",
        "--limit",
        "25",
      ]);
      expect(parsed).toEqual({
        rest: [],
        value: { taskId, sessionKey: "demo", limit: 25 },
      });
    }));
});

describe("schema option validation", () => {
  it("omits absent fields and retains whole-schema validation", () =>
    Effect.gen(function* () {
      const paramsValue = Schema.Struct({
        taskId: taskIdSchema,
        limit: Schema.optional(pageLimit),
      });
      const options = optionsFromSchema(paramsValue, {
        taskId: { name: "task" },
      });
      const taskId = "00000000-0000-4000-8000-000000000002";

      const parsed = yield* parseOptions(options, ["--task", taskId]);
      expect(parsed.value).toEqual({ taskId });
      expect(parsed.value).not.toHaveProperty("limit");

      const invalidId = yield* Effect.flip(
        parseOptions(options, ["--task", "not-a-task-id"]),
      );
      expect(ValidationError.isInvalidValue(invalidId)).toBe(true);

      const invalidLimit = yield* Effect.flip(
        parseOptions(options, ["--task", taskId, "--limit", "201"]),
      );
      expect(ValidationError.isInvalidValue(invalidLimit)).toBe(true);
    }));
});

describe("schema option decoding", () => {
  it("applies schema transformations and defaults", () =>
    Effect.gen(function* () {
      const paramsSchema = Schema.Struct({
        count: Schema.NumberFromString.pipe(Schema.int()),
        limit: Schema.optionalWith(pageLimit, { default: () => 10 }),
      });
      const options = optionsFromSchema(paramsSchema);

      const defaulted = yield* parseOptions(options, ["--count", "3"]);
      expect(defaulted.value).toEqual({ count: 3, limit: 10 });

      const explicit = yield* parseOptions(options, [
        "--count",
        "3",
        "--limit",
        "20",
      ]);
      expect(explicit.value).toEqual({ count: 3, limit: 20 });
    }));
});

describe("unsupported schema options", () => {
  it("fails fast outside the bounded scalar contract", () =>
    Effect.sync(() => {
      const nested = () =>
        optionsFromSchema(
          Schema.Struct({ nested: Schema.Struct({ value: Schema.String }) }),
        );
      const boolean = () =>
        optionsFromSchema(
          Schema.Struct({ enabled: Schema.optional(Schema.Boolean) }),
        );
      const array = () =>
        optionsFromSchema(
          Schema.Struct({ names: Schema.Array(Schema.String) }),
        );
      const empty = () => optionsFromSchema(Schema.Struct({}));
      const open = () =>
        optionsFromSchema(
          Schema.Record({ key: Schema.String, value: Schema.String }),
        );
      const renamed = () =>
        optionsFromSchema(
          Schema.Struct({ taskId: Schema.String }).pipe(
            Schema.rename({ taskId: "task" }),
          ),
        );
      const collision = () =>
        optionsFromSchema(
          Schema.Struct({ firstName: Schema.String, lastName: Schema.String }),
          { firstName: { name: "name" }, lastName: { name: "name" } },
        );

      expect(nested).toThrow(/only encoded string and number scalar fields/);
      expect(boolean).toThrow(/only encoded string and number scalar fields/);
      expect(array).toThrow(/only encoded string and number scalar fields/);
      expect(empty).toThrow(/empty Structs/);
      expect(open).toThrow(/must be a closed Struct/);
      expect(renamed).toThrow(
        /encoded and type-side property names must match/,
      );
      expect(collision).toThrow(/already in use/);
    }));
});

describe("live command option adapters", () => {
  it("maps messages list public flags to the daemon payload", () =>
    Effect.gen(function* () {
      const parsed = yield* parseOptions(messagesListOptions, [
        "--task",
        TASK_ID,
        "--conversation",
        CONVERSATION_ID,
      ]);

      expect(parsed).toEqual({
        rest: [],
        value: {
          taskId: TASK_ID,
          conversationId: CONVERSATION_ID,
        },
      });
      expect(parsed.value).not.toHaveProperty("limit");
    }));

  it("maps send public flags to the daemon payload", () =>
    Effect.gen(function* () {
      const omitted = yield* parseOptions(sendOptions, []);
      expect(omitted).toEqual({ rest: [], value: {} });

      const explicit = yield* parseOptions(sendOptions, [
        "--reply-to",
        REPLY_TO_ID,
      ]);
      expect(explicit).toEqual({
        rest: [],
        value: { replyToId: REPLY_TO_ID },
      });
    }));

  it("maps start public flags to the daemon payload", () =>
    Effect.gen(function* () {
      const omitted = yield* parseOptions(startOptions, []);
      expect(omitted).toEqual({ rest: [], value: {} });

      const explicit = yield* parseOptions(startOptions, [
        "--message",
        "hello",
        "--app-id",
        APP_ID,
      ]);
      expect(explicit).toEqual({
        rest: [],
        value: { message: "hello", appId: APP_ID },
      });
    }));
});
