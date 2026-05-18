import { Effect, ParseResult, Schema } from "effect";
import {
  decodeHistoryResponse,
  type HistoryRequestInput,
  type HistoryResponse,
} from "./local-history.js";

export const LocalServiceCommands = {
  Ping: "ping",
  Status: "status",
  History: "history",
} as const;

export type LocalServiceCommand =
  (typeof LocalServiceCommands)[keyof typeof LocalServiceCommands];

interface LocalServicePingResult {
  readonly ok: boolean;
  readonly agentId?: string | undefined;
}

interface LocalServiceStatusResult {
  readonly agentId?: string | undefined;
  readonly connected: boolean;
  readonly conversations: number;
}

export interface LocalServiceResults {
  readonly [LocalServiceCommands.Ping]: LocalServicePingResult;
  readonly [LocalServiceCommands.Status]: LocalServiceStatusResult;
  readonly [LocalServiceCommands.History]: HistoryResponse;
}

export type LocalServiceParams<C extends LocalServiceCommand> =
  C extends typeof LocalServiceCommands.History
    ? HistoryRequestInput
    : undefined;

const LocalServicePingResultSchema = Schema.Struct({
  ok: Schema.Boolean,
  agentId: Schema.optional(Schema.String),
});

const LocalServiceStatusResultSchema = Schema.Struct({
  agentId: Schema.optional(Schema.String),
  connected: Schema.Boolean,
  conversations: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
});

const decodePingResult = Schema.decodeUnknown(LocalServicePingResultSchema);
const decodeStatusResult = Schema.decodeUnknown(LocalServiceStatusResultSchema);

export function decodeLocalServiceResult<C extends LocalServiceCommand>(
  command: C,
  result: unknown,
): Effect.Effect<LocalServiceResults[C], ParseResult.ParseError> {
  switch (command) {
    case LocalServiceCommands.Ping:
      return decodePingResult(result) as Effect.Effect<
        LocalServiceResults[C],
        ParseResult.ParseError
      >;
    case LocalServiceCommands.Status:
      return decodeStatusResult(result) as Effect.Effect<
        LocalServiceResults[C],
        ParseResult.ParseError
      >;
    case LocalServiceCommands.History:
      return decodeHistoryResponse(result) as Effect.Effect<
        LocalServiceResults[C],
        ParseResult.ParseError
      >;
  }
}
