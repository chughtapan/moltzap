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
import type { Duration, Effect, Layer, Types } from "effect";
import type * as RouterPackage from "../../index.js";
import type * as RouterServerPackage from "../../server.js";

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
  Types.Equals<Parameters<typeof RouterPackage.Router.send>[0], SendCall>
>;
type SendSuccessIsExact = Expect<
  Types.Equals<
    Effect.Effect.Success<SendEffect>,
    RouterPackage.RouterSendResult
  >
>;
type SendFailureIsExact = Expect<
  Types.Equals<Effect.Effect.Error<SendEffect>, RouterFailure>
>;
type SendRequiresOnlyRouter = Expect<
  Types.Equals<Effect.Effect.Context<SendEffect>, RouterPackage.Router>
>;
type PollInputIsExact = Expect<
  Types.Equals<Parameters<typeof RouterPackage.Router.poll>[0], PollCall>
>;
type PollSuccessIsExact = Expect<
  Types.Equals<
    Effect.Effect.Success<PollEffect>,
    RouterPackage.RouterPollResult
  >
>;
type PollFailureIsExact = Expect<
  Types.Equals<Effect.Effect.Error<PollEffect>, RouterFailure>
>;
type PollRequiresOnlyRouter = Expect<
  Types.Equals<Effect.Effect.Context<PollEffect>, RouterPackage.Router>
>;
type LayerInputIsExact = Expect<
  Types.Equals<
    Parameters<typeof RouterPackage.Router.layer>[0],
    Readonly<{
      origin: URL;
      sendTimeout: Duration.Duration;
      pollTimeout: Duration.Duration;
    }>
  >
>;
type LayerProvidesOnlyRouter = Expect<
  Types.Equals<Layer.Layer.Success<RouterLayer>, RouterPackage.Router>
>;
type LayerCannotFail = Expect<
  Types.Equals<Layer.Layer.Error<RouterLayer>, never>
>;
type LayerRequiresOnlyHttpClient = Expect<
  Types.Equals<Layer.Layer.Context<RouterLayer>, HttpClient.HttpClient>
>;
type ServerLayerProvidesNothing = Expect<
  Types.Equals<Layer.Layer.Success<RouterServerLayer>, never>
>;
type ServerLayerFailsOnlyAtStartup = Expect<
  Types.Equals<
    Layer.Layer.Error<RouterServerLayer>,
    RouterServerPackage.RouterServer.StartupError
  >
>;
type ServerLayerIsSelfContained = Expect<
  Types.Equals<Layer.Layer.Context<RouterServerLayer>, never>
>;
type RootExportsAreExact = Expect<
  Types.Equals<
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
  Types.Equals<keyof typeof RouterServerPackage, "RouterServer">
>;
type ServerNamespaceIsExact = Expect<
  Types.Equals<
    keyof typeof RouterServerPackage.RouterServer,
    "StartupError" | "layer"
  >
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
