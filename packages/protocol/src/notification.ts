import { type Static, type TSchema } from "@sinclair/typebox";
import { ajv } from "./internal/ajv.js";
import type { JsonRpcMethod } from "./schema/json-rpc.js";

export interface NotificationDefinition<
  Name extends string,
  P extends TSchema,
> {
  readonly name: JsonRpcMethod<Name>;
  readonly paramsSchema: P;
  readonly validateParams: (data: unknown) => data is Static<P>;
  readonly Params: Static<P>;
}

export function defineNotification<
  Name extends string,
  P extends TSchema,
>(def: {
  readonly name: JsonRpcMethod<Name>;
  readonly params: P;
}): NotificationDefinition<Name, P> {
  return {
    name: def.name,
    paramsSchema: def.params,
    validateParams: ajv.compile(def.params),
    Params: null!,
  };
}

export type NotificationParamsOf<D> =
  D extends NotificationDefinition<string, infer P> ? Static<P> : never;
