import { Rpc, RpcGroup } from "@effect/rpc";
import { Effect, Schema } from "effect";

const LocalDaemonParams = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown,
});

export type LocalDaemonParams = Schema.Schema.Type<typeof LocalDaemonParams>;

export class LocalDaemonRpcs extends RpcGroup.make(
  Rpc.make("LocalDaemonCall", {
    payload: {
      method: Schema.String,
      params: LocalDaemonParams,
    },
    success: Schema.Unknown,
    error: Schema.String,
  }),
) {}

export const normalizeLocalDaemonParams = (
  params: unknown,
): Effect.Effect<LocalDaemonParams, never> =>
  Schema.decodeUnknown(LocalDaemonParams)(params).pipe(
    Effect.orElseSucceed(() => ({})),
  );
