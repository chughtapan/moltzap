import { type TSchema, type Static } from "@sinclair/typebox";
import Ajv from "ajv";
import addFormats from "ajv-formats";

/**
 * Re-export TypeBox type helpers so downstream packages (client, server)
 * can type against manifests without taking a direct typebox dependency.
 */
export type { TSchema, Static } from "@sinclair/typebox";

/**
 * Shared AJV instance across every `defineRpc` call. Pre-compiles each
 * `params` schema once at module load so validation is a single function
 * call per inbound RPC — no per-call compilation cost on the hot path.
 */
const ajv = addFormats(new Ajv({ strict: true, allErrors: true }));

/**
 * A typed manifest for one RPC method. Couples:
 *   - `name` — the wire-level method string (e.g. `"agents/lookupByName"`)
 *   - `paramsSchema` / `resultSchema` — TypeBox schemas (runtime values)
 *   - `validateParams` — pre-compiled AJV validator for `params`
 *   - `Params` / `Result` — phantom type carriers so call sites can write
 *     `Static<D["paramsSchema"]>` without paying a generic-inference cost
 *
 * The `Name` type parameter is preserved as a literal string so
 * `rpcMethods[number]["name"]` produces a union of every wire method.
 */
export interface RpcDefinition<
  Name extends string,
  P extends TSchema,
  R extends TSchema,
> {
  readonly name: Name;
  readonly paramsSchema: P;
  readonly resultSchema: R;
  readonly validateParams: (data: unknown) => boolean;
  /** Phantom carrier — inspect with `typeof def.Params` to get `Static<P>`. */
  readonly Params: Static<P>;
  /** Phantom carrier — inspect with `typeof def.Result` to get `Static<R>`. */
  readonly Result: Static<R>;
}

/**
 * Build an `RpcDefinition` from a TypeBox params + result schema. Compiles
 * the params validator at call time. Result schema is carried along but
 * not currently validated on the wire (clients trust server output).
 */
export function defineRpc<
  Name extends string,
  P extends TSchema,
  R extends TSchema,
>(def: { name: Name; params: P; result: R }): RpcDefinition<Name, P, R> {
  return {
    name: def.name,
    paramsSchema: def.params,
    resultSchema: def.result,
    validateParams: ajv.compile(def.params),
    // Phantom — never read at runtime. Typed as `Static<P>` so
    // `typeof def.Params` at the type level yields the params type.
    // #ignore-sloppy-code-next-line[as-unknown-as]: TS phantom-type witness; runtime is null, type carrier only
    Params: null as unknown as Static<P>,
    // #ignore-sloppy-code-next-line[as-unknown-as]: TS phantom-type witness; runtime is null, type carrier only
    Result: null as unknown as Static<R>,
  };
}

/** Extract the params type from an RpcDefinition. */
export type ParamsOf<D> =
  D extends RpcDefinition<string, infer P, TSchema> ? Static<P> : never;

/** Extract the result type from an RpcDefinition. */
export type ResultOf<D> =
  D extends RpcDefinition<string, TSchema, infer R> ? Static<R> : never;
