/**
 * @file
 * Router's exported capability keeps send and poll on their exact request,
 * success, failure, and requirement channels. This prevents a later adapter
 * change from widening either operation to unknown or leaking private server
 * construction through the public layer.
 */

import type { HttpClient } from "@effect/platform";
import type {
  AgentId,
  AgentSigningAuthority,
  AgentSigningError,
  AuthenticationFailedError,
  InternalServerError,
  MalformedRequestError,
  MethodNotAllowedError,
  OverloadedError,
  PayloadTooLargeError,
  RouteNotFoundError,
  UnavailableError,
  UnsupportedMediaTypeError,
  VersionMismatchError,
} from "@moltzap/identity";
import type { Duration, Effect, Layer } from "effect";
import type * as RouterPackage from "../../index.js";
import type * as RouterServerPackage from "../../server.js";

type Equal<Left, Right> = [Left, Right] extends [Right, Left] ? true : false;
type Expect<Value extends true> = Value;

type RouterFailure =
  | MalformedRequestError
  | AuthenticationFailedError
  | RouteNotFoundError
  | MethodNotAllowedError
  | VersionMismatchError
  | PayloadTooLargeError
  | UnsupportedMediaTypeError
  | OverloadedError
  | UnavailableError
  | InternalServerError
  | RouterPackage.RouterConnectionError
  | RouterPackage.RouterRequestTimeoutError
  | RouterPackage.RouterInvalidResponseError
  | AgentSigningError;

type SendCall = Readonly<{
  request: RouterPackage.RouterSendRequest;
  callerAgentId: AgentId;
  signingAuthority: AgentSigningAuthority;
}>;
type PollCall = Readonly<{
  request: RouterPackage.RouterPollRequest;
  callerAgentId: AgentId;
  signingAuthority: AgentSigningAuthority;
}>;

type SendEffect = ReturnType<typeof RouterPackage.Router.send>;
type PollEffect = ReturnType<typeof RouterPackage.Router.poll>;
type RouterLayer = ReturnType<typeof RouterPackage.Router.layer>;
type RouterServerLayer = typeof RouterServerPackage.RouterServer.layer;

type SendInputIsExact = Expect<
  Equal<Parameters<typeof RouterPackage.Router.send>[0], SendCall>
>;
type SendSuccessIsExact = Expect<
  Equal<Effect.Effect.Success<SendEffect>, RouterPackage.RouterSendResult>
>;
type SendFailureIsExact = Expect<
  Equal<Effect.Effect.Error<SendEffect>, RouterFailure>
>;
type SendRequiresOnlyRouter = Expect<
  Equal<Effect.Effect.Context<SendEffect>, RouterPackage.Router>
>;
type PollInputIsExact = Expect<
  Equal<Parameters<typeof RouterPackage.Router.poll>[0], PollCall>
>;
type PollSuccessIsExact = Expect<
  Equal<Effect.Effect.Success<PollEffect>, RouterPackage.RouterPollResult>
>;
type PollFailureIsExact = Expect<
  Equal<Effect.Effect.Error<PollEffect>, RouterFailure>
>;
type PollRequiresOnlyRouter = Expect<
  Equal<Effect.Effect.Context<PollEffect>, RouterPackage.Router>
>;
type LayerInputIsExact = Expect<
  Equal<
    Parameters<typeof RouterPackage.Router.layer>[0],
    Readonly<{
      origin: URL;
      sendTimeout: Duration.Duration;
      pollTimeout: Duration.Duration;
    }>
  >
>;
type LayerProvidesOnlyRouter = Expect<
  Equal<Layer.Layer.Success<RouterLayer>, RouterPackage.Router>
>;
type LayerCannotFail = Expect<Equal<Layer.Layer.Error<RouterLayer>, never>>;
type LayerRequiresOnlyHttpClient = Expect<
  Equal<Layer.Layer.Context<RouterLayer>, HttpClient.HttpClient>
>;
type ServerLayerProvidesNothing = Expect<
  Equal<Layer.Layer.Success<RouterServerLayer>, never>
>;
type ServerLayerFailsOnlyAtStartup = Expect<
  Equal<
    Layer.Layer.Error<RouterServerLayer>,
    RouterServerPackage.RouterServer.StartupError
  >
>;
type ServerLayerIsSelfContained = Expect<
  Equal<Layer.Layer.Context<RouterServerLayer>, never>
>;
type RootExportsAreExact = Expect<
  Equal<
    keyof typeof RouterPackage,
    | "PollCursor"
    | "Router"
    | "RouterConnectionError"
    | "RouterInstanceId"
    | "RouterInvalidResponseError"
    | "RouterPollRequest"
    | "RouterPollResult"
    | "RouterRequestTimeoutError"
    | "RouterSendRequest"
    | "RouterSendResult"
    | "SignedMessageDigest"
  >
>;
type ServerExportsAreExact = Expect<
  Equal<keyof typeof RouterServerPackage, "RouterServer">
>;
type ServerNamespaceIsExact = Expect<
  Equal<keyof typeof RouterServerPackage.RouterServer, "StartupError" | "layer">
>;

/** Compile-time evidence for the complete public Router capability channels. */
export type RouterCapabilityCanaries = [
  SendInputIsExact,
  SendSuccessIsExact,
  SendFailureIsExact,
  SendRequiresOnlyRouter,
  PollInputIsExact,
  PollSuccessIsExact,
  PollFailureIsExact,
  PollRequiresOnlyRouter,
  LayerInputIsExact,
  LayerProvidesOnlyRouter,
  LayerCannotFail,
  LayerRequiresOnlyHttpClient,
  ServerLayerProvidesNothing,
  ServerLayerFailsOnlyAtStartup,
  ServerLayerIsSelfContained,
  RootExportsAreExact,
  ServerExportsAreExact,
  ServerNamespaceIsExact,
];
