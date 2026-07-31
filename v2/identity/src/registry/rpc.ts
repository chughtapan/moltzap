import { RpcClient, RpcServer } from "@effect/rpc";
import { Deferred, Effect, Schema } from "effect";
import type { AgentSigningAuthority } from "../agent-signing-authority.js";
import { InternalServerError } from "../http-errors.js";
import { encodeCanonicalJson } from "../identity-json.js";
import {
  registryOperations,
  type listOperation,
  type lookupOperation,
  type registerOperation,
  RegistryRegisterRequest,
} from "./operations.js";
import type { RegistryStorage } from "./storage.js";

/** Private in-process client for the Registry operation group. */
export type RegistryRpcClient = RpcClient.FromGroup<typeof registryOperations>;

type NoSerializationClient = Effect.Effect.Success<
  ReturnType<
    typeof RpcClient.makeNoSerialization<
      typeof registerOperation | typeof lookupOperation | typeof listOperation,
      never
    >
  >
>;

/** Connects the private Registry RPC client and server in memory. */
export const makeRegistryRpcClient = Effect.gen(function* () {
  const clientReady = yield* Deferred.make<NoSerializationClient>();
  const server = yield* RpcServer.makeNoSerialization(registryOperations, {
    onFromServer: (message) =>
      Deferred.await(clientReady).pipe(
        Effect.flatMap((client) => client.write(message)),
      ),
  });
  const client = yield* RpcClient.makeNoSerialization(registryOperations, {
    supportsAck: true,
    onFromClient: ({ message }) => server.write(0, message),
  });
  yield* Deferred.succeed(clientReady, client);
  return client.client;
}).pipe(Effect.withSpan("makeRegistryRpcClient"));

const canonicalRegisterRequest = (
  request: typeof RegistryRegisterRequest.Type,
) =>
  Schema.encode(RegistryRegisterRequest)(request).pipe(
    Effect.flatMap(encodeCanonicalJson),
    // eslint-disable-next-line agent-code-guard/no-effect-error-coalescing -- Private serialization failure has one closed domain error at the RPC boundary.
    Effect.mapError(() => new InternalServerError()),
  );

const registerHandler =
  (input: {
    readonly storage: RegistryStorage;
    readonly registrySigningAuthority: AgentSigningAuthority;
  }) =>
  (request: typeof RegistryRegisterRequest.Type) =>
    canonicalRegisterRequest(request).pipe(
      Effect.flatMap((requestBytes) =>
        input.storage.register({
          request,
          requestBytes,
          registrySigningAuthority: input.registrySigningAuthority,
        }),
      ),
    );

/**
 * Implements the three private operations over durable Registry storage.
 *
 * @param input Private RPC handler dependencies.
 * @param input.storage Durable Registry operations.
 * @param input.registrySigningAuthority Registry card issuer.
 * @returns A layer implementing the complete private operation group.
 */
export const makeRegistryRpcHandlersLayer = (input: {
  readonly storage: RegistryStorage;
  readonly registrySigningAuthority: AgentSigningAuthority;
}) =>
  registryOperations.toLayer({
    register: registerHandler(input),
    lookup: (request) => input.storage.lookup(request),
    list: (request) => input.storage.list(request),
  });
