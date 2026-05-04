import { type Static, type TSchema } from "@sinclair/typebox";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import type { JsonRpcMethod } from "./schema/json-rpc.js";

const ajv = addFormats(new Ajv({ strict: true, allErrors: true }));

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
  const validateParams = ajv.compile<Static<P>>(def.params);
  return {
    name: def.name,
    paramsSchema: def.params,
    validateParams: (data: unknown): data is Static<P> => validateParams(data),
    Params: null!,
  };
}

export type NotificationParamsOf<D> =
  D extends NotificationDefinition<string, infer P> ? Static<P> : never;
