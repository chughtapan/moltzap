import { Type, type Static } from "@sinclair/typebox";
import { Brand } from "effect";
import { brandedNumber, brandedString } from "../brands.js";

export const JSON_RPC_VERSION = "2.0" as const;

export const JsonRpcStringIdSchema = brandedString("JsonRpcStringId");
export const JsonRpcNumberIdSchema = brandedNumber("JsonRpcNumberId");
export const JsonRpcIdSchema = Type.Union([
  JsonRpcStringIdSchema,
  JsonRpcNumberIdSchema,
  Type.Null(),
]);

export const JsonRpcMethodSchema = brandedString("JsonRpcMethod", {
  minLength: 1,
});

export type JsonRpcStringId = Static<typeof JsonRpcStringIdSchema>;
export type JsonRpcNumberId = Static<typeof JsonRpcNumberIdSchema>;
export type JsonRpcId = Static<typeof JsonRpcIdSchema>;
export type JsonRpcMethod<Name extends string = string> = Name &
  Brand.Brand<"JsonRpcMethod">;

const JsonRpcStringIdBrand = Brand.nominal<JsonRpcStringId>();
const JsonRpcNumberIdBrand = Brand.nominal<JsonRpcNumberId>();
const JsonRpcMethodBrand = Brand.nominal<JsonRpcMethod>();

export const jsonRpcStringId = (id: string): JsonRpcStringId =>
  JsonRpcStringIdBrand(id);
export const jsonRpcNumberId = (id: number): JsonRpcNumberId =>
  JsonRpcNumberIdBrand(id);
export const jsonRpcMethod = <const Name extends string>(
  method: Name,
): JsonRpcMethod<Name> => JsonRpcMethodBrand(method) as JsonRpcMethod<Name>;

export function jsonRpcIdFromWire(value: unknown): JsonRpcId {
  if (typeof value === "string") return jsonRpcStringId(value);
  if (typeof value === "number" && Number.isFinite(value)) {
    return jsonRpcNumberId(value);
  }
  return null;
}

export function isJsonRpcStringId(id: JsonRpcId): id is JsonRpcStringId {
  return typeof id === "string";
}
